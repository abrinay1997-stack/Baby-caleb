import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmar, ejecutar } from "../ejecutar";
import type { PeticionDeHerramienta } from "../ejecutar";
import { catalogo } from "../index";
import type { Contexto } from "../registro";
import {
  crearProductoDelCatalogo,
  crearVarianteDelCatalogo,
  darDeAltaProducto,
  editarVarianteDelCatalogo,
  retirarVariante,
  verRetiroDeVariante,
} from "./catalogo-escritura";

/**
 * Administrar el catálogo por MCP.
 *
 * Dos cosas se vigilan aquí, y la segunda es la que no se ve:
 *
 *  1. Que cada herramienta haga en la base lo mismo que hace la ruta del panel
 *     —porque llama a la misma función de `src/db/`— y que lo que devuelve no
 *     se pueda entender mal.
 *  2. **Que estén enchufadas.** `docs/TRAMPAS.md` §12 mordió tres veces con
 *     piezas terminadas que nadie llamaba, y sus pruebas pasaban con razón:
 *     comprobaban que la pieza funciona, no que algo la llame. Por eso casi
 *     todo lo de aquí entra por `ejecutar()`, que es por donde entran el panel,
 *     Telegram y MCP, y no llamando `herramienta.ejecutar()` a mano.
 *
 * Y de paso se comprueba lo que NO se puede hacer por aquí: cambiar el precio
 * (eso es de `cambiar_precio`) y publicar sin que una persona lo permita.
 */

const ahora = () => Date.now();
let n = 0;

const registro = catalogo();

const duena: Contexto["usuario"] = { id: "u-cat-duena", correo: "duena@babycaleb.com", rol: "duena" };
const asistente: Contexto["usuario"] = { id: "u-cat-asis", correo: "asis@babycaleb.com", rol: "asistente" };

const quien = (usuario = duena) => ({ db: env.DB, usuario, ahora: ahora() });

const ctx = (usuario = duena): Contexto => ({
  db: env.DB,
  usuario,
  canal: "mcp",
  conversacionId: null,
  ahora: ahora(),
});

const pedir = (nombre: string, argumentos: unknown): PeticionDeHerramienta => ({
  nombre,
  argumentos,
  canal: "mcp",
  conversacionId: null,
  conAdjuntos: false,
  textoExterno: false,
});

/**
 * Un código corto a propósito.
 *
 * `revisarCodigo` admite 24 letras como máximo, así que un código con la fecha
 * entera en milisegundos dentro —como hacen otras siembras de este repo— lo
 * rechazaría y la prueba fallaría por el molde, no por lo que prueba.
 */
const codigoNuevo = () => `ZE${n}X${Date.now() % 100_000}`;

/** Un nombre que no choca con nada de la carga inicial. */
const nombreNuevo = (que: string) => `${que} ${Date.now()}-${n}`;

beforeEach(async () => {
  n += 1;
  // Los usuarios no se borran entre pruebas: `acciones.usuario_id` los
  // referencia y la bitácora tiene un trigger que prohíbe borrarla.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-cat-duena','duena@babycaleb.com','Yarielis','duena',1,?)",
    ).bind(ahora()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u-cat-asis','asis@babycaleb.com','Asistente','asistente',1,?)",
    ).bind(ahora()),
  ]);
});

const laVariante = (codigo: string) =>
  env.DB.prepare(
    "SELECT codigo, producto_id, nombre, talla, unidades_por_caja, precio_cents, tasa_itbms_bp, publicado, activo, version FROM variantes WHERE codigo = ?",
  )
    .bind(codigo)
    .first<{
      codigo: string;
      producto_id: string;
      nombre: string;
      talla: string | null;
      unidades_por_caja: number;
      precio_cents: number;
      tasa_itbms_bp: number | null;
      publicado: number;
      activo: number;
      version: number;
    }>();

/** Un producto suelto, por su nombre, para colgarle presentaciones. */
async function unProducto(nombre = nombreNuevo("Producto")): Promise<string> {
  const r = await ejecutar(
    quien(),
    registro,
    pedir("crear_producto", { familia: "panal", nombre, motivo: "siembra de la prueba" }),
  );
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return nombre;
}

/** Una presentación recién creada, sin nada que le haya pasado. */
async function unaVariante(
  sobre: { producto?: string; talla?: string; precioCents?: number } = {},
): Promise<string> {
  const producto = sobre.producto ?? (await unProducto());
  const codigo = codigoNuevo();
  const r = await ejecutar(
    quien(),
    registro,
    pedir("crear_variante", {
      producto,
      codigo,
      nombre: nombreNuevo("Presentación"),
      ...(sobre.talla === undefined ? {} : { talla: sobre.talla }),
      unidades_por_caja: 12,
      precio_cents: sobre.precioCents ?? 2500,
      motivo: "siembra de la prueba",
    }),
  );
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return codigo;
}

/** Permite una acción que quedó esperando, como quien toca «Permitir». */
async function permitir(accionId: string) {
  return confirmar(quien(), registro, accionId, "permitir");
}

// ---------------------------------------------------------------------------
// Que estén enchufadas (TRAMPAS §12)
// ---------------------------------------------------------------------------

describe("las seis herramientas existen y se alcanzan desde fuera", () => {
  const NOMBRES = [
    "crear_producto",
    "crear_variante",
    "dar_de_alta_producto",
    "editar_variante",
    "ver_retiro_variante",
    "retirar_variante",
  ];

  it("están registradas en el catálogo del asistente", () => {
    // Si no están aquí, no existen para ninguna de las tres puertas: el panel,
    // Telegram y MCP leen todas de `catalogo()`.
    const hay = registro.todas().map((h) => h.nombre);
    for (const nombre of NOMBRES) expect(hay, `falta ${nombre}`).toContain(nombre);
  });

  it("y se le enseñan a la dueña por MCP, con su esquema cerrado", () => {
    const definiciones = registro.definicionesPara("duena");
    for (const nombre of NOMBRES) {
      const d = definiciones.find((x) => x.name === nombre);
      expect(d, `${nombre} no se le enseña a la dueña`).toBeDefined();
      expect(d?.input_schema["additionalProperties"]).toBe(false);
    }
  });

  it("y a la asistente no se le enseña ninguna", () => {
    // El catálogo es de `precios_y_stock`, y la asistente ahí está en «no»
    // (07-seguridad §1). Una herramienta que no se enseña es una que no se
    // puede pedir por equivocación.
    const hay = registro.definicionesPara("asistente").map((d) => d.name);
    for (const nombre of NOMBRES) expect(hay, nombre).not.toContain(nombre);
  });

  it("y a la asistente se le niegan aunque las pida", async () => {
    const r = await ejecutar(
      quien(asistente),
      registro,
      pedir("retirar_variante", { codigo: "NAT-M", motivo: "probando" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_autorizado");
  });
});

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

describe("crear_producto", () => {
  it("crea el producto y dice que todavía no se ve", async () => {
    const nombre = nombreNuevo("Pañal de prueba");
    const r = await ejecutar(
      quien(),
      registro,
      pedir("crear_producto", { familia: "panal", nombre, marca: "Nateen", motivo: "nuevo proveedor" }),
    );

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    // Construcción: va directo, no queda esperando a que nadie lo permita.
    expect(r.datos.clase).toBe("hecha");

    const fila = await env.DB.prepare(
      "SELECT id, familia, nombre, slug, marca, activo FROM productos WHERE nombre = ?",
    )
      .bind(nombre)
      .first<{ id: string; familia: string; slug: string; marca: string | null; activo: number }>();
    expect(fila?.familia).toBe("panal");
    expect(fila?.marca).toBe("Nateen");
    // El slug sale del nombre cuando no se manda, igual que por el panel.
    expect(fila?.slug).toMatch(/^panal-de-prueba-/);

    const datos = (r.datos as { datos: { siguientePaso: string } }).datos;
    expect(datos.siguientePaso).toContain("crear_variante");
  });

  it("queda en la bitácora, con su motivo", async () => {
    // El motivo de una herramienta de catálogo no tiene columna propia en
    // `productos`: donde queda es aquí, y aquí no se edita ni se borra.
    const nombre = nombreNuevo("Con motivo");
    await ejecutar(
      quien(),
      registro,
      pedir("crear_producto", { familia: "otro", nombre, motivo: "lo pidió la dueña el lunes" }),
    );

    const a = await env.DB.prepare(
      "SELECT estado, argumentos_json FROM acciones WHERE herramienta = 'crear_producto' ORDER BY creado_en DESC, id DESC LIMIT 1",
    ).first<{ estado: string; argumentos_json: string }>();
    expect(a?.estado).toBe("hecha");
    expect(a?.argumentos_json).toContain("lo pidió la dueña el lunes");
  });

  it("un nombre repetido se rechaza por la dirección web, no se duplica", async () => {
    const nombre = nombreNuevo("Repetido");
    await ejecutar(quien(), registro, pedir("crear_producto", { familia: "otro", nombre, motivo: "uno" }));
    const otra = await ejecutar(
      quien(),
      registro,
      pedir("crear_producto", { familia: "otro", nombre, motivo: "dos" }),
    );
    expect(otra.ok).toBe(false);
  });
});

describe("crear_variante", () => {
  it("nace SIN PUBLICAR, con su precio y su fila de historial", async () => {
    const producto = await unProducto();
    const codigo = codigoNuevo();

    const r = await ejecutar(
      quien(),
      registro,
      pedir("crear_variante", {
        producto,
        codigo,
        nombre: "Presentación M",
        talla: "M",
        unidades_por_caja: 36,
        precio_cents: 5500,
        tasa_itbms_bp: 700,
        motivo: "entra la talla M",
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const v = await laVariante(codigo);
    // Lo que hace que crear no sea sensible: publicada, el precio recién
    // tecleado saldría a la web y al bot en el siguiente minuto.
    expect(v?.publicado, "una variante nueva no puede nacer publicada").toBe(0);
    expect(v?.activo).toBe(1);
    expect(v?.precio_cents).toBe(5500);
    expect(v?.talla).toBe("M");
    expect(v?.unidades_por_caja).toBe(36);
    expect(v?.tasa_itbms_bp).toBe(700);

    // El precio de partida entra en el historial como cualquier otro: es la
    // cifra que más se consulta cuando algo no cuadra.
    const h = await env.DB.prepare(
      "SELECT precio_cents, cambiado_por, motivo FROM precios_historial WHERE codigo = ?",
    )
      .bind(codigo)
      .first<{ precio_cents: number; cambiado_por: string; motivo: string | null }>();
    expect(h?.precio_cents).toBe(5500);
    // El `actor` va con el correo, como lo manda la ruta del panel: si una
    // puerta escribiera un ULID aquí, el historial dejaría de leerse.
    expect(h?.cambiado_por).toBe("duena@babycaleb.com");
  });

  it("NO crea existencias: crear no mueve inventario", async () => {
    // Es el argumento por el que estas tres son construcción y no sensible. Si
    // un día crearan una fila de existencias, esto se pone rojo y hay que
    // volver a mirar el nivel.
    const codigo = await unaVariante();
    const { results } = await env.DB.prepare("SELECT codigo FROM existencias WHERE codigo = ?")
      .bind(codigo)
      .all();
    expect(results).toEqual([]);

    const mov = await env.DB.prepare(
      "SELECT COUNT(*) AS cuantos FROM movimientos_inventario WHERE codigo = ?",
    )
      .bind(codigo)
      .first<{ cuantos: number }>();
    expect(mov?.cuantos).toBe(0);
  });

  it("acepta el código en minúsculas y lo guarda en mayúsculas", async () => {
    const producto = await unProducto();
    const codigo = codigoNuevo();
    const r = await ejecutar(
      quien(),
      registro,
      pedir("crear_variante", {
        producto,
        codigo: codigo.toLowerCase(),
        nombre: "Presentación L",
        unidades_por_caja: 12,
        precio_cents: 1300,
        motivo: "prueba de mayúsculas",
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await laVariante(codigo)).not.toBeNull();
  });

  it("sin ITBMS la tasa queda en PENDIENTE, no en cero", async () => {
    // Un cero ahí afirma que el artículo no lleva impuesto (TRAMPAS §7).
    const codigo = await unaVariante();
    expect((await laVariante(codigo))?.tasa_itbms_bp).toBeNull();
  });

  it("de un producto que no existe dice qué hacer, y no escribe nada", async () => {
    const codigo = codigoNuevo();
    const r = await ejecutar(
      quien(),
      registro,
      pedir("crear_variante", {
        producto: "Producto que no existe en ninguna parte",
        codigo,
        nombre: "Presentación huérfana",
        unidades_por_caja: 12,
        precio_cents: 1300,
        motivo: "prueba",
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensaje).toContain("crear_producto");
    expect(await laVariante(codigo), "no se escribió una variante huérfana").toBeNull();
  });

  it("con DOS productos del mismo nombre se para en vez de elegir uno", async () => {
    // `productos.nombre` no es único en la base: lo único único es el slug. Si
    // esta herramienta tomara el primero, la talla se le colgaría al producto
    // equivocado y nadie lo notaría hasta que la web enseñara la ficha mal.
    const nombre = nombreNuevo("Gemelo");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO productos (id,familia,nombre,slug,activo,orden,creado_en) VALUES (?,?,?,?,1,0,?)",
      ).bind(`p-gem-a-${n}-${Date.now()}`, "otro", nombre, `slug-a-${n}-${Date.now()}`, ahora()),
      env.DB.prepare(
        "INSERT INTO productos (id,familia,nombre,slug,activo,orden,creado_en) VALUES (?,?,?,?,1,0,?)",
      ).bind(`p-gem-b-${n}-${Date.now()}`, "otro", nombre, `slug-b-${n}-${Date.now()}`, ahora()),
    ]);

    const codigo = codigoNuevo();
    const r = await ejecutar(
      quien(),
      registro,
      pedir("crear_variante", {
        producto: nombre,
        codigo,
        nombre: "Presentación ambigua",
        unidades_por_caja: 12,
        precio_cents: 1300,
        motivo: "prueba",
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensaje).toMatch(/2 productos/);
    expect(await laVariante(codigo), "eligió uno de los dos y escribió").toBeNull();
  });
});

describe("dar_de_alta_producto", () => {
  it("crea el producto y su primera presentación de una vez, sin publicar", async () => {
    const nombre = nombreNuevo("Water wipes de prueba");
    const codigo = codigoNuevo();

    const r = await ejecutar(
      quien(),
      registro,
      pedir("dar_de_alta_producto", {
        familia: "wipes",
        nombre,
        codigo,
        unidades_por_caja: 600,
        precio_cents: 1300,
        motivo: "producto nuevo del proveedor",
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const v = await laVariante(codigo);
    expect(v?.publicado).toBe(0);
    expect(v?.precio_cents).toBe(1300);
    // El MISMO nombre en los dos, como lo manda la ruta del panel.
    expect(v?.nombre).toBe(nombre);
    const p = await env.DB.prepare("SELECT nombre, familia FROM productos WHERE id = ?")
      .bind(v?.producto_id)
      .first<{ nombre: string; familia: string }>();
    expect(p?.nombre).toBe(nombre);
    expect(p?.familia).toBe("wipes");
  });

  it("si el código está repetido no queda un producto sin presentaciones", async () => {
    // El hueco que esta ruta existe para cerrar: un producto sin variantes no
    // sale en la lista del catálogo —es `variantes JOIN productos`— y no se
    // puede ni ver ni arreglar desde el panel.
    const codigo = await unaVariante();
    const nombre = nombreNuevo("No debería quedar");

    const r = await ejecutar(
      quien(),
      registro,
      pedir("dar_de_alta_producto", {
        familia: "otro",
        nombre,
        codigo,
        unidades_por_caja: 10,
        precio_cents: 500,
        motivo: "prueba del batch",
      }),
    );
    expect(r.ok).toBe(false);

    const p = await env.DB.prepare("SELECT id FROM productos WHERE nombre = ?").bind(nombre).first();
    expect(p, "quedó un producto fantasma, sin presentaciones").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

describe("editar_variante", () => {
  it("es sensible: NO cambia nada hasta que una persona lo permite", async () => {
    const codigo = await unaVariante();
    const antes = await laVariante(codigo);

    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", { codigo, publicado: true, motivo: "revisada, ya se puede vender" }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");

    // Lo que importa: nada cambió todavía.
    expect((await laVariante(codigo))?.publicado).toBe(antes?.publicado);

    if (r.datos.clase !== "por_confirmar") return;
    // Y el resumen dice QUÉ va a pasar, con el dato concreto.
    expect(r.datos.resumen).toContain(codigo);

    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok, JSON.stringify(hecho)).toBe(true);
    expect((await laVariante(codigo))?.publicado, "no se publicó al permitirlo").toBe(1);
  });

  it("cambia nombre, talla y unidades, y sube la versión", async () => {
    const codigo = await unaVariante({ talla: "M" });
    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", {
        codigo,
        nombre: "Nombre corregido",
        talla: "XL",
        unidades_por_caja: 48,
        tasa_itbms_bp: 700,
        motivo: "venía mal del proveedor",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;
    expect((await permitir(r.datos.accionId)).ok).toBe(true);

    const v = await laVariante(codigo);
    expect(v?.nombre).toBe("Nombre corregido");
    expect(v?.talla).toBe("XL");
    expect(v?.unidades_por_caja).toBe(48);
    expect(v?.tasa_itbms_bp).toBe(700);
    expect(v?.version).toBe(2);
  });

  it("con talla null la deja sin talla", async () => {
    const codigo = await unaVariante({ talla: "M" });
    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", { codigo, talla: null, motivo: "esta no lleva talla" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;
    expect((await permitir(r.datos.accionId)).ok).toBe(true);
    expect((await laVariante(codigo))?.talla).toBeNull();
  });

  it("sin ningún campo que cambiar FALLA, no contesta «hecho»", async () => {
    // Es la guarda del archivo. `editarVariante` sin campos devuelve `ok` con
    // la versión que ya había, así que sin ella la herramienta diría «hecho»
    // sin haber cambiado nada —y la persona ya habría tocado «Permitir»—.
    const codigo = await unaVariante();
    const antes = await laVariante(codigo);

    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", { codigo, motivo: "no dije qué cambiar" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;

    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok, "dio por bueno un cambio vacío").toBe(false);
    if (hecho.ok) return;
    expect(hecho.mensaje).toContain("no se dijo qué cambiar");
    // Y la versión no se movió: una versión de más obliga a recargar a quien
    // tenga la pantalla abierta, por un cambio que nunca existió.
    expect((await laVariante(codigo))?.version).toBe(antes?.version);
  });

  it("el PRECIO no se cambia por aquí: manda a cambiar_precio", async () => {
    // Dos herramientas para el mismo cambio hacen que el modelo elija al azar,
    // y el precio ya tiene la suya, con su historial y su control de versión.
    const codigo = await unaVariante({ precioCents: 2500 });

    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", { codigo, precio_cents: 9999, motivo: "intento de colarlo" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;

    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok).toBe(false);
    if (hecho.ok) return;
    expect(hecho.mensaje).toContain("cambiar_precio");
    expect((await laVariante(codigo))?.precio_cents, "el precio cambió por la puerta de atrás").toBe(
      2500,
    );
  });

  it("de un código que no existe lo dice", async () => {
    const r = await ejecutar(
      quien(),
      registro,
      pedir("editar_variante", { codigo: "ZZ-NO-EXISTE", publicado: true, motivo: "prueba" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;
    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok).toBe(false);
  });

  it("no devuelve nada que huela a costo", async () => {
    const codigo = await unaVariante();
    const r = await editarVarianteDelCatalogo.ejecutar(ctx(), {
      codigo,
      publicado: true,
      motivo: "prueba de fronteras",
    });
    expect(JSON.stringify(r)).not.toMatch(/costo|margen/i);
  });
});

// ---------------------------------------------------------------------------
// Retirar
// ---------------------------------------------------------------------------

describe("ver_retiro_variante", () => {
  it("de una presentación sin historia dice que desaparece de verdad", async () => {
    const codigo = await unaVariante();
    const r = await ejecutar(quien(), registro, pedir("ver_retiro_variante", { codigo }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    // Lectura: va directo.
    expect(r.datos.clase).toBe("hecha");

    const datos = (r.datos as { datos: { modo: string; aviso: string; razones: string[] } }).datos;
    expect(datos.modo).toBe("se_borra");
    expect(datos.razones).toEqual([]);
    expect(datos.aviso).toContain("no se deshace");
  });

  it("con ventas o movimientos avisa de que NO desaparece, y dice por qué", async () => {
    const codigo = await unaVariante();
    const bodega = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,7,0,NULL)",
    )
      .bind(codigo, bodega?.id)
      .run();

    const r = await verRetiroDeVariante.ejecutar(ctx(), { codigo });
    expect(r.modo).toBe("se_oculta");
    expect(r.razones).toContain("tiene 7 unidades en bodega");
    expect(r.aviso).toContain("NO");
    // La razón la arma `explicar`, la misma función que usa el panel: las dos
    // puertas tienen que dar la misma razón con las mismas palabras.
    expect(r.aviso).toContain("tiene 7 unidades en bodega");
  });

  it("de un código que no existe contesta en vez de fallar", async () => {
    // Un modelo que se equivoca de código tiene que poder corregirse en el
    // mismo turno, no quedarse sin respuesta.
    const r = await verRetiroDeVariante.ejecutar(ctx(), { codigo: "ZZ-NO-EXISTE" });
    expect(r.existe).toBe(false);
    expect(r.modo).toBeNull();
    expect(r.aviso).toEqual(expect.any(String));
  });
});

describe("retirar_variante", () => {
  it("es sensible: no retira nada hasta que una persona lo permite", async () => {
    const codigo = await unaVariante();
    const r = await ejecutar(
      quien(),
      registro,
      pedir("retirar_variante", { codigo, motivo: "el proveedor la descontinuó" }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");
    expect(await laVariante(codigo), "se retiró sin que nadie lo permitiera").not.toBeNull();

    if (r.datos.clase !== "por_confirmar") return;
    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok, JSON.stringify(hecho)).toBe(true);
    expect(await laVariante(codigo)).toBeNull();
  });

  it("si ya se vendió o se movió NO desaparece: queda oculta", async () => {
    // Borrar la fila dejaría `pedido_lineas` y `movimientos_inventario`
    // apuntando a un código que no existe, o borraría la prueba de lo que
    // alguien compró y pagó.
    const codigo = await unaVariante();
    const bodega = await env.DB.prepare("SELECT id FROM bodegas LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES (?,?,4,0,NULL)",
    )
      .bind(codigo, bodega?.id)
      .run();

    const r = await ejecutar(
      quien(),
      registro,
      pedir("retirar_variante", { codigo, motivo: "ya no se trae" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.datos.clase !== "por_confirmar") return;

    const hecho = await permitir(r.datos.accionId);
    expect(hecho.ok, JSON.stringify(hecho)).toBe(true);
    if (!hecho.ok) return;

    const v = await laVariante(codigo);
    expect(v, "borró una fila que tenía existencias").not.toBeNull();
    expect(v?.activo).toBe(0);
    expect(v?.publicado).toBe(0);

    const datos = (hecho.datos as { datos: { modo: string; quedo: string } }).datos;
    expect(datos.modo).toBe("se_oculta");
    // En palabras, porque «se_oculta» y «se_borra» se parecen demasiado para
    // que el modelo se lo cuente bien a una persona.
    expect(datos.quedo).toContain("oculta");
  });

  it("lo que dijo ver_retiro_variante es lo que pasa", async () => {
    // Las dos usan `comoSeBorra`. Si cada una decidiera por su cuenta, el aviso
    // diría una cosa y ocurriría otra — que es el único sitio del sistema donde
    // el botón no hace literalmente lo que dice.
    const codigo = await unaVariante();
    const anuncio = await verRetiroDeVariante.ejecutar(ctx(), { codigo });

    const r = await retirarVariante.ejecutar(ctx(), { codigo, motivo: "prueba de coherencia" });
    expect(r.modo).toBe(anuncio.modo);
  });
});

// ---------------------------------------------------------------------------
// Lo que estas herramientas no son
// ---------------------------------------------------------------------------

describe("los niveles son los que dicen los comentarios", () => {
  it("crear es construcción; editar y retirar, sensible; mirar, lectura", () => {
    // Está escrito como prueba porque el nivel es lo único que separa «se
    // ejecuta» de «lo tiene que permitir una persona», y es un campo de texto
    // que se cambia sin querer.
    expect(crearProductoDelCatalogo.nivel).toBe("construccion");
    expect(crearVarianteDelCatalogo.nivel).toBe("construccion");
    expect(darDeAltaProducto.nivel).toBe("construccion");
    expect(editarVarianteDelCatalogo.nivel).toBe("sensible");
    expect(retirarVariante.nivel).toBe("sensible");
    expect(verRetiroDeVariante.nivel).toBe("lectura");
  });

  it("y todas son solo de la dueña", () => {
    for (const h of [
      crearProductoDelCatalogo,
      crearVarianteDelCatalogo,
      darDeAltaProducto,
      editarVarianteDelCatalogo,
      retirarVariante,
      verRetiroDeVariante,
    ]) {
      expect(h.roles, h.nombre).toEqual(["duena"]);
    }
  });
});
