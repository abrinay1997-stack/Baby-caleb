import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CLAVES } from "../dominio/ajustes";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel, exigeEditar, panel } from "./panel";
import { Hono } from "hono";

const T = 1_800_000_000_000;

const comoUsuario = (rol: RolDePanel): Usuario => ({
  id: `u-${rol}`,
  correo: `${rol}@babycaleb.com`,
  nombre: `La ${rol}`,
  rol,
  activo: true,
});

/** Entra directamente como un rol, sin montar un Access de verdad. */
const entrandoComo = (rol: RolDePanel) =>
  crearPanel((async () => ({ ok: true, usuario: comoUsuario(rol) })) as ResolverUsuario);

async function pedir(app: ReturnType<typeof crearPanel>, ruta: string) {
  const r = await app.fetch(new Request(`https://panel.babycaleb.com${ruta}`), real as Env);
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

/** Un POST con cuerpo JSON. */
async function postJson(
  app: ReturnType<typeof crearPanel>,
  ruta: string,
  cuerpo: Record<string, unknown>,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
      headers: { "content-type": "application/json" },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

/** Cambiar un ajuste, como hace la pantalla. */
async function cambiarAjuste(
  app: ReturnType<typeof crearPanel>,
  clave: string,
  cuerpo: Record<string, unknown>,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com/ajustes/${clave}`, {
      method: "POST",
      body: JSON.stringify(cuerpo),
      headers: { "content-type": "application/json" },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

/** Bytes de un PNG de verdad (la cabecera, que es lo que se mira). */
const PNG = (() => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b.buffer;
})();

/** Sube un archivo crudo, como hace el panel. */
async function subirFoto(
  app: ReturnType<typeof crearPanel>,
  codigo: string,
  datos: ArrayBuffer,
  tipoDeclarado = "image/png",
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com/catalogo/variantes/${codigo}/foto`, {
      method: "PUT",
      body: datos,
      headers: { "content-type": tipoDeclarado },
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

/** Como `pedir`, pero escribiendo. */
async function mandar(
  app: ReturnType<typeof crearPanel>,
  metodo: "POST" | "PATCH" | "DELETE",
  ruta: string,
  datos?: unknown,
) {
  const r = await app.fetch(
    new Request(`https://panel.babycaleb.com${ruta}`, {
      method: metodo,
      ...(datos === undefined
        ? {}
        : { body: JSON.stringify(datos), headers: { "content-type": "application/json" } }),
    }),
    real as Env,
  );
  return { estado: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
}

// Estas pruebas parten de una base VACÍA para poder contar lo que siembran.
// Desde la migración 0003 la base trae el catálogo de verdad, así que hay que
// vaciarla, y el ORDEN importa: `zonas_envio` apunta a una bodega preferida, y
// borrar las bodegas primero rompe la llave foránea. (Lo destapó la propia
// carga inicial: antes de ella no había ninguna zona que apuntara a nada.)
beforeEach(async () => {
  await real.DB.batch([
    // `precios_historial` apunta a `variantes`, así que va ANTES. Lo destapó la
    // primera prueba que cambió un precio por la API: hasta entonces ninguna
    // escribía ahí y el orden alcanzaba.
    real.DB.prepare("DELETE FROM precios_historial"),
    real.DB.prepare("DELETE FROM existencias"),
    real.DB.prepare("DELETE FROM valor_inventario"),
    real.DB.prepare("DELETE FROM variantes"),
    real.DB.prepare("DELETE FROM productos"),
    real.DB.prepare("DELETE FROM zonas_envio"),
    real.DB.prepare("DELETE FROM bodegas"),
    real.DB.prepare("DELETE FROM usuarios"),
    real.DB.prepare("DELETE FROM ajustes"),
    real.DB.prepare("DELETE FROM archivos"),
  ]);
});

async function sembrarCatalogo() {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT INTO productos (id,familia,nombre,slug,creado_en) VALUES ('p1','panal','Pañal Nateen','panal-nateen',?)",
    ).bind(T),
    real.DB.prepare(
      "INSERT INTO variantes (codigo,producto_id,nombre,talla,unidades_por_caja,precio_cents,tasa_itbms_bp,publicado,actualizado_en) VALUES ('NAT-M','p1','Pañal Nateen M','M',144,5000,NULL,1,?)",
    ).bind(T),
    real.DB.prepare("INSERT INTO bodegas (id,nombre) VALUES ('bod-pty','Bodega Ciudad de Panamá')"),
    real.DB.prepare(
      "INSERT INTO existencias (codigo,bodega_id,fisico,reservado,minimo) VALUES ('NAT-M','bod-pty',10,2,5)",
    ),
    // El costo vive aparte, y solo lo ven los roles que lo tienen.
    real.DB.prepare(
      "INSERT INTO valor_inventario (codigo,unidades,valor_cents) VALUES ('NAT-M',10,30000)",
    ),
  ]);
}

describe("la puerta está en todas las rutas", () => {
  it("sin Access configurado, ninguna contesta datos", async () => {
    // El panel de verdad usa `revisarPeticion`, y ACCESS_EQUIPO está vacío.
    for (const ruta of ["/yo", "/resumen", "/catalogo", "/existencias", "/bodegas", "/zonas", "/ajustes", "/usuarios"]) {
      const r = await pedir(panel, ruta);
      expect(r.estado, ruta).toBe(403);
      expect(r.cuerpo, ruta).toMatchObject({ ok: false, codigo: "no_autorizado" });
    }
  });

  it("una ruta nueva hereda la puerta sin que nadie se acuerde", async () => {
    // El middleware es `use("*")`, así que no hay forma de añadir una ruta
    // desprotegida salvo sacándola de este módulo.
    const r = await pedir(panel, "/una-ruta-que-no-existe");
    expect(r.estado).toBe(403);
  });
});

describe("/yo", () => {
  it("devuelve el usuario y la matriz de permisos de su rol", async () => {
    const r = await pedir(entrandoComo("duena"), "/yo");
    expect(r.estado).toBe(200);
    const datos = r.cuerpo.datos as { usuario: Usuario; permisos: Record<string, string> };
    expect(datos.usuario.rol).toBe("duena");
    expect(datos.permisos.ajustes).toBe("editar");
  });

  it("y los permisos son los del rol, no los de la dueña", async () => {
    const r = await pedir(entrandoComo("contadora"), "/yo");
    const datos = r.cuerpo.datos as { permisos: Record<string, string> };
    expect(datos.permisos.contabilidad).toBe("editar");
    expect(datos.permisos.cierre_de_mes).toBe("no");
    expect(datos.permisos.precios_y_stock).toBe("no");
  });
});

describe("el rol decide qué ruta se abre", () => {
  it("la contadora no entra en ajustes ni en usuarios", async () => {
    const contadora = entrandoComo("contadora");
    for (const ruta of ["/ajustes", "/usuarios"]) {
      const r = await pedir(contadora, ruta);
      expect(r.estado, ruta).toBe(403);
      expect(r.cuerpo, ruta).toMatchObject({ ok: false, codigo: "no_autorizado" });
    }
  });

  it("la asistente tampoco", async () => {
    const r = await pedir(entrandoComo("asistente"), "/ajustes");
    expect(r.estado).toBe(403);
  });

  it("la dueña sí", async () => {
    for (const ruta of ["/ajustes", "/usuarios"]) {
      const r = await pedir(entrandoComo("duena"), ruta);
      expect(r.estado, ruta).toBe(200);
    }
  });

  it("todas ven el catálogo, que es lo que usan a diario", async () => {
    await sembrarCatalogo();
    for (const rol of ["duena", "asistente", "contadora"] as const) {
      const r = await pedir(entrandoComo(rol), "/catalogo");
      expect(r.estado, rol).toBe(200);
    }
  });
});

describe("el costo no sale si el rol no lo tiene", () => {
  it("la dueña y la contadora lo reciben", async () => {
    await sembrarCatalogo();
    for (const rol of ["duena", "contadora"] as const) {
      const r = await pedir(entrandoComo(rol), "/catalogo");
      const datos = r.cuerpo.datos as { variantes: Record<string, unknown>[]; muestraCosto: boolean };
      expect(datos.muestraCosto, rol).toBe(true);
      expect(datos.variantes[0], rol).toHaveProperty("costo_valor_cents");
    }
  });

  it("la asistente NO: no se filtra en la pantalla, no se consulta", async () => {
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("asistente"), "/catalogo");
    const datos = r.cuerpo.datos as { variantes: Record<string, unknown>[]; muestraCosto: boolean };
    expect(datos.muestraCosto).toBe(false);
    // Lo que no sale del servidor no se puede filtrar por error.
    const campos = Object.keys(datos.variantes[0]!);
    expect(campos).not.toContain("costo_valor_cents");
    expect(campos).not.toContain("costo_unidades");
    // Y el precio sí va, que es lo que necesita para atender.
    expect(campos).toContain("precio_cents");
  });
});

describe("/resumen", () => {
  /*
   * Aquí había tres pruebas de la forma VIEJA de esta ruta, que contaba
   * variantes y bodegas y devolvía una lista de «por acabarse». Las reglas que
   * protegían no se perdieron: «lo libre es físico menos reservado» y «avisa al
   * llegar al mínimo» viven ahora en `db/metricas.ts` con sus propias pruebas
   * (test/metricas.test.ts). Lo comprobé antes de quitarlas.
   *
   * La tercera —«una variante sin mínimo no aparece»— cambió a propósito: hoy
   * las 36 filas del inventario están sin mínimo, así que la alarma de «por
   * acabarse» no podía avisar de nada y la pantalla callaba un problema. Ahora
   * «sin mínimo puesto» es su propia cifra. Es un cambio de criterio, no una
   * regla que se cayó.
   *
   * Lo que queda aquí es lo que decide LA RUTA.
   */

  it("abre para cualquier rol: el filtro va dentro, no en la puerta", async () => {
    // Es la portada. Un 403 aquí deja el panel sin primera pantalla para quien
    // sí puede entrar, así que el permiso se aplica por bloque y no al entrar.
    await sembrarCatalogo();
    for (const rol of ["duena", "asistente", "contadora"] as const) {
      const r = await pedir(entrandoComo(rol), "/resumen");
      expect(r.estado, `${rol} no pudo abrir la portada`).toBe(200);
    }
  });

  it("la asistente NO recibe el bloque del dinero", async () => {
    // Su rol tiene `cobros: no` y `contabilidad: no`. El bloque no se esconde
    // en la pantalla: no se pide a la base, y llega en nulo.
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("asistente"), "/resumen");
    const d = r.cuerpo.datos as { dinero: unknown; atencion: unknown };
    expect(d.dinero).toBeNull();
    // Y lo que sí le toca sigue viniendo: tiene `pedidos: editar`.
    expect(d.atencion).not.toBeNull();
  });

  it("la dueña sí lo recibe", async () => {
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("duena"), "/resumen");
    expect((r.cuerpo.datos as { dinero: unknown }).dinero).not.toBeNull();
  });

  it("un periodo que no se entiende cae en «hoy» en vez de fallar", async () => {
    // Esta pantalla tiene que abrir siempre. Un 400 por un parámetro torcido
    // en la URL dejaría a la dueña sin portada por un enlace viejo.
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("duena"), "/resumen?periodo=el-siglo-pasado");
    expect(r.estado).toBe(200);
    expect((r.cuerpo.datos as { periodo: { nombre: string } }).periodo.nombre).toBe("hoy");
  });

  it("y «semana» se respeta", async () => {
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("duena"), "/resumen?periodo=semana");
    expect((r.cuerpo.datos as { periodo: { nombre: string } }).periodo.nombre).toBe("semana");
  });
});

describe("/zonas", () => {
  it("convierte el alias de texto JSON a una lista", async () => {
    await real.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,alias_json,region,metodo,tarifa_cents,actualizado_en)
       VALUES ('z1','24 de Diciembre','["24 dic","veinticuatro"]','ciudad','motorizado',350,?)`,
    )
      .bind(T)
      .run();
    const r = await pedir(entrandoComo("duena"), "/zonas");
    const d = r.cuerpo.datos as { zonas: { alias: string[]; alias_json?: unknown }[] };
    expect(d.zonas[0]!.alias).toEqual(["24 dic", "veinticuatro"]);
    // Y el texto crudo no viaja: la pantalla no tiene nada que hacer con él.
    expect(d.zonas[0]).not.toHaveProperty("alias_json");
  });

  it("un alias ilegible no tumba la pantalla", async () => {
    await real.DB.prepare(
      `INSERT INTO zonas_envio (id,nombre,alias_json,region,metodo,actualizado_en)
       VALUES ('z2','Rota','{esto no es json','ciudad','motorizado',?)`,
    )
      .bind(T)
      .run();
    const r = await pedir(entrandoComo("duena"), "/zonas");
    expect(r.estado).toBe(200);
    const d = r.cuerpo.datos as { zonas: { nombre: string; alias: string[] }[] };
    expect(d.zonas[0]!.nombre).toBe("Rota");
    expect(d.zonas[0]!.alias).toEqual([]);
  });
});

describe("/ajustes", () => {
  it("devuelve la versión más alta que ya está vigente", async () => {
    // La vigencia se compara contra el reloj de verdad —la ruta usa
    // `Date.now()`— así que estas fechas son relativas a él y no a una
    // constante: con una fija, el día que esa fecha quede en el futuro la
    // prueba empezaría a fallar sola.
    const ahora = Date.now();
    await real.DB.batch([
      real.DB.prepare(
        "INSERT INTO ajustes (clave,version,valor_json,vigente_desde,cambiado_por) VALUES ('abono_minimo_cents',1,'500',?,'duena')",
      ).bind(ahora - 100_000),
      real.DB.prepare(
        "INSERT INTO ajustes (clave,version,valor_json,vigente_desde,cambiado_por) VALUES ('abono_minimo_cents',2,'1000',?,'duena')",
      ).bind(ahora - 50_000),
      // Esta todavía no vale: su vigencia empieza mañana.
      real.DB.prepare(
        "INSERT INTO ajustes (clave,version,valor_json,vigente_desde,cambiado_por) VALUES ('abono_minimo_cents',3,'9999',?,'duena')",
      ).bind(ahora + 86_400_000),
    ]);

    const r = await pedir(entrandoComo("duena"), "/ajustes");
    const d = r.cuerpo.datos as { ajustes: { clave: string; version: number | null; valor: unknown }[] };
    const abono = d.ajustes.find((v) => v.clave === "abono_minimo_cents");
    expect(abono?.version).toBe(2);
    expect(abono?.valor).toBe(1000);
  });

  it("la asistente NO puede cambiar un ajuste", async () => {
    // El dueño lo pidió con todas sus letras: «Juancito no va a venir y
    // cambiar los permisos y las políticas. Eso lo hace solamente el
    // administrador». La matriz de roles ya lo dice; esto comprueba que la
    // ruta la respeta.
    const r = await cambiarAjuste(entrandoComo("asistente"), "stock_bajo", {
      valor: 3,
      motivo: "me pareció",
    });
    expect(r.estado).toBe(403);

    // Y no se guardó nada: un 403 que igual escribe es peor que no tener 403.
    const fila = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM ajustes WHERE clave = 'stock_bajo'",
    ).first<{ n: number }>();
    expect(fila?.n).toBe(0);
  });

  it("quién lo cambió sale de la sesión, NUNCA del cuerpo", async () => {
    // Si saliera del cuerpo, cualquiera firmaría con el nombre de otra
    // persona y el historial —que existe para contestar «¿quién bajó la
    // comisión en marzo?»— dejaría de valer para nada.
    const r = await cambiarAjuste(entrandoComo("duena"), "stock_bajo", {
      valor: 7,
      motivo: "se repone más rápido de lo que pensábamos",
      cambiado_por: "otra@persona.com",
      actor: "otra@persona.com",
    });
    expect(r.estado).toBe(200);

    const fila = await real.DB.prepare(
      "SELECT cambiado_por FROM ajustes WHERE clave = 'stock_bajo' ORDER BY version DESC LIMIT 1",
    ).first<{ cambiado_por: string }>();
    expect(fila?.cambiado_por).toBe(comoUsuario("duena").correo);
    expect(fila?.cambiado_por).not.toBe("otra@persona.com");
  });

  it("un valor que no vale se rechaza con el motivo en español", async () => {
    const r = await cambiarAjuste(entrandoComo("duena"), "stock_bajo", {
      valor: -5,
      motivo: "probando",
    });
    expect(r.estado).toBe(400);
    // El mensaje es para la dueña, no para quien programa.
    expect(String(r.cuerpo["mensaje"] ?? "")).toMatch(/[a-záéíóúñ]{4,}/i);
  });

  it("el historial de una clave inventada es un 404, no una lista vacía", async () => {
    const r = await pedir(entrandoComo("duena"), "/ajustes/no_existe_esta_clave/historial");
    expect(r.estado).toBe(404);
  });

  it("sin nada puesto devuelve TODAS las claves con su valor de fábrica", async () => {
    // Esto cambió, y a mejor. Antes la ruta devolvía una lista vacía y era la
    // PANTALLA la que mezclaba los valores de fábrica. Dos sitios podían
    // decidir qué vale una clave que nadie ha tocado, y dos sitios que deciden
    // lo mismo acaban decidiendo distinto.
    //
    // Ahora lo resuelve el servidor y lo dice: cada fila trae `origen`, así
    // que la pantalla puede seguir distinguiendo «esto lo puso ella» de «esto
    // viene de fábrica» sin tener que calcularlo.
    const r = await pedir(entrandoComo("duena"), "/ajustes");
    expect(r.estado).toBe(200);
    const d = r.cuerpo.datos as {
      ajustes: { clave: string; origen: string; valor: unknown; pendiente: boolean }[];
    };

    // TODAS las claves, siempre. Una que desaparece de la lista es una que
    // nadie vuelve a buscar.
    //
    // El número NO se escribe aquí a mano: estaba puesto en 15 y se quedó
    // viejo al añadir los dos ajustes de WhatsApp, que es la misma trampa §4
    // del número de pantallas del auditor. Se compara con las claves de verdad
    // y además se nombran una por una, que es lo que de verdad se quería
    // comprobar.
    expect(d.ajustes.map((a) => a.clave).sort()).toEqual([...CLAVES].sort());
    expect(d.ajustes.every((a) => a.origen === "fabrica")).toBe(true);

    // Y lo que todavía nadie ha decidido se ve como tal, que no es lo mismo
    // que valer cero.
    const reserva = d.ajustes.find((a) => a.clave === "reserva_horas_comprobante");
    expect(reserva?.pendiente).toBe(true);
  });
});

describe("/pedidos", () => {
  let k = 0;
  async function unPedido(): Promise<{ id: string; numero: string }> {
    // Identificadores propios: este archivo ya no limpia pedidos (los libros
    // de entregas que cuelgan de ellos no se pueden borrar).
    const suf = `${Date.now()}-${k++}`;
    const id = `pr-${suf}`;
    const numero = `BC-R${suf}`;
    await real.DB.batch([
      real.DB.prepare(
        "INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES (?,'Ana',?,?)",
      ).bind(`cr-${suf}`, T, T),
      real.DB.prepare(
        `INSERT INTO pedidos
           (id,numero,token,cliente_id,origen,estado,estado_pago,
            subtotal_cents,envio_cents,descuento_cents,itbms_cents,total_cents,
            pagado_cents,abono_minimo_cents,requiere_pago_total,creado_en,actualizado_en)
         VALUES (?,?,?,?,'web','agendado','abonado',10000,0,0,0,10000,2500,500,0,?,?)`,
      ).bind(id, numero, `tk-${suf}`, `cr-${suf}`, T, T),
    ]);
    return { id, numero };
  }

  it("la asistente ve el pedido pero NO el dinero", async () => {
    // Su rol tiene `pedidos: editar` y `cobros: no`. El recorte lo hace el
    // SERVIDOR: si llegara el total y lo escondiera la pantalla, ahí seguiría,
    // a la vista de quien abra las herramientas del navegador.
    const { numero } = await unPedido();
    const r = await pedir(entrandoComo("asistente"), `/pedidos?busca=${numero}`);
    expect(r.estado).toBe(200);
    const d = r.cuerpo.datos as { pedidos: { numero: string; total_cents: number | null }[] };
    const p = d.pedidos.find((x) => x.numero === numero);
    expect(p, "la asistente tiene que poder VER el pedido").toBeDefined();
    expect(p?.total_cents, "y no su dinero").toBeNull();
  });

  it("la dueña sí lo ve", async () => {
    const { numero } = await unPedido();
    const r = await pedir(entrandoComo("duena"), `/pedidos?busca=${numero}`);
    const d = r.cuerpo.datos as { pedidos: { numero: string; saldo_cents: number | null }[] };
    expect(d.pedidos.find((x) => x.numero === numero)?.saldo_cents).toBe(7500);
  });

  it("el costo es más estrecho aún: ni la dueña lo edita, solo lo ve", async () => {
    // `costo_y_margen` está en «ver» para la dueña y en «no» para la
    // asistente. El detalle de un pedido lo respeta línea a línea.
    const { id } = await unPedido();
    const r = await pedir(entrandoComo("asistente"), `/pedidos/${id}`);
    const d = r.cuerpo.datos as { items: { costo_unit_cents: number | null }[] };
    expect(d.items.every((l) => l.costo_unit_cents === null)).toBe(true);
  });

  it("un estado inventado se rechaza con 400", async () => {
    const r = await pedir(entrandoComo("duena"), "/pedidos?estado=inventado");
    expect(r.estado).toBe(400);
  });

  it("un pedido que no existe es 404", async () => {
    const r = await pedir(entrandoComo("duena"), "/pedidos/no-existe");
    expect(r.estado).toBe(404);
  });
});

describe("/usuarios", () => {
  it("lista a quien puede entrar", async () => {
    await real.DB.prepare(
      "INSERT INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES ('u1','duena@babycaleb.com','La dueña','duena',1,?)",
    )
      .bind(T)
      .run();
    const r = await pedir(entrandoComo("duena"), "/usuarios");
    const d = r.cuerpo.datos as { usuarios: { correo: string; rol: string }[] };
    expect(d.usuarios).toHaveLength(1);
    expect(d.usuarios[0]).toMatchObject({ correo: "duena@babycaleb.com", rol: "duena" });
  });
});


describe("el catálogo se puede cambiar, y solo por quien debe", () => {
  /**
   * El pedido del dueño, con sus palabras: «que Juancito no venga y cambie los
   * permisos y las políticas; eso lo hace solamente el administrador».
   *
   * `exige` mira `puedeVer` y vale para leer. Escribir pasa por `exigeEditar`,
   * que mira `puedeEditar` — y para precios el único que lo tiene es `duena`.
   */
  /**
   * La puerta de escritura, probada CONTRA UN PERMISO DONDE VER Y EDITAR NO
   * COINCIDEN.
   *
   * Sobre `precios_y_stock` no se puede: la dueña edita y las otras dos ni ven,
   * así que `puedeVer` y `puedeEditar` dan lo mismo y la prueba pasaría con la
   * puerta equivocada. Comprobado cambiándola. Sobre `pedidos` sí difieren: la
   * contadora los VE y no los edita, y ahí la puerta se puede medir.
   */
  it("la puerta de escritura mira EDITAR, no VER", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { usuario: Usuario } }>();
    app.use("*", async (c, next) => {
      c.set("usuario", comoUsuario("contadora"));
      await next();
    });
    app.post("/x", exigeEditar("pedidos"), (c) => c.json({ ok: true }));

    const r = await app.fetch(
      new Request("https://panel.babycaleb.com/x", { method: "POST" }),
      real as Env,
    );
    // La contadora VE los pedidos. Con `puedeVer` esto daría 200 y la puerta
    // no serviría para nada.
    expect(r.status, "ve pedidos, pero no los edita").toBe(403);
  });

  it("un rol sin permiso sobre precios no puede cambiarlos", async () => {
    await sembrarCatalogo();

    // Primero se demuestra que sí puede VER: si no, el 403 de abajo no probaría
    // nada sobre la diferencia entre mirar y cambiar.
    const leyendo = await pedir(entrandoComo("asistente"), "/catalogo");
    expect(leyendo.estado, "la asistente sí ve el catálogo").toBe(200);

    const escribiendo = await mandar(entrandoComo("asistente"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 1,
      version: 1,
    });
    expect(escribiendo.estado).toBe(403);

    // Y lo que importa de verdad: el precio NO cambió.
    const v = await real.DB.prepare("SELECT precio_cents FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ precio_cents: number }>();
    expect(v?.precio_cents).toBe(5000);
  });

  it("la dueña sí", async () => {
    await sembrarCatalogo();
    const r = await mandar(entrandoComo("duena"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 5500,
      version: 1,
    });
    expect(r.estado).toBe(200);

    const v = await real.DB.prepare("SELECT precio_cents FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ precio_cents: number }>();
    expect(v?.precio_cents).toBe(5500);
  });

  it("quien cambia el precio queda escrito con su correo, no como «el panel»", async () => {
    await sembrarCatalogo();
    await mandar(entrandoComo("duena"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 5500,
      version: 1,
    });
    const h = await real.DB.prepare(
      "SELECT cambiado_por FROM precios_historial WHERE codigo = 'NAT-M'",
    ).first<{ cambiado_por: string }>();
    // «panel» no contesta la pregunta que se hace cuando alguien reclama un
    // precio.
    expect(h?.cambiado_por).toBe("duena@babycaleb.com");
  });

  it("sin la versión no se guarda: dos personas a la vez se pisarían", async () => {
    await sembrarCatalogo();
    const r = await mandar(entrandoComo("duena"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 9999,
    });
    expect(r.estado).toBe(400);
    const v = await real.DB.prepare("SELECT precio_cents FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ precio_cents: number }>();
    expect(v?.precio_cents).toBe(5000);
  });

  it("con la versión vieja responde 409, que es «alguien llegó antes»", async () => {
    await sembrarCatalogo();
    await mandar(entrandoComo("duena"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 6000,
      version: 1,
    });
    const r = await mandar(entrandoComo("duena"), "PATCH", "/catalogo/variantes/NAT-M", {
      precioCents: 7000,
      version: 1,
    });
    expect(r.estado).toBe(409);
  });

  it("avisa ANTES de borrar lo que de verdad va a pasar, en español", async () => {
    await sembrarCatalogo();
    // NAT-M tiene existencias sembradas, así que no se borra: se oculta.
    const r = await pedir(entrandoComo("duena"), "/catalogo/variantes/NAT-M/borrado");
    expect(r.estado).toBe(200);
    const d = (r.cuerpo as { datos: { modo: string; razones: string[] } }).datos;
    expect(d.modo).toBe("se_oculta");
    expect(d.razones.join(" ")).toContain("unidades en bodega");
    // El panel no debe ver nunca un nombre de tabla.
    expect(d.razones.join(" ")).not.toMatch(/_|lineas/);
  });

  it("crear una variante la deja SIN publicar", async () => {
    await sembrarCatalogo();
    const r = await mandar(entrandoComo("duena"), "POST", "/catalogo/variantes", {
      codigo: "NAT-G",
      productoId: "p1",
      nombre: "Pañal Nateen G",
      unidadesPorCaja: 120,
      precioCents: 5200,
    });
    expect(r.estado).toBe(201);
    const v = await real.DB.prepare("SELECT publicado FROM variantes WHERE codigo = 'NAT-G'")
      .first<{ publicado: number }>();
    expect(v?.publicado).toBe(0);
  });

  it("un código repetido responde 409 y no pisa el que ya estaba", async () => {
    await sembrarCatalogo();
    const r = await mandar(entrandoComo("duena"), "POST", "/catalogo/variantes", {
      codigo: "NAT-M",
      productoId: "p1",
      nombre: "Otro distinto",
      unidadesPorCaja: 1,
      precioCents: 1,
    });
    expect(r.estado).toBe(409);
    const v = await real.DB.prepare("SELECT nombre FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ nombre: string }>();
    expect(v?.nombre).toBe("Pañal Nateen M");
  });
});

describe("dar de alta un producto no deja huérfanos", () => {
  /**
   * El hueco: en dos llamadas —producto, luego variante— si la segunda falla
   * queda un producto SIN NINGUNA VARIANTE. Y ese no se ve ni se arregla desde
   * el panel, porque la lista del catálogo sale de `variantes JOIN productos`:
   * lo que no tiene variantes no aparece en ninguna parte. Es un registro
   * fantasma con otro nombre.
   */
  it("si el código ya existe, NO queda un producto suelto", async () => {
    await sembrarCatalogo();
    const antes = await real.DB.prepare("SELECT COUNT(*) AS n FROM productos").first<{ n: number }>();

    const r = await mandar(entrandoComo("duena"), "POST", "/catalogo/altas", {
      familia: "panal",
      nombre: "Producto que no debería quedar",
      codigo: "NAT-M", // ya existe
      unidadesPorCaja: 10,
      precioCents: 1000,
    });
    expect(r.estado).toBe(409);

    const despues = await real.DB.prepare("SELECT COUNT(*) AS n FROM productos").first<{ n: number }>();
    expect(despues?.n, "el producto no se quedó a medias").toBe(antes?.n);
  });

  it("cuando sale bien, quedan los dos y sin publicar", async () => {
    await sembrarCatalogo();
    const r = await mandar(entrandoComo("duena"), "POST", "/catalogo/altas", {
      familia: "wipes",
      nombre: "Wipes de agua",
      codigo: "AGUA-600",
      unidadesPorCaja: 12,
      precioCents: 2500,
    });
    expect(r.estado).toBe(201);

    const v = await real.DB.prepare(
      `SELECT v.publicado, p.nombre AS producto FROM variantes v
         JOIN productos p ON p.id = v.producto_id WHERE v.codigo = 'AGUA-600'`,
    ).first<{ publicado: number; producto: string }>();
    expect(v?.producto).toBe("Wipes de agua");
    expect(v?.publicado).toBe(0);
  });
});

describe("la foto de un producto", () => {
  it("se sube y la variante queda apuntando a ella", async () => {
    await sembrarCatalogo();
    const r = await subirFoto(entrandoComo("duena"), "NAT-M", PNG);
    expect(r.estado).toBe(201);

    const v = await real.DB.prepare("SELECT imagen FROM variantes WHERE codigo = 'NAT-M'")
      .first<{ imagen: string }>();
    expect(v?.imagen).toMatch(/^\/foto\/catalogo\/NAT-M\//);
  });

  it("queda marcada NO sensible: es lo que la deja salir sin sesión", async () => {
    await sembrarCatalogo();
    await subirFoto(entrandoComo("duena"), "NAT-M", PNG);
    const a = await real.DB.prepare(
      "SELECT sensible, mime FROM archivos WHERE referencia_id = 'NAT-M'",
    ).first<{ sensible: number; mime: string }>();
    expect(a?.sensible).toBe(0);
    expect(a?.mime).toBe("image/png");
  });

  it("el tipo sale de los BYTES, no de lo que diga el navegador", async () => {
    await sembrarCatalogo();
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    // El navegador jura que es una imagen. Los bytes dicen que no.
    const r = await subirFoto(entrandoComo("duena"), "NAT-M", html.buffer as ArrayBuffer, "image/webp");
    expect(r.estado).toBe(400);

    const a = await real.DB.prepare("SELECT COUNT(*) AS n FROM archivos").first<{ n: number }>();
    expect(a?.n, "no se guardó nada").toBe(0);
  });

  it("al cambiar la foto, la vieja se marca para borrar", async () => {
    await sembrarCatalogo();
    const primera = await subirFoto(entrandoComo("duena"), "NAT-M", PNG);
    const claveVieja = ((primera.cuerpo as { datos: { imagen: string } }).datos.imagen).slice(5);

    await subirFoto(entrandoComo("duena"), "NAT-M", PNG);

    const vieja = await real.DB.prepare("SELECT borrar_despues_de FROM archivos WHERE r2_key = ?")
      .bind(claveVieja)
      .first<{ borrar_despues_de: number | null }>();
    // Si no se marcara, cada cambio de foto dejaría una ocupando para siempre:
    // la basura que el dueño pidió que no se acumulara.
    expect(vieja?.borrar_despues_de).not.toBeNull();
  });

  it("un rol que no edita precios no puede subir fotos", async () => {
    await sembrarCatalogo();
    const r = await subirFoto(entrandoComo("asistente"), "NAT-M", PNG);
    expect(r.estado).toBe(403);
  });

  it("una imagen enorme se rechaza con 413, no con un error raro", async () => {
    await sembrarCatalogo();
    const grande = new Uint8Array(6 * 1024 * 1024);
    grande.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = await subirFoto(entrandoComo("duena"), "NAT-M", grande.buffer as ArrayBuffer);
    expect(r.estado).toBe(413);
  });

  it("no se le pone foto a un producto que no existe", async () => {
    await sembrarCatalogo();
    const r = await subirFoto(entrandoComo("duena"), "NO-EXISTE", PNG);
    expect(r.estado).toBe(404);
  });
});
