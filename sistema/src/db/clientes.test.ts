import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buscar,
  editar,
  encontrarOCrear,
  leerFicha,
  loQueFalta,
  normalizarCelular,
} from "./clientes";

const T = 1_800_000_000_000;
const ctx = { db: real.DB, ahora: T, actor: "duena@babycaleb.com" };

beforeEach(async () => {
  await real.DB.prepare("DELETE FROM clientes WHERE id LIKE 'cl-prueba%' OR celular_e164 LIKE '5079%'").run();
});

describe("normalizarCelular", () => {
  /**
   * Tres formas de teclear el mismo número tienen que llegar a la misma fila.
   * Si no, el formato de tecleo crea clientas nuevas, que es exactamente el
   * duplicado que este módulo existe para evitar — entrando por detrás.
   */
  it("lleva las formas de teclear un celular panameño al mismo número", () => {
    for (const crudo of ["60000001", "6000-0001", "6000 0001", "+507 6000-0001", "50760000001"]) {
      expect(normalizarCelular(crudo), crudo).toBe("50760000001");
    }
  });

  it("rechaza lo que no es un número de teléfono", () => {
    for (const malo of ["", "   ", "abc", "12", "1234567890123456789"]) {
      expect(normalizarCelular(malo), malo).toBeNull();
    }
  });
});

describe("encontrarOCrear: la defensa contra los duplicados", () => {
  it("la segunda vez devuelve la MISMA clienta, no una nueva", async () => {
    const a = await encontrarOCrear(ctx, { nombre: "Rosa Sánchez", celular: "6999-0001" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.datos.nuevo).toBe(true);

    // La misma persona, apuntada distinto y escrita distinta: pasa a menudo
    // cuando quien atiende no se acuerda de si ya la tenía.
    const b = await encontrarOCrear(ctx, { nombre: "rosa e.", celular: "+507 6999 0001" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.datos.nuevo).toBe(false);
    expect(b.datos.clienteId).toBe(a.datos.clienteId);

    const cuantas = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM clientes WHERE celular_e164 = '50769990001'",
    ).first<{ n: number }>();
    expect(cuantas?.n).toBe(1);
  });

  it("no pisa el nombre que ya estaba", async () => {
    const a = await encontrarOCrear(ctx, { nombre: "Rosa Sánchez", celular: "6999-0002" });
    expect(a.ok).toBe(true);
    await encontrarOCrear(ctx, { nombre: "rosa", celular: "6999-0002" });

    const f = await real.DB.prepare(
      "SELECT nombre FROM clientes WHERE celular_e164 = '50769990002'",
    ).first<{ nombre: string }>();
    // El nombre completo vale más que el apunte rápido de la segunda vez.
    expect(f?.nombre).toBe("Rosa Sánchez");
  });

  it("una clienta fusionada devuelve la ficha que quedó viva", async () => {
    const vieja = await encontrarOCrear(ctx, { nombre: "Rosa vieja", celular: "6999-0003" });
    const nueva = await encontrarOCrear(ctx, { nombre: "Rosa buena", celular: "6999-0004" });
    expect(vieja.ok && nueva.ok).toBe(true);
    if (!vieja.ok || !nueva.ok) return;

    await real.DB.prepare("UPDATE clientes SET fusionado_en_id = ? WHERE id = ?")
      .bind(nueva.datos.clienteId, vieja.datos.clienteId)
      .run();

    // Quien marque el celular viejo tiene que llegar a la persona, no a una
    // ficha muerta sin historial.
    const otra = await encontrarOCrear(ctx, { nombre: "Rosa", celular: "6999-0003" });
    expect(otra.ok).toBe(true);
    if (!otra.ok) return;
    expect(otra.datos.clienteId).toBe(nueva.datos.clienteId);
  });

  it("exige nombre y un celular que se entienda", async () => {
    expect((await encontrarOCrear(ctx, { nombre: "  ", celular: "6999-0005" })).ok).toBe(false);
    expect((await encontrarOCrear(ctx, { nombre: "Rosa", celular: "no" })).ok).toBe(false);
  });
});

describe("buscar", () => {
  it("sin nada escrito no devuelve a nadie", async () => {
    const r = await buscar(real.DB, "   ");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clientas).toEqual([]);
  });

  it("encuentra por nombre y por celular tecleado de cualquier forma", async () => {
    await encontrarOCrear(ctx, { nombre: "Yarielis Concepción", celular: "6999-0009" });

    const porNombre = await buscar(real.DB, "yarielis");
    expect(porNombre.ok).toBe(true);
    if (!porNombre.ok) return;
    expect(porNombre.datos.clientas.some((c) => c.celular_e164 === "50769990009")).toBe(true);

    const porCelular = await buscar(real.DB, "6999 0009");
    expect(porCelular.ok).toBe(true);
    if (!porCelular.ok) return;
    expect(porCelular.datos.clientas).toHaveLength(1);
  });

  it("no enseña a las fusionadas: apuntan a otra ficha", async () => {
    const v = await encontrarOCrear(ctx, { nombre: "Fusionada Pérez", celular: "6999-0010" });
    const q = await encontrarOCrear(ctx, { nombre: "Quedó Viva", celular: "6999-0011" });
    if (!v.ok || !q.ok) return;
    await real.DB.prepare("UPDATE clientes SET fusionado_en_id = ? WHERE id = ?")
      .bind(q.datos.clienteId, v.datos.clienteId)
      .run();

    const r = await buscar(real.DB, "Fusionada");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clientas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// La ficha completa (F4.20)
//
// Identificadores PROPIOS, que se ven de prueba al leerlos. La migración 0003
// siembra el catálogo de verdad del negocio, y un choque de códigos hace
// fallar la siembra con un error que no dice de dónde viene.
//
// Gente inventada, y que se note: datos de clientas de verdad no entran en el
// repositorio, ni en el código ni en las pruebas.
// ---------------------------------------------------------------------------

const FICHA = "cli-ficha-prueba";
const OTRA = "cli-ficha-otra";
const DIR = "dir-ficha-prueba";
const DIR_OTRA = "dir-ficha-otra";
const ZONA = "zona-ficha-prueba";
const PEDIDO = "ped-ficha-prueba";
const PEDIDO_OTRA = "ped-ficha-otra";

/** Lo que ve quien SÍ puede ver el dinero. */
const conDinero = { veDinero: true, veCosto: false };

/**
 * Deja las dos fichas en el punto de partida, pase lo que pase en la prueba
 * anterior. No se borran y se vuelven a crear: tienen pedidos colgando, y una
 * llave foránea convertiría la limpieza en un fallo raro a mitad de otra
 * prueba.
 */
async function sembrarFichas(): Promise<void> {
  await real.DB.batch([
    real.DB.prepare(
      "INSERT OR IGNORE INTO zonas_envio (id,nombre,region,metodo,actualizado_en) VALUES (?,'Zona de prueba de fichas','ciudad','motorizado',?)",
    ).bind(ZONA, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,'Clienta De Prueba','50762220001',?,?)",
    ).bind(FICHA, T, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,'Otra De Prueba','50762220002',?,?)",
    ).bind(OTRA, T, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO direcciones (id,cliente_id,zona_id,texto,creado_en) VALUES (?,?,?,'Calle de prueba, casa 1',?)",
    ).bind(DIR, FICHA, ZONA, T),
    real.DB.prepare(
      "INSERT OR IGNORE INTO direcciones (id,cliente_id,zona_id,texto,creado_en) VALUES (?,?,?,'Calle de prueba, casa 2',?)",
    ).bind(DIR_OTRA, OTRA, ZONA, T),
    real.DB.prepare(
      `INSERT OR IGNORE INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
                                      subtotal_cents,total_cents,abono_minimo_cents,creado_en,actualizado_en)
       VALUES (?,'BC-FICHA-1','tok-ficha-1',?,'panel','por_abonar','sin_pago',2500,2500,1000,?,?)`,
    ).bind(PEDIDO, FICHA, T, T),
    real.DB.prepare(
      `INSERT OR IGNORE INTO pedidos (id,numero,token,cliente_id,origen,estado,estado_pago,
                                      subtotal_cents,total_cents,abono_minimo_cents,creado_en,actualizado_en)
       VALUES (?,'BC-FICHA-2','tok-ficha-2',?,'panel','por_abonar','sin_pago',900,900,1000,?,?)`,
    ).bind(PEDIDO_OTRA, OTRA, T, T),
    real.DB.prepare(
      `UPDATE clientes SET nombre = 'Clienta De Prueba', apellido = NULL, correo = NULL,
              identificacion = NULL, identificacion_tipo = NULL, notas = NULL,
              celular_e164 = '50762220001', anonimizado_en = NULL, fusionado_en_id = NULL,
              actualizado_en = ?
        WHERE id = ?`,
    ).bind(T, FICHA),
    real.DB.prepare(
      `UPDATE clientes SET anonimizado_en = NULL, fusionado_en_id = NULL WHERE id = ?`,
    ).bind(OTRA),
    real.DB.prepare(
      "UPDATE direcciones SET ciudad = NULL, provincia_iso = NULL, codigo_postal = NULL, pais = NULL WHERE id IN (?,?)",
    ).bind(DIR, DIR_OTRA),
  ]);
}

const leerColumnas = () =>
  real.DB.prepare(
    "SELECT nombre, apellido, correo, identificacion, identificacion_tipo, actualizado_en FROM clientes WHERE id = ?",
  )
    .bind(FICHA)
    .first<{
      nombre: string | null;
      apellido: string | null;
      correo: string | null;
      identificacion: string | null;
      identificacion_tipo: string | null;
      actualizado_en: number;
    }>();

const leerDireccion = (id: string) =>
  real.DB.prepare(
    "SELECT ciudad, provincia_iso, codigo_postal, pais FROM direcciones WHERE id = ?",
  )
    .bind(id)
    .first<{
      ciudad: string | null;
      provincia_iso: string | null;
      codigo_postal: string | null;
      pais: string | null;
    }>();

describe("loQueFalta", () => {
  const sinNada = {
    nombre: "Clienta De Prueba",
    apellido: null,
    correo: null,
    celular_e164: "50762220001",
    identificacion: null,
    identificacion_tipo: null,
  };

  it("dice lo que falta para la tarjeta, incluida la dirección entera", () => {
    const r = loQueFalta(sinNada, null);
    expect(r.paraTarjeta).toContain("el apellido");
    expect(r.paraTarjeta).toContain("el correo");
    expect(r.paraTarjeta).toContain("una dirección");
    // El celular sí está: lo que ya se tiene no se pide.
    expect(r.paraTarjeta).not.toContain("el celular");
  });

  it("y lo que falta para facturar, que es otra lista", () => {
    const r = loQueFalta(sinNada, null);
    expect(r.paraFactura).toContain("la cédula o el RUC");
    // El correo no hace falta para la factura de la DGI: pedirlo ahí sería
    // mandar a buscar un dato que nadie necesita para emitir.
    expect(r.paraFactura).not.toContain("el correo");
  });

  it("no da por completo un número sin decir si es cédula o RUC", () => {
    const r = loQueFalta({ ...sinNada, identificacion: "0-000-0000" }, null);
    expect(r.paraFactura).toContain("si ese número es cédula o RUC");
  });

  it("con todo puesto no falta nada", () => {
    const r = loQueFalta(
      {
        ...sinNada,
        apellido: "De Prueba",
        correo: "clienta.de.prueba@ejemplo.test",
        identificacion: "0-000-0000",
        identificacion_tipo: "cedula",
      },
      {
        id: DIR,
        zona: "Zona de prueba de fichas",
        texto: "Calle de prueba, casa 1",
        referencia: null,
        ciudad: "Ciudad de prueba",
        provincia_iso: "PA-8",
        codigo_postal: "0000",
        pais: "PA",
        activa: 1,
      },
    );
    expect(r.paraTarjeta).toEqual([]);
    expect(r.paraFactura).toEqual([]);
  });
});

describe("leerFicha", () => {
  beforeEach(sembrarFichas);

  it("trae sus datos, sus direcciones y SOLO sus pedidos", async () => {
    const r = await leerFicha(real.DB, conDinero, FICHA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos.clienta.id).toBe(FICHA);
    expect(r.datos.direcciones.map((d) => d.id)).toEqual([DIR]);
    // El pedido de la otra clienta no sale: si saliera, la ficha estaría
    // enseñando las compras de una persona en la pantalla de otra.
    expect(r.datos.pedidos.map((p) => p.id)).toEqual([PEDIDO]);
    expect(r.datos.falta.paraTarjeta).toContain("el apellido");
  });

  it("a quien no ve dinero le llega la ficha sin los totales", async () => {
    const r = await leerFicha(real.DB, { veDinero: false, veCosto: false }, FICHA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.pedidos[0]?.total_cents).toBeNull();
  });

  it("una clienta que no existe no se inventa", async () => {
    const r = await leerFicha(real.DB, conDinero, "cli-ficha-fantasma");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });
});

describe("editar: lo que hace falta para cobrar y para facturar", () => {
  beforeEach(sembrarFichas);

  it("guarda el apellido y la identificación, que no llegan por ningún otro lado", async () => {
    const r = await editar(ctx, FICHA, {
      apellido: "De Prueba",
      correo: "clienta.de.prueba@ejemplo.test",
      identificacion: "0-000-0000",
      identificacionTipo: "cedula",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const f = await leerColumnas();
    expect(f?.apellido).toBe("De Prueba");
    expect(f?.identificacion).toBe("0-000-0000");
    expect(f?.identificacion_tipo).toBe("cedula");
    expect(f?.actualizado_en).toBe(T);
  });

  /**
   * EL CASO QUE ROMPIÓ EL CATÁLOGO.
   *
   * Todas las columnas nuevas son anulables, y en SQL `apellido = NULL` no es
   * falso: es desconocido. Un control de batch que comparara con `=` daría
   * cero en cuanto un campo se deja en blanco —que es el caso normal de esta
   * pantalla— y tumbaría un guardado perfecto diciendo «error del sistema».
   *
   * Si alguien cambia el `IS` del control por `=`, esta prueba se pone roja.
   */
  it("dejar un campo EN BLANCO guarda un blanco, no un error", async () => {
    await editar(ctx, FICHA, {
      apellido: "De Prueba",
      correo: "clienta.de.prueba@ejemplo.test",
      direccion: { id: DIR, ciudad: "Ciudad de prueba", pais: "PA" },
    });

    const borrado = await editar(ctx, FICHA, {
      apellido: "",
      correo: null,
      direccion: { id: DIR, ciudad: "", pais: null },
    });
    expect(borrado.ok, JSON.stringify(borrado)).toBe(true);

    const f = await leerColumnas();
    expect(f?.apellido).toBeNull();
    expect(f?.correo).toBeNull();
    const d = await leerDireccion(DIR);
    expect(d?.ciudad).toBeNull();
    expect(d?.pais).toBeNull();
  });

  it("guarda los datos de facturación de su dirección sin tocar la calle", async () => {
    const r = await editar(ctx, FICHA, {
      direccion: { id: DIR, ciudad: "Ciudad de prueba", provinciaIso: "PA-8", codigoPostal: "0000", pais: "PA" },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const d = await leerDireccion(DIR);
    expect(d).toEqual({ ciudad: "Ciudad de prueba", provincia_iso: "PA-8", codigo_postal: "0000", pais: "PA" });

    const calle = await real.DB.prepare("SELECT texto FROM direcciones WHERE id = ?")
      .bind(DIR)
      .first<{ texto: string }>();
    // La calle es lo que lee el motorizado para llegar: esta pantalla no la toca.
    expect(calle?.texto).toBe("Calle de prueba, casa 1");
  });

  /**
   * LA FILA DE CONTROL, GANÁNDOSE EL SUELDO.
   *
   * El UPDATE lleva `WHERE id = ? AND cliente_id = ?`. Con la dirección de
   * otra clienta no casa con nada — y en D1 eso NO falla: afecta cero filas y
   * el batch sigue. Sin el control, esto respondería «guardado» con los datos
   * en ningún sitio.
   *
   * Comprobado neutralizando el control (dejándolo en `ok = 1` fijo): esta
   * prueba se pone roja y ninguna otra se entera.
   */
  it("no escribe los datos de facturación en la dirección de otra clienta", async () => {
    const r = await editar(ctx, FICHA, {
      direccion: { id: DIR_OTRA, ciudad: "Ciudad de prueba", pais: "PA" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");

    const d = await leerDireccion(DIR_OTRA);
    expect(d?.ciudad).toBeNull();
    expect(d?.pais).toBeNull();
  });

  it("un número sin decir si es cédula o RUC no entra", async () => {
    const r = await editar(ctx, FICHA, { identificacion: "0-000-0000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect(r.mensaje).toMatch(/cédula o RUC/i);
  });

  it("ni un tipo sin número: el que quedaría colgando también se mira", async () => {
    await editar(ctx, FICHA, { identificacion: "0-000-0000", identificacionTipo: "ruc" });
    // Solo se borra el número; el tipo se queda de la vez anterior.
    const r = await editar(ctx, FICHA, { identificacion: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");

    // Y no escribió a medias: el número sigue donde estaba.
    const f = await leerColumnas();
    expect(f?.identificacion).toBe("0-000-0000");
  });

  it("«pasaporte» no es un tipo de identificación de este sistema", async () => {
    const r = await editar(ctx, FICHA, {
      identificacion: "0-000-0000",
      identificacionTipo: "pasaporte",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
  });

  it("no deja a la clienta sin nombre: es como se la encuentra", async () => {
    const r = await editar(ctx, FICHA, { nombre: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("entrada_invalida");
    expect((await leerColumnas())?.nombre).toBe("Clienta De Prueba");
  });

  it("corrige el celular, y lo guarda normalizado", async () => {
    const r = await editar(ctx, FICHA, { celular: "6222-0009" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const f = await real.DB.prepare("SELECT celular_e164 FROM clientes WHERE id = ?")
      .bind(FICHA)
      .first<{ celular_e164: string }>();
    expect(f?.celular_e164).toBe("50762220009");
  });

  /**
   * El celular de otra NO es un error del sistema, y el mensaje tiene que
   * decir dónde mirar: lo más probable es que sean la misma persona con dos
   * fichas, que es justo lo que este módulo existe para evitar.
   */
  it("avisa cuando ese celular ya es de otra clienta", async () => {
    const r = await editar(ctx, FICHA, { celular: "6222-0002" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("repetido");
    expect(r.mensaje).toMatch(/otra clienta/i);
  });

  it("una clienta que no existe no se edita ni se crea", async () => {
    const r = await editar(ctx, "cli-ficha-fantasma", { apellido: "De Prueba" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");

    const cuantas = await real.DB.prepare(
      "SELECT COUNT(*) AS n FROM clientes WHERE id = 'cli-ficha-fantasma'",
    ).first<{ n: number }>();
    expect(cuantas?.n).toBe(0);
  });

  it("una ficha fusionada manda a la que quedó viva en vez de dejarse escribir", async () => {
    await real.DB.prepare("UPDATE clientes SET fusionado_en_id = ? WHERE id = ?")
      .bind(OTRA, FICHA)
      .run();
    const r = await editar(ctx, FICHA, { apellido: "De Prueba" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("transicion_invalida");
    expect(r.mensaje).toMatch(/fusion/i);
    expect((await leerColumnas())?.apellido).toBeNull();
  });

  it("una ficha anonimizada no se vuelve a llenar", async () => {
    await real.DB.prepare("UPDATE clientes SET anonimizado_en = ? WHERE id = ?")
      .bind(T, FICHA)
      .run();
    const r = await editar(ctx, FICHA, { identificacion: "0-000-0000", identificacionTipo: "cedula" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("transicion_invalida");
    expect((await leerColumnas())?.identificacion).toBeNull();
  });

  /**
   * La dirección no se cuela por la puerta de atrás.
   *
   * El UPDATE de `direcciones` no mira la ficha de la clienta —no tiene por
   * qué— así que, sin el JOIN del control, los datos de facturación de una
   * ficha anonimizada se podrían volver a llenar sin tocar `clientes`: una
   * ficha borrada a petición de la persona, otra vez con dirección.
   */
  it("tampoco llena la dirección de una ficha anonimizada", async () => {
    await real.DB.prepare("UPDATE clientes SET anonimizado_en = ? WHERE id = ?")
      .bind(T, FICHA)
      .run();
    const r = await editar(ctx, FICHA, { direccion: { id: DIR, ciudad: "Ciudad de prueba" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("transicion_invalida");
    expect((await leerDireccion(DIR))?.ciudad).toBeNull();
  });

  it("guardar sin cambiar nada no escribe nada", async () => {
    const antes = (await leerColumnas())?.actualizado_en;
    const r = await editar({ ...ctx, ahora: T + 60_000 }, FICHA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.cambiado).toBe(false);
    // `actualizado_en` sigue diciendo cuándo cambió la ficha de verdad, no
    // cuándo alguien abrió y cerró la hoja.
    expect((await leerColumnas())?.actualizado_en).toBe(antes);
  });
});
