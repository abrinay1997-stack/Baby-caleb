import { createExecutionContext } from "cloudflare:test";
import { env as real } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "./actor";
import { SistemaCRM } from "./crm";
import { SistemaWeb } from "./web";

/**
 * Los entrypoints RPC, contra una D1 de verdad y con la carga inicial puesta.
 *
 * Lo que se vigila aquí no es que las consultas corran: es la frontera. Al otro
 * lado del service binding puede estar la dueña o puede estar el bot
 * contestándole a una clienta, y el sistema solo sabe lo que el CRM diga. Si
 * esa comprobación cede, un mensaje de WhatsApp puede ajustar el inventario.
 */

// `WorkerEntrypoint` exige un contexto de verdad: en producción se lo da el
// service binding, y aquí lo da el runner.
const crm = () => new SistemaCRM(createExecutionContext(), real as Env);
const web = () => new SistemaWeb(createExecutionContext(), real as Env);

const DUENA: Actor = { tipo: "duena", id: "9999", canal: "telegram" };
const BOT: Actor = { tipo: "bot", id: "9999", canal: "whatsapp_qr" };

let n = 0;
const clave = () => `idem-${Date.now()}-${n++}`;

beforeEach(async () => {
  await real.DB.prepare("DELETE FROM usuarios").run();
  await real.DB.prepare(
    "INSERT INTO usuarios (id,correo,nombre,rol,telegram_chat_id,activo,creado_en) VALUES ('u-duena','duena@babycaleb.com','Yarielis','duena','9999',1,?)",
  )
    .bind(Date.now())
    .run();
  // Este runner NO aísla el almacenamiento entre pruebas del mismo archivo, y
  // los movimientos no se pueden borrar para limpiar (el trigger lo prohíbe,
  // que es justo lo que se quiere). Así que cada prueba parte del mismo
  // inventario a propósito: sin esto, una prueba que sube el stock de NAT-L
  // hace pasar en verde a otra que debía fallar por falta de existencias.
  await real.DB.batch([
    real.DB.prepare("UPDATE existencias SET fisico = 0, reservado = 0"),
    real.DB.prepare("UPDATE variantes SET publicado = 0"),
    real.DB.prepare("UPDATE variantes SET publicado = 1 WHERE codigo = 'NAT-M'"),
    real.DB.prepare(
      "UPDATE existencias SET fisico = 20 WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ),
  ]);
});

describe("SistemaWeb · lo que llega a un navegador", () => {
  it("devuelve lo publicado, con precio y etiqueta", async () => {
    const r = await web().catalogo();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const m = r.datos.variantes.find((v) => v.codigo === "NAT-M");
    expect(m?.precioCents).toBe(5000);
    expect(m?.disponibilidad).toBe("disponible");
  });

  it("NUNCA el costo ni la cantidad exacta", async () => {
    // Lo primero es interno; lo segundo lo decidió el dueño y está en el CRM
    // desde siempre: la clienta no necesita saber que quedan 3, necesita saber
    // que si lo quiere lo pida ya. Y decir el número es regalarle a cualquiera
    // el inventario del negocio.
    const r = await web().catalogo();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const texto = JSON.stringify(r.datos);
    expect(texto).not.toMatch(/costo|fisico|reservado|libres/i);
    expect(texto).not.toContain("20");
  });

  it("lo NO publicado no sale, aunque esté activo y con existencias", async () => {
    // Es el interruptor que permite cargar el catálogo a medias sin que se vea.
    await real.DB.prepare(
      "UPDATE existencias SET fisico = 50 WHERE codigo = 'NAT-L' AND bodega_id = 'bod-1'",
    ).run();
    const r = await web().catalogo();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.variantes.map((v) => v.codigo)).not.toContain("NAT-L");
  });

  it("sin existencias dice agotado, no «no se sabe»", async () => {
    await real.DB.prepare("UPDATE variantes SET publicado = 1 WHERE codigo = 'NAT-L'").run();
    const r = await web().catalogo();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.variantes.find((v) => v.codigo === "NAT-L")?.disponibilidad).toBe("agotado");
  });

  it("las zonas salen con sus alias y sin inventar tarifas", async () => {
    const r = await web().zonasEnvio();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const tocumen = r.datos.find((z) => z.nombre === "Tocumen");
    expect(tocumen?.tarifaCents).toBe(800);

    const oeste = r.datos.find((z) => z.nombre === "Panamá Oeste");
    expect(oeste?.tarifaCents).toBeNull();
    expect(oeste?.alias).toContain("Arraiján");
  });
});

describe("SistemaCRM · el catálogo del bot", () => {
  it("busca por nombre, por código y por producto", async () => {
    for (const q of ["NAT-M", "nateen", "talla m"]) {
      const r = await crm().buscarCatalogo(q);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.datos.map((v) => v.codigo), `«${q}» no encontró NAT-M`).toContain("NAT-M");
    }
  });

  it("pone primero lo que EMPIEZA por lo buscado", async () => {
    // Quien escribe «NAT-M» espera NAT-M, no «... compatible con NAT-M».
    const r = await crm().buscarCatalogo("NAT-M");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos[0]?.codigo).toBe("NAT-M");
  });

  it("no se traga los comodines de LIKE", async () => {
    // `%` y `_` son los comodines: sin quitarlos, quien escribe «%» recibe el
    // catálogo entero como si cada artículo fuera un acierto de su búsqueda.
    // Quitados no queda nada que buscar, así que se comporta como una búsqueda
    // vacía —lo mismo que `listarCatalogo`— y no como un comodín.
    const comodin = await crm().buscarCatalogo("%");
    const vacia = await crm().buscarCatalogo("");
    const todo = await crm().listarCatalogo();
    expect(comodin.ok && vacia.ok && todo.ok).toBe(true);
    if (!comodin.ok || !vacia.ok || !todo.ok) return;

    expect(comodin.datos).toEqual(vacia.datos);
    expect(comodin.datos).toEqual(todo.datos);
  });

  it("una búsqueda que no encuentra nada devuelve nada", async () => {
    const r = await crm().buscarCatalogo("bicicleta");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toEqual([]);
  });

  it("«¿alcanza para 30?» se contesta sin soltar el número", async () => {
    // Hay 20. Para 15 alcanza, y entonces el número NO sale: basta un sí.
    const r = await crm().buscarCatalogo("NAT-M", 10, 15);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos[0]?.pedido).toEqual({ cantidadPedida: 15, alcanza: true });
    expect(JSON.stringify(r.datos[0]?.pedido)).not.toContain("20");
  });

  it("y cuando NO alcanza, sí: «de 30 no, de 20 sí» es la respuesta útil", async () => {
    const r = await crm().buscarCatalogo("NAT-M", 10, 30);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos[0]?.pedido).toEqual({
      cantidadPedida: 30,
      alcanza: false,
      maximoDisponible: 20,
    });
  });

  it("sin preguntar por cantidad, no viene ningún número", async () => {
    const r = await crm().buscarCatalogo("NAT-M");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos[0]).not.toHaveProperty("pedido");
  });

  it("una cantidad absurda se rechaza en vez de tratarse como «ninguna»", async () => {
    // Contestar un 0 o un -5 como si no hubieran preguntado nada esconde el
    // error y el bot afirma que «alcanza».
    for (const mala of [0, -5, 1.5, Number.NaN]) {
      const r = await crm().buscarCatalogo("NAT-M", 10, mala);
      expect(r.ok, `aceptó ${mala}`).toBe(false);
    }
  });

  it("tampoco el costo", async () => {
    const r = await crm().listarCatalogo();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.datos)).not.toMatch(/costo/i);
  });
});

describe("SistemaCRM · cotizar un envío", () => {
  it("da la tarifa exacta de una zona que existe", async () => {
    const r = await crm().cotizarEnvio("tocumen");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toMatchObject({ zona: "Tocumen", tarifaCents: 800 });
  });

  it("encuentra por alias y sin tildes", async () => {
    // Quien escribe por WhatsApp no pone tildes. Esto es lo que falló en
    // producción cuando el tarifario vivía en la base de conocimiento.
    const r = await crm().cotizarEnvio("loteria");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toMatchObject({ zona: "La Lotería" });
  });

  it("de Panamá Oeste dice la zona pero NO una tarifa", async () => {
    // El documento dice «de $3 a $6 según la distancia». Inventar el punto
    // medio sería inventar un precio.
    const r = await crm().cotizarEnvio("arraijan");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toMatchObject({ zona: "Panamá Oeste", tarifaCents: null });
  });

  it("lo que no está devuelve sugerencias, nunca un número", async () => {
    const r = await crm().cotizarEnvio("un sitio que no existe");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toHaveProperty("zona", null);
    expect(JSON.stringify(r.datos)).not.toMatch(/tarifaCents/);
  });
});

describe("la frontera: el bot NO es la dueña", () => {
  const prohibidas: [string, () => Promise<{ ok: boolean }>][] = [
    ["stockDetallado", () => crm().stockDetallado(BOT)],
    ["movimientos", () => crm().movimientos(BOT)],
    ["registrarVenta", () =>
      crm().registrarVenta(BOT, { idempotencia: clave(), lineas: [{ codigo: "NAT-M", cantidad: 1 }], pagado: "todo" })],
    ["ajustarStock", () =>
      crm().ajustarStock(BOT, { idempotencia: clave(), codigo: "NAT-M", bodega: "Bodega Ciudad de Panamá", modo: "sumar", cantidad: 1, motivo: "x" })],
    ["registrarDevolucion", () =>
      crm().registrarDevolucion(BOT, { idempotencia: clave(), codigo: "NAT-M", cantidad: 1, vuelveAlInventario: true, motivo: "x" })],
    ["deshacer", () => crm().deshacer(BOT, "lo-que-sea")],
  ];

  for (const [nombre, llamar] of prohibidas) {
    it(`el bot no puede ${nombre}`, async () => {
      const r = (await llamar()) as { ok: false; codigo?: string };
      expect(r.ok, `${nombre} dejó pasar al bot`).toBe(false);
      expect(r.codigo).toBe("no_autorizado");
    });
  }

  it("y el inventario no se movió ni un poco", async () => {
    // La prueba de verdad: que el rechazo no haya escrito nada antes de
    // rechazar.
    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(20);
  });

  it("un chat que no está en usuarios tampoco pasa, aunque diga ser la dueña", async () => {
    // El `actor` lo manda quien llama: no es una credencial. Lo que lo hace
    // cierto es la fila en `usuarios`.
    const r = await crm().stockDetallado({ tipo: "duena", id: "1234", canal: "telegram" });
    expect(r.ok).toBe(false);
  });

  it("ni un usuario desactivado", async () => {
    await real.DB.prepare("UPDATE usuarios SET activo = 0 WHERE id = 'u-duena'").run();
    const r = await crm().stockDetallado(DUENA);
    expect(r.ok).toBe(false);
  });

  it("ni alguien que sí entra al panel pero no es la dueña", async () => {
    await real.DB.prepare(
      "INSERT INTO usuarios (id,correo,nombre,rol,telegram_chat_id,activo,creado_en) VALUES ('u-asis','a@b.com','Asistente','asistente','7777',1,?)",
    )
      .bind(Date.now())
      .run();
    const r = await crm().ajustarStock(
      { tipo: "usuario", id: "7777", canal: "telegram" },
      { idempotencia: clave(), codigo: "NAT-M", bodega: "Bodega Ciudad de Panamá", modo: "sumar", cantidad: 1, motivo: "x" },
    );
    expect(r.ok).toBe(false);
  });
});

describe("registrar una venta", () => {
  it("descuenta y devuelve las etiquetas de DESPUÉS", async () => {
    const r = await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [{ codigo: "NAT-M", cantidad: 18 }],
      pagado: "todo",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Quedan 2: la etiqueta tiene que decir «pocas», no la de antes de vender.
    expect(r.datos.etiquetas["NAT-M"]).toBe("pocas");

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(2);
  });

  it("no deja vender más de lo que hay", async () => {
    const r = await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [{ codigo: "NAT-M", cantidad: 999 }],
      pagado: "todo",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("sin_stock");
  });

  it("y si una línea no alcanza, NO pasa ninguna", async () => {
    // Todo o nada. Sin esto, media venta sale del inventario y la otra media
    // no, y el descuadre aparece semanas después en un conteo.
    const r = await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [
        { codigo: "NAT-M", cantidad: 1 },
        { codigo: "NAT-L", cantidad: 5 },
      ],
      pagado: "todo",
    });
    expect(r.ok).toBe(false);

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(20);
  });

  it("la misma idempotencia no descuenta dos veces", async () => {
    // La consola reintenta, la red se corta y un botón se toca dos veces.
    const k = clave();
    const uno = await crm().registrarVenta(DUENA, {
      idempotencia: k,
      lineas: [{ codigo: "NAT-M", cantidad: 3 }],
      pagado: "todo",
    });
    const dos = await crm().registrarVenta(DUENA, {
      idempotencia: k,
      lineas: [{ codigo: "NAT-M", cantidad: 3 }],
      pagado: "todo",
    });

    expect(uno.ok && dos.ok).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect(dos.datos.numero).toBe(uno.datos.numero);

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(17);
  });

  it("queda escrito quién la hizo", async () => {
    await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [{ codigo: "NAT-M", cantidad: 1 }],
      pagado: "todo",
    });
    const m = await real.DB.prepare(
      "SELECT actor FROM movimientos_inventario WHERE codigo='NAT-M' AND tipo='venta' ORDER BY creado_en DESC LIMIT 1",
    ).first<{ actor: string }>();
    expect(m?.actor).toContain("u-duena");
  });
});

describe("ajustar el stock", () => {
  it("fijar traduce a la diferencia, no reescribe el número", async () => {
    // El libro sigue siendo una suma de movimientos. Reescribir el número
    // dejaría un stock sin historia que lo explique.
    const r = await crm().ajustarStock(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      bodega: "Bodega Ciudad de Panamá",
      modo: "fijar",
      cantidad: 12,
      motivo: "conteo del lunes",
    });
    expect(r.ok).toBe(true);

    const m = await real.DB.prepare(
      "SELECT delta, motivo FROM movimientos_inventario WHERE codigo='NAT-M' AND tipo='ajuste' ORDER BY creado_en DESC LIMIT 1",
    ).first<{ delta: number; motivo: string }>();
    expect(m?.delta).toBe(-8); // de 20 a 12
    expect(m?.motivo).toBe("conteo del lunes");
  });

  it("sin motivo no se ajusta", async () => {
    // Un ajuste sin motivo es un descuadre sin explicación, y dentro de un mes
    // nadie se acuerda.
    const r = await crm().ajustarStock(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      bodega: "Bodega Ciudad de Panamá",
      modo: "sumar",
      cantidad: 1,
      motivo: "   ",
    });
    expect(r.ok).toBe(false);
  });

  it("fijar al número que ya hay se dice, no se escribe un movimiento de cero", async () => {
    const r = await crm().ajustarStock(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      bodega: "Bodega Ciudad de Panamá",
      modo: "fijar",
      cantidad: 20,
      motivo: "conteo",
    });
    expect(r.ok).toBe(false);
  });

  it("una bodega que no existe se dice claro", async () => {
    const r = await crm().ajustarStock(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      bodega: "Bodega Inventada",
      modo: "sumar",
      cantidad: 1,
      motivo: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("no_encontrado");
  });
});

describe("devoluciones", () => {
  it("lo que vuelve y sirve, se repone", async () => {
    const r = await crm().registrarDevolucion(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      cantidad: 2,
      vuelveAlInventario: true,
      motivo: "se arrepintió",
    });
    expect(r.ok).toBe(true);

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(22);
  });

  it("lo que vuelve y NO sirve deja dos movimientos: volvió y se perdió", async () => {
    // Uno solo contaría la mitad de lo que pasó.
    const r = await crm().registrarDevolucion(DUENA, {
      idempotencia: clave(),
      codigo: "NAT-M",
      cantidad: 2,
      vuelveAlInventario: false,
      motivo: "caja mojada",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { results } = await real.DB.prepare(
      "SELECT tipo, delta FROM movimientos_inventario WHERE referencia_id = ? ORDER BY tipo",
    )
      .bind(r.datos.deshacerId)
      .all<{ tipo: string; delta: number }>();

    expect(results.map((m) => m.tipo)).toEqual(["devolucion", "merma"]);
    expect(results.reduce((s, m) => s + m.delta, 0)).toBe(0);

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(20);
  });
});

describe("deshacer", () => {
  it("escribe lo contrario, no borra nada", async () => {
    const venta = await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [{ codigo: "NAT-M", cantidad: 5 }],
      pagado: "todo",
    });
    expect(venta.ok).toBe(true);
    if (!venta.ok) return;

    const r = await crm().deshacer(DUENA, venta.datos.deshacerId);
    expect(r.ok).toBe(true);

    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(20);

    // La venta sigue en los libros: deshacer no la borra.
    const sigue = await real.DB.prepare(
      "SELECT COUNT(*) n FROM movimientos_inventario WHERE referencia_id = ?",
    )
      .bind(venta.datos.deshacerId)
      .first<{ n: number }>();
    expect(sigue?.n).toBe(1);
  });

  it("deshacer dos veces no duplica", async () => {
    const venta = await crm().registrarVenta(DUENA, {
      idempotencia: clave(),
      lineas: [{ codigo: "NAT-M", cantidad: 5 }],
      pagado: "todo",
    });
    if (!venta.ok) return;

    await crm().deshacer(DUENA, venta.datos.deshacerId);
    const segunda = await crm().deshacer(DUENA, venta.datos.deshacerId);

    expect(segunda.ok).toBe(false);
    const e = await real.DB.prepare(
      "SELECT fisico FROM existencias WHERE codigo = 'NAT-M' AND bodega_id = 'bod-1'",
    ).first<{ fisico: number }>();
    expect(e?.fisico).toBe(20);
  });

  it("un identificador que no existe no hace nada", async () => {
    const r = await crm().deshacer(DUENA, "no-existe");
    expect(r.ok).toBe(false);
  });
});

describe("clientes por identidad", () => {
  it("el mismo chat devuelve siempre la misma clienta", async () => {
    const uno = await crm().clientePorIdentidad({ canal: "whatsapp_qr", idExterno: "50761111111" });
    const dos = await crm().clientePorIdentidad({ canal: "whatsapp_qr", idExterno: "50761111111" });
    expect(uno.ok && dos.ok).toBe(true);
    if (!uno.ok || !dos.ok) return;
    expect(dos.datos.clienteId).toBe(uno.datos.clienteId);
    expect(dos.datos.nuevo).toBe(false);
  });

  it("un celular que ya tiene dueña PROPONE la fusión, no la hace", async () => {
    // Juntar dos clientas es irreversible: lo decide una persona (02-datos §6).
    const cel = `5076${Date.now() % 10_000_000}`;
    await real.DB.prepare(
      "INSERT INTO clientes (id,nombre,celular_e164,creado_en,actualizado_en) VALUES (?,?,?,?,?)",
    )
      .bind(`c-${cel}`, "Ana", cel, Date.now(), Date.now())
      .run();

    const r = await crm().clientePorIdentidad({
      canal: "instagram",
      idExterno: `ig-${cel}`,
      celular: cel,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.datos.nuevo).toBe(true);
    expect(r.datos.fusionPropuesta).toBe(`c-${cel}`);
    // Y la clienta nueva es OTRA: nadie fusionó nada por su cuenta.
    expect(r.datos.clienteId).not.toBe(`c-${cel}`);
  });

  it("sigue la cadena cuando ya hubo una fusión", async () => {
    const t = Date.now();
    await real.DB.batch([
      real.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES ('c-vieja','Ana',?,?)").bind(t, t),
      real.DB.prepare("INSERT INTO clientes (id,nombre,creado_en,actualizado_en) VALUES ('c-nueva','Ana',?,?)").bind(t, t),
      real.DB.prepare("UPDATE clientes SET fusionado_en_id = 'c-nueva' WHERE id = 'c-vieja'"),
      real.DB.prepare("INSERT INTO identidades (canal,id_externo,cliente_id,creado_en) VALUES ('telegram','tg-1','c-vieja',?)").bind(t),
    ]);

    const r = await crm().clientePorIdentidad({ canal: "telegram", idExterno: "tg-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clienteId).toBe("c-nueva");
  });
});
