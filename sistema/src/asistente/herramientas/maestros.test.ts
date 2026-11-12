import { env as real } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { crearLlave } from "../../mcp/llaves";
import { mcp } from "../../mcp/servidor";
import { ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import { referenciaDe, revisar } from "../referencias";
import type { Contexto } from "../registro";
import {
  cambiarUsoDeBodega,
  cambiarZona,
  corregirFichaDeClienta,
  crearBodega,
  crearZona,
  renombrarBodega,
} from "./maestros";

/**
 * Los maestros: bodegas, zonas de envío y la ficha de una clienta.
 *
 * Tres cosas se vigilan aquí, y cada una está por algo que ya mordió en este
 * repositorio:
 *
 *  1. **Que lo escrito se escribió.** No se cree el `ok` de la herramienta: se
 *     vuelve a leer la tabla. Un `UPDATE` que no casa con ninguna fila no falla
 *     en D1 (docs/TRAMPAS.md §1).
 *  2. **Que cero y «no se sabe» siguen siendo distintos** en la tarifa de una
 *     zona: `0` es que el envío no se cobra y `null` es que se cotiza a mano
 *     (§7).
 *  3. **Que corregir la ficha de una clienta NO devuelve sus datos** hacia el
 *     modelo (D-20). Es la prueba que esta herramienta existe para pasar.
 *
 * Y se llama a las herramientas por las DOS puertas: directo, para mirar lo que
 * devuelven, y por `ejecutar()` y por `/mcp`, que es por donde las va a llamar
 * quien las use de verdad. Una pieza con sus pruebas en verde que nadie invoca
 * desde fuera no está terminada (§12).
 */

const ahora = () => Date.now();
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${n++}`;

const DUENA = "u-maestros-duena";
let llaveDuena = "";

const ctx = (): Contexto => ({
  db: real.DB,
  usuario: { id: DUENA, correo: "maestros-duena@babycaleb.com", rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

beforeAll(async () => {
  // La bitácora `acciones` referencia `usuarios` y no se puede borrar —el
  // trigger lo prohíbe, que es justo lo que se quiere—, así que el usuario
  // entra con OR IGNORE y se queda.
  await real.DB.prepare(
    "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES (?,?,'Dueña maestros','duena',1,?)",
  )
    .bind(DUENA, "maestros-duena@babycaleb.com", ahora())
    .run();

  const llave = await crearLlave(real.DB, DUENA, "pruebas de maestros", ahora());
  if (!llave.ok) throw new Error("no se pudo crear la llave de MCP");
  llaveDuena = llave.datos.token;
});

/** Una bodega sembrada a mano, para no depender de las de la migración 0003. */
async function unaBodega(activa = true): Promise<{ id: string; nombre: string }> {
  const bid = id("bod");
  const nombre = `Bodega ${bid}`;
  await real.DB.prepare("INSERT INTO bodegas (id,nombre,activa) VALUES (?,?,?)")
    .bind(bid, nombre, activa ? 1 : 0)
    .run();
  return { id: bid, nombre };
}

/** Un artículo, para comprobar que una bodega nueva nace con su casillero. */
async function unaVariante(): Promise<string> {
  const prod = id("p");
  const codigo = id("MA").toUpperCase();
  await real.DB.batch([
    real.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,orden,activo,creado_en) VALUES (?,'panal','Maestros',?,1,1,?)",
    ).bind(prod, `slug-${prod}`, ahora()),
    real.DB.prepare(
      `INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,
         tasa_itbms_bp,publicado,activo,actualizado_en)
       VALUES (?,?,'Pieza de maestros','M',12,1250,0,1,1,?)`,
    ).bind(codigo, prod, ahora()),
  ]);
  return codigo;
}

const bodegaEn = async (bid: string) =>
  await real.DB.prepare("SELECT nombre, activa FROM bodegas WHERE id = ?")
    .bind(bid)
    .first<{ nombre: string; activa: number }>();

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

describe("crear_bodega", () => {
  it("la crea con su casillero para cada artículo", async () => {
    // Sin la fila en `existencias`, la bodega existe en la lista y no sirve
    // para nada: un ajuste de stock ahí no casaría con ninguna fila.
    const codigo = await unaVariante();
    const nombre = `Bodega nueva ${id("bn")}`;

    const r = await crearBodega.ejecutar(ctx(), { nombre, motivo: "abrimos local" });
    expect(r.bodega).toBe(nombre);
    expect(r.en_uso).toBe(true);

    const casillero = await real.DB.prepare(
      `SELECT e.fisico FROM existencias e JOIN bodegas b ON b.id = e.bodega_id
       WHERE b.nombre = ? AND e.codigo = ?`,
    )
      .bind(nombre, codigo)
      .first<{ fisico: number }>();
    expect(casillero?.fisico).toBe(0);
  });

  it("dice que la bodega nueva está vacía, en vez de dejar que suene a problema", async () => {
    const r = await crearBodega.ejecutar(ctx(), {
      nombre: `Bodega vacía ${id("bv")}`,
      motivo: "para probar el aviso",
    });
    expect(r.aviso).toMatch(/traslado/);
  });

  it("dos bodegas con el mismo nombre no, y lo dice la base", async () => {
    const nombre = `Bodega repetida ${id("br")}`;
    await crearBodega.ejecutar(ctx(), { nombre, motivo: "la primera" });
    await expect(
      crearBodega.ejecutar(ctx(), { nombre, motivo: "la segunda" }),
    ).rejects.toThrow(/ya hay una bodega/);
  });
});

describe("renombrar_bodega", () => {
  it("le cambia el nombre y se vuelve a leer de la tabla", async () => {
    const b = await unaBodega();
    const nuevo = `Bodega renombrada ${id("rn")}`;

    const r = await renombrarBodega.ejecutar(ctx(), {
      bodega: b.nombre,
      nombre_nuevo: nuevo,
      motivo: "se confundía con la otra",
    });
    expect(r.antes).toBe(b.nombre);
    expect((await bodegaEn(b.id))?.nombre).toBe(nuevo);
  });

  it("también renombra una bodega que NO está en uso", async () => {
    // Esta es la razón de no usar `bodegaPorNombre` de `db/inventario.ts`: esa
    // filtra por `activa = 1` porque sirve para surtir, y con ella la bodega
    // apagada sería invisible para quien la administra.
    const b = await unaBodega(false);
    const nuevo = `Bodega apagada ${id("ap")}`;

    await renombrarBodega.ejecutar(ctx(), {
      bodega: b.nombre,
      nombre_nuevo: nuevo,
      motivo: "ordenando nombres",
    });
    const fila = await bodegaEn(b.id);
    expect(fila?.nombre).toBe(nuevo);
    expect(fila?.activa).toBe(0);
  });

  it("una bodega que no existe se dice por su nombre", async () => {
    await expect(
      renombrarBodega.ejecutar(ctx(), {
        bodega: "Bodega que nadie abrió",
        nombre_nuevo: "Otra",
        motivo: "x",
      }),
    ).rejects.toThrow(/Bodega que nadie abrió/);
  });
});

describe("cambiar_uso_de_bodega", () => {
  it("la apaga y avisa de que su mercancía SIGUE contando", async () => {
    // Es la parte que sorprende: apagar una bodega llena no esconde lo que
    // tiene, solo deja de surtir desde ahí. Un modelo que no lo sepa contesta
    // lo contrario, que es falso.
    const b = await unaBodega();
    const r = await cambiarUsoDeBodega.ejecutar(ctx(), {
      bodega: b.nombre,
      en_uso: false,
      motivo: "cerramos el local",
    });

    expect(r.en_uso).toBe(false);
    expect(r.aviso).toMatch(/sigue contando/);
    expect((await bodegaEn(b.id))?.activa).toBe(0);
  });

  it("y vuelve a encender una apagada", async () => {
    const b = await unaBodega(false);
    const r = await cambiarUsoDeBodega.ejecutar(ctx(), {
      bodega: b.nombre,
      en_uso: true,
      motivo: "reabrimos",
    });

    expect(r.en_uso).toBe(true);
    expect(r.aviso).toBeNull();
    expect((await bodegaEn(b.id))?.activa).toBe(1);
  });

  it("es sensible: nadie la ejecuta sin que una persona la permita", async () => {
    const b = await unaBodega();
    const r = await ejecutar(
      { db: real.DB, usuario: ctx().usuario, ahora: ahora() },
      catalogo(),
      {
        nombre: "cambiar_uso_de_bodega",
        argumentos: { bodega: b.nombre, en_uso: false, motivo: "a ver si pasa" },
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");
    // Y NO pasó: la bodega sigue en uso.
    expect((await bodegaEn(b.id))?.activa).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Zonas
// ---------------------------------------------------------------------------

const zonaEn = async (nombre: string) =>
  await real.DB.prepare(
    `SELECT id, alias_json, region, metodo, tarifa_cents, requiere_pago_total,
            bodega_preferida_id, activa FROM zonas_envio WHERE nombre = ?`,
  )
    .bind(nombre)
    .first<{
      id: string;
      alias_json: string;
      region: string;
      metodo: string;
      tarifa_cents: number | null;
      requiere_pago_total: number;
      bodega_preferida_id: string | null;
      activa: number;
    }>();

/** `zonas_envio.nombre` es UNIQUE y la migración 0003 carga 47 zonas de verdad. */
const nombreDeZona = () => `Zona de maestros ${id("z")}`;

describe("crear_zona", () => {
  it("guarda la tarifa en centavos y la zona queda en uso", async () => {
    const nombre = nombreDeZona();
    const r = await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: 350,
      requiere_pago_total: false,
      motivo: "empezamos a entregar ahí",
    });

    expect(r.se_cotiza_a_mano).toBe(false);
    const z = await zonaEn(nombre);
    expect(z?.tarifa_cents).toBe(350);
    expect(z?.activa).toBe(1);
  });

  it("«se cotiza a mano» se guarda como NULO, que no es cero", async () => {
    // El nulo dice «todavía no se sabe» y el cero dice «el envío no se cobra».
    // Confundirlos regala el envío del interior en un sentido y cobra uno
    // gratis en el otro.
    const nombre = nombreDeZona();
    const r = await crearZona.ejecutar(ctx(), {
      nombre,
      region: "interior",
      metodo: "ferguson",
      tarifa_cents: null,
      requiere_pago_total: true,
      motivo: "la dueña todavía no puso tarifa",
    });

    expect(r.se_cotiza_a_mano).toBe(true);
    expect((await zonaEn(nombre))?.tarifa_cents).toBeNull();
  });

  it("y el envío gratis se guarda como CERO, que no es «se cotiza»", async () => {
    const nombre = nombreDeZona();
    const r = await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: 0,
      requiere_pago_total: false,
      motivo: "promoción de envío gratis",
    });

    expect(r.se_cotiza_a_mano).toBe(false);
    expect((await zonaEn(nombre))?.tarifa_cents).toBe(0);
  });

  it("la bodega preferida se dice por su nombre y se guarda por su id", async () => {
    const b = await unaBodega();
    const nombre = nombreDeZona();
    await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: 500,
      requiere_pago_total: false,
      bodega_preferida: b.nombre,
      alias: ["otra forma de escribirla", "otra forma de escribirla"],
      motivo: "surte desde el oeste",
    });

    const z = await zonaEn(nombre);
    expect(z?.bodega_preferida_id).toBe(b.id);
    // Los alias repetidos los limpia `db/zonas-admin.ts`, no esta capa.
    expect(JSON.parse(z?.alias_json ?? "[]")).toEqual(["otra forma de escribirla"]);
  });

  it("una bodega que no existe no crea la zona a medias", async () => {
    const nombre = nombreDeZona();
    await expect(
      crearZona.ejecutar(ctx(), {
        nombre,
        region: "ciudad",
        metodo: "motorizado",
        tarifa_cents: 500,
        requiere_pago_total: false,
        bodega_preferida: "Bodega inventada",
        motivo: "x",
      }),
    ).rejects.toThrow(/Bodega inventada/);
    expect(await zonaEn(nombre)).toBeNull();
  });

  it("la tarifa es obligatoria: no hay cifra por omisión", async () => {
    // Si el esquema la dejara opcional, el modelo podría crear una zona sin
    // decir cuánto se cobra y el sistema elegiría por él.
    const sinTarifa = crearZona.parametros.safeParse({
      nombre: "Zona sin tarifa",
      region: "ciudad",
      metodo: "motorizado",
      requiere_pago_total: false,
      motivo: "x",
    });
    expect(sinTarifa.success).toBe(false);
  });
});

describe("cambiar_zona", () => {
  /** Una zona ya guardada, con tarifa, para cambiarla después. */
  async function unaZona(tarifa: number | null = 350): Promise<string> {
    const nombre = nombreDeZona();
    await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: tarifa,
      requiere_pago_total: false,
      motivo: "sembrada para la prueba",
    });
    return nombre;
  }

  it("sube la tarifa y deja lo demás como estaba", async () => {
    const nombre = await unaZona();
    const r = await cambiarZona.ejecutar(ctx(), {
      zona: nombre,
      tarifa_cents: 400,
      motivo: "subió la gasolina",
    });

    expect(r.cambiados).toEqual(["tarifa"]);
    const z = await zonaEn(nombre);
    expect(z?.tarifa_cents).toBe(400);
    expect(z?.metodo).toBe("motorizado");
  });

  it("pasarla a «se cotiza a mano» SÍ es un cambio, no «déjala como estaba»", async () => {
    // Con `?? loQueHabia` en vez de mirar si la clave viene, este cambio se
    // perdería en silencio y la zona seguiría cobrando $3.50.
    const nombre = await unaZona(350);
    const r = await cambiarZona.ejecutar(ctx(), {
      zona: nombre,
      tarifa_cents: null,
      motivo: "ahora se cotiza por encomienda",
    });

    expect(r.se_cotiza_a_mano).toBe(true);
    expect((await zonaEn(nombre))?.tarifa_cents).toBeNull();
  });

  it("lo que no se pasa no se toca", async () => {
    const nombre = await unaZona(350);
    await cambiarZona.ejecutar(ctx(), {
      zona: nombre,
      en_uso: false,
      motivo: "pausada mientras no hay motorizado",
    });

    const z = await zonaEn(nombre);
    expect(z?.activa).toBe(0);
    expect(z?.tarifa_cents).toBe(350);
  });

  it("la bodega preferida se puede quitar", async () => {
    const b = await unaBodega();
    const nombre = nombreDeZona();
    await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: 350,
      requiere_pago_total: false,
      bodega_preferida: b.nombre,
      motivo: "sembrada",
    });

    await cambiarZona.ejecutar(ctx(), {
      zona: nombre,
      bodega_preferida: null,
      motivo: "ya no se surte de ahí",
    });
    expect((await zonaEn(nombre))?.bodega_preferida_id).toBeNull();
  });

  it("sin nada que cambiar lo dice, y no escribe", async () => {
    const nombre = await unaZona();
    await expect(
      cambiarZona.ejecutar(ctx(), { zona: nombre, motivo: "no dije qué" }),
    ).rejects.toThrow(/nada que cambiar/);
  });

  it("una zona que no existe se dice por su nombre", async () => {
    await expect(
      cambiarZona.ejecutar(ctx(), { zona: "Zona inventada", tarifa_cents: 100, motivo: "x" }),
    ).rejects.toThrow(/Zona inventada/);
  });

  it("la tarifa de una zona es DINERO: va por confirmar y no se mueve sola", async () => {
    // La regla del proyecto: cambiar una zona cambia lo que paga la clienta.
    // Por `ejecutar()` —que es por donde entra el panel, Telegram y MCP— queda
    // esperando a que una persona la permita, con la cifra escrita en el
    // resumen que esa persona lee.
    const nombre = await unaZona(350);
    const r = await ejecutar(
      { db: real.DB, usuario: ctx().usuario, ahora: ahora() },
      catalogo(),
      {
        nombre: "cambiar_zona",
        argumentos: { zona: nombre, tarifa_cents: 900, motivo: "a ver si pasa sola" },
        canal: "mcp",
        conversacionId: null,
        conAdjuntos: false,
        textoExterno: false,
      },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("por_confirmar");
    if (r.datos.clase !== "por_confirmar") return;
    // El resumen lleva la cifra en dólares: nadie permite «900» a ojo.
    expect(r.datos.resumen).toContain("$9.00");
    expect((await zonaEn(nombre))?.tarifa_cents).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// La ficha de una clienta (D-20)
// ---------------------------------------------------------------------------

interface Clienta {
  id: string;
  referencia: string;
  nombre: string;
  celular: string;
}

/** Una clienta con nombre y celular, y con su referencia ya dada. */
async function unaClienta(): Promise<Clienta> {
  const cid = id("cli");
  const nombre = `Rosalinda ${cid}`;
  // Un celular panameño de verdad: así la guarda de D-20 lo reconoce si se
  // escapara en un resultado.
  const celular = `5076${String(1_000_000 + (n % 1_000_000)).slice(0, 7)}`;
  await real.DB.prepare(
    "INSERT INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
  )
    .bind(cid, nombre, celular, ahora(), ahora())
    .run();

  return { id: cid, referencia: await referenciaDe(real.DB, cid), nombre, celular };
}

const fichaEn = async (cid: string) =>
  await real.DB.prepare(
    "SELECT nombre, apellido, celular_e164, correo, identificacion, identificacion_tipo, notas FROM clientes WHERE id = ?",
  )
    .bind(cid)
    .first<{
      nombre: string | null;
      apellido: string | null;
      celular_e164: string | null;
      correo: string | null;
      identificacion: string | null;
      identificacion_tipo: string | null;
      notas: string | null;
    }>();

describe("corregir_ficha_de_clienta", () => {
  it("guarda la cédula con su tipo, y se lee en la tabla", async () => {
    const c = await unaClienta();
    const r = await corregirFichaDeClienta.ejecutar(ctx(), {
      clienta: c.referencia,
      identificacion: "8-123-456",
      identificacion_tipo: "cedula",
      motivo: "nos la dio para la factura",
    });

    expect(r.guardado).toBe(true);
    const ficha = await fichaEn(c.id);
    expect(ficha?.identificacion).toBe("8-123-456");
    expect(ficha?.identificacion_tipo).toBe("cedula");
  });

  it("CAMBIA el dato sin DEVOLVERLO (D-20)", async () => {
    // La prueba que esta herramienta existe para pasar. Se cambian de golpe
    // los cuatro datos que identifican a una persona y el resultado que sale
    // hacia el modelo no lleva ni uno: solo la referencia y los NOMBRES de los
    // campos que se tocaron.
    const c = await unaClienta();
    const correo = `rosalinda-${id("m")}@ejemplo.com`;
    const celular = "6000-7311";

    const r = await corregirFichaDeClienta.ejecutar(ctx(), {
      clienta: c.referencia,
      nombre: "Rosalinda Corregida",
      apellido: "Pérez",
      celular,
      correo,
      motivo: "nos dictó sus datos para la factura",
    });

    // Lo primero: se guardó de verdad. Una herramienta que no devuelve nada
    // porque no hizo nada también pasaría la segunda mitad de esta prueba.
    const ficha = await fichaEn(c.id);
    expect(ficha?.correo).toBe(correo);
    expect(ficha?.celular_e164).toBe("50760007311");
    expect(ficha?.nombre).toBe("Rosalinda Corregida");

    // Y lo segundo: nada de eso vuelve. Ni el valor nuevo, ni el que había, ni
    // el nombre, ni el id de la fila.
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(correo);
    expect(texto).not.toContain(celular);
    expect(texto).not.toContain("50760007311");
    expect(texto).not.toContain("Rosalinda");
    expect(texto).not.toContain("Pérez");
    expect(texto).not.toContain(c.id);
    expect(r.clienta).toBe(c.referencia);
    expect(r.campos).toEqual(["nombre", "apellido", "celular", "correo"]);

    // La misma guarda que aplica el servidor de MCP a lo que sale: con los
    // nombres de la base delante, no encuentra nada.
    const { results } = await real.DB.prepare(
      "SELECT nombre FROM clientes WHERE nombre IS NOT NULL",
    ).all<{ nombre: string }>();
    expect(revisar(r, results.map((x) => x.nombre))).toEqual([]);
  });

  it("solo acepta la referencia, nunca el nombre ni el celular", async () => {
    // Si el esquema aceptara un nombre, el modelo lo mandaría y el nombre de
    // una clienta viviría en la conversación que se le reenvía en cada turno.
    expect(
      corregirFichaDeClienta.parametros.safeParse({
        clienta: "Rosalinda",
        nombre: "x",
        motivo: "por el nombre",
      }).success,
    ).toBe(false);
    expect(
      corregirFichaDeClienta.parametros.safeParse({
        clienta: "60007311",
        nombre: "x",
        motivo: "por el celular",
      }).success,
    ).toBe(false);
  });

  it("una referencia que no existe se dice sin inventar a nadie", async () => {
    await expect(
      corregirFichaDeClienta.ejecutar(ctx(), {
        clienta: "C-999999",
        notas: "algo",
        motivo: "x",
      }),
    ).rejects.toThrow(/C-999999/);
  });

  it("un número sin decir si es cédula o RUC no entra", async () => {
    // La regla es de `db/clientes.ts` y se mira contra el estado que QUEDA:
    // en una factura, una cédula y un RUC no son lo mismo.
    const c = await unaClienta();
    await expect(
      corregirFichaDeClienta.ejecutar(ctx(), {
        clienta: c.referencia,
        identificacion: "8-999-111",
        motivo: "me falta el tipo",
      }),
    ).rejects.toThrow(/cédula o RUC/);
    expect((await fichaEn(c.id))?.identificacion).toBeNull();
  });

  it("sin ningún dato que corregir lo dice, y no escribe", async () => {
    const c = await unaClienta();
    await expect(
      corregirFichaDeClienta.ejecutar(ctx(), { clienta: c.referencia, motivo: "no dije qué" }),
    ).rejects.toThrow(/al menos un dato/);
  });

  it("guardar el mismo dato otra vez es un guardado, y no se finge otra cosa", async () => {
    // La herramienta no compara el antes con el después, y no lo disimula:
    // `guardado` dice que la base escribió, no que el valor fuera distinto.
    // Para decir «no había nada que corregir» habría que leer la ficha y
    // restar, que es un segundo camino sobre la misma tabla y no cambiaría
    // nada de lo guardado.
    const c = await unaClienta();
    const r = await corregirFichaDeClienta.ejecutar(ctx(), {
      clienta: c.referencia,
      nombre: c.nombre,
      motivo: "sin cambio ninguno",
    });

    expect(r.guardado).toBe(true);
    expect(r.campos).toEqual(["nombre"]);
    // Y sigue sin devolver el nombre, aunque sea el que ya tenía.
    expect(JSON.stringify(r)).not.toContain("Rosalinda");
  });
});

// ---------------------------------------------------------------------------
// La puerta de MCP (docs/TRAMPAS.md §12)
// ---------------------------------------------------------------------------

describe("por la puerta de MCP", () => {
  const pedir = async (cuerpo: unknown) => {
    const r = await mcp(
      new Request("https://ruta.babycaleb.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${llaveDuena}` },
        body: JSON.stringify(cuerpo),
      }),
      real as Env,
    );
    return (await r.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
  };

  it("las seis herramientas se anuncian", async () => {
    // Una herramienta escrita y no registrada no existe: no se la puede pedir
    // por ninguna puerta y nadie se entera, porque las pruebas de la pieza
    // pasan igual (§12).
    const r = await pedir({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const nombres = (r.result as unknown as { tools: { name: string }[] }).tools.map((t) => t.name);

    expect(nombres).toContain("crear_bodega");
    expect(nombres).toContain("renombrar_bodega");
    expect(nombres).toContain("cambiar_uso_de_bodega");
    expect(nombres).toContain("crear_zona");
    expect(nombres).toContain("cambiar_zona");
    expect(nombres).toContain("corregir_ficha_de_clienta");
  });

  it("corregir una ficha funciona por MCP y no devuelve el dato", async () => {
    // Al otro lado de MCP hay otro modelo, de otra empresa. El servidor aplica
    // la misma guarda de D-20, así que un resultado con un celular dentro
    // volvería como error: que esto venga en verde dice las dos cosas a la vez
    // —que la herramienta sirve por esta puerta y que no filtra—.
    const c = await unaClienta();
    // Se manda un celular a propósito: es el dato que la guarda del servidor
    // sabe reconocer. Sin pasarlo, el resultado no tendría ninguno dentro y
    // esta prueba pasaría sin haber puesto la guarda a trabajar.
    const celular = "6000-7412";
    const r = await pedir({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "corregir_ficha_de_clienta",
        arguments: {
          clienta: c.referencia,
          celular,
          identificacion: "8-456-789",
          identificacion_tipo: "ruc",
          motivo: "nos dio el RUC por MCP",
        },
      },
    });

    expect(r.result?.isError).toBe(false);
    const texto = r.result?.content?.[0]?.text ?? "";
    expect(texto).toContain(c.referencia);
    expect(texto).not.toContain(celular);
    expect(texto).not.toContain("50760007412");
    expect(texto).not.toContain(c.celular);
    expect(texto).not.toContain(c.nombre);
    const ficha = await fichaEn(c.id);
    expect(ficha?.identificacion).toBe("8-456-789");
    expect(ficha?.celular_e164).toBe("50760007412");
  });

  it("una zona no se mueve por MCP sin una persona", async () => {
    const nombre = nombreDeZona();
    await crearZona.ejecutar(ctx(), {
      nombre,
      region: "ciudad",
      metodo: "motorizado",
      tarifa_cents: 350,
      requiere_pago_total: false,
      motivo: "sembrada para la prueba de MCP",
    });

    const r = await pedir({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cambiar_zona",
        arguments: { zona: nombre, tarifa_cents: 1500, motivo: "subida por MCP" },
      },
    });

    // Se dice que NO se hizo. Devolverlo como éxito haría que un agente
    // siguiera adelante creyendo que la tarifa ya cambió.
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content?.[0]?.text).toContain("No se hizo");
    expect((await zonaEn(nombre))?.tarifa_cents).toBe(350);
  });
});
