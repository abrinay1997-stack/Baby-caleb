import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RolDePanel, Usuario } from "../seguridad";
import { type ResolverUsuario, crearPanel, panel } from "./panel";

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

// Estas pruebas parten de una base VACÍA para poder contar lo que siembran.
// Desde la migración 0003 la base trae el catálogo de verdad, así que hay que
// vaciarla, y el ORDEN importa: `zonas_envio` apunta a una bodega preferida, y
// borrar las bodegas primero rompe la llave foránea. (Lo destapó la propia
// carga inicial: antes de ella no había ninguna zona que apuntara a nada.)
beforeEach(async () => {
  await real.DB.batch([
    real.DB.prepare("DELETE FROM existencias"),
    real.DB.prepare("DELETE FROM valor_inventario"),
    real.DB.prepare("DELETE FROM variantes"),
    real.DB.prepare("DELETE FROM productos"),
    real.DB.prepare("DELETE FROM zonas_envio"),
    real.DB.prepare("DELETE FROM bodegas"),
    real.DB.prepare("DELETE FROM usuarios"),
    real.DB.prepare("DELETE FROM ajustes"),
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
  it("cuenta lo que hay y avisa de lo que se acaba", async () => {
    await sembrarCatalogo();
    const r = await pedir(entrandoComo("duena"), "/resumen");
    const d = r.cuerpo.datos as {
      variantes: number;
      bodegas: number;
      avisosSinPublicar: number;
      porAcabarse: { codigo: string; libres: number }[];
    };
    expect(d.variantes).toBe(1);
    expect(d.bodegas).toBe(1);
    expect(d.avisosSinPublicar).toBe(0);
    // 10 físicas menos 2 reservadas son 8 libres… con mínimo 5 no avisa.
    expect(d.porAcabarse).toEqual([]);
  });

  it("avisa cuando lo libre llega al mínimo, contando lo reservado", async () => {
    await sembrarCatalogo();
    await real.DB.prepare("UPDATE existencias SET reservado = 6 WHERE codigo = 'NAT-M'").run();
    const r = await pedir(entrandoComo("duena"), "/resumen");
    const d = r.cuerpo.datos as { porAcabarse: { codigo: string; libres: number }[] };
    expect(d.porAcabarse).toHaveLength(1);
    expect(d.porAcabarse[0]).toMatchObject({ codigo: "NAT-M", libres: 4 });
  });

  it("una variante sin mínimo no aparece, aunque esté en cero", async () => {
    await sembrarCatalogo();
    await real.DB.prepare(
      "UPDATE existencias SET fisico = 0, reservado = 0, minimo = NULL WHERE codigo = 'NAT-M'",
    ).run();
    const r = await pedir(entrandoComo("duena"), "/resumen");
    const d = r.cuerpo.datos as { porAcabarse: unknown[] };
    expect(d.porAcabarse).toEqual([]);
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
    const d = r.cuerpo.datos as { vigentes: { clave: string; version: number; valor: unknown }[] };
    const abono = d.vigentes.find((v) => v.clave === "abono_minimo_cents");
    expect(abono?.version).toBe(2);
    expect(abono?.valor).toBe(1000);
  });

  it("sin nada puesto devuelve la lista vacía, no un error", async () => {
    // Lo que no está puesto cae en el valor de fábrica, y eso lo resuelve la
    // pantalla: así se puede decir de dónde sale cada número.
    const r = await pedir(entrandoComo("duena"), "/ajustes");
    expect(r.estado).toBe(200);
    expect((r.cuerpo.datos as { vigentes: unknown[] }).vigentes).toEqual([]);
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

