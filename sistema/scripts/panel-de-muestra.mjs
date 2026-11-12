#!/usr/bin/env node
/**
 * Sirve el panel construido con datos de muestra, para mirarlo y auditarlo.
 *
 * Las respuestas tienen la forma EXACTA que devuelve `src/api/panel.ts` —los
 * mismos nombres de columna que salen de sus `SELECT`—, así que esto no es
 * solo un decorado: si el Worker y el panel dejan de hablar el mismo idioma,
 * `auditar-panel.mjs` lo ve aquí antes de que lo vea la dueña.
 *
 *   node scripts/panel-de-muestra.mjs        sirve en :4173
 *
 * No toca la base ni la red. Los datos son inventados a propósito: montarlo
 * contra una D1 de verdad metería datos de clientas en un proceso que existe
 * para hacer capturas.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const AQUI = dirname(new URL(import.meta.url).pathname);
const RAIZ = resolve(AQUI, "../panel/dist");
const PUERTO = Number(process.env.PUERTO ?? 4173);

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const ok = (datos) => JSON.stringify({ ok: true, datos });
const dia = 86_400_000;
const PENDIENTE = "PENDIENTE";

/**
 * Una fila de `/api/ajustes`, con la forma EXACTA de `AjusteVigente`
 * (`src/db/ajustes.ts`). Por defecto viene del valor de arranque: así una clave
 * nueva se escribe en una línea y no se olvida ningún campo.
 */
const ajuste = (clave, valor, sobre = {}) => ({
  clave,
  valor,
  pendiente: valor === PENDIENTE,
  origen: "fabrica",
  version: null,
  vigente_desde: null,
  cambiado_por: null,
  motivo: null,
  aviso: null,
  ...sobre,
});

/**
 * La matriz entera, EXACTAMENTE como la devuelve `permisosDe("duena")`.
 *
 * No se inventa: `src/api/panel.test.ts` compara estas claves con las de
 * verdad y se pone roja si se separan. Una muestra que miente sobre los
 * permisos hace que la auditoría apruebe una navegación que en producción
 * sale distinta.
 */
const PERMISOS_DUENA = {
  pedidos: "editar",
  cobros: "editar",
  costo_y_margen: "ver",
  precios_y_stock: "editar",
  compras: "editar",
  gastos: "editar",
  contabilidad: "editar",
  cierre_de_mes: "editar",
  ajustes: "editar",
};

/**
 * El resumen del inicio, en sus DOS estados.
 *
 * Con `MUESTRA=vacia` sale el de hoy —0 clientas, 0 pedidos, inventario sin
 * cargar— y sin eso sale un negocio en marcha. Hacen falta los dos: la pantalla
 * que solo se ha mirado con datos de ejemplo es una pantalla que no se ha
 * probado, y el estado vacío es el que la dueña va a ver primero.
 *
 *   node scripts/panel-de-muestra.mjs                 negocio en marcha
 *   MUESTRA=vacia node scripts/panel-de-muestra.mjs   la base de hoy
 */
const VACIA = process.env.MUESTRA === "vacia";

// Solo para inventarle fechas a la muestra. La regla del huso de verdad vive en
// `DESFASE_PANAMA_MS` (src/dominio/metricas.ts) y es la que usa el Worker; esto
// no calcula nada del negocio, dibuja un decorado.
const DESFASE_PANAMA = 5 * 60 * 60 * 1000;
const diaPanama = (ms) => new Date(ms - DESFASE_PANAMA).toISOString().slice(0, 10);
const masDias = (f, n) =>
  new Date(Date.parse(`${f}T00:00:00Z`) + n * dia).toISOString().slice(0, 10);
const medianoche = (f) => Date.parse(`${f}T00:00:00Z`) + DESFASE_PANAMA;

/** Lo que entró cada día, con forma de semana de verdad: flojo el domingo. */
const SERIE = [0, 3450, 1200, 0, 8900, 4500, 2300, 11_200, 0, 6700, 3100, 9800, 5400, 2600];

function resumenDeMuestra(nombre) {
  const ahora = Date.now();
  const hoy = diaPanama(ahora);
  const diasDesdeLunes = (new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7;
  const desdeFecha = nombre === "hoy" ? hoy : masDias(hoy, -diasDesdeLunes);
  const salto = (nombre === "hoy" ? 1 : 7) * dia;
  const periodo = {
    nombre,
    desde: medianoche(desdeFecha),
    hasta: ahora,
    desdeFecha,
    hastaFecha: hoy,
    dias: nombre === "hoy" ? 1 : diasDesdeLunes + 1,
  };
  const anterior = {
    nombre,
    desde: periodo.desde - salto,
    hasta: periodo.hasta - salto,
    desdeFecha: diaPanama(periodo.desde - salto),
    hastaFecha: diaPanama(periodo.hasta - salto),
    dias: periodo.dias,
  };

  if (VACIA) {
    return {
      ahora,
      hoy,
      periodo,
      anterior,
      avisos: { sinPublicar: 0, masViejo: null },
      atencion: {
        pedidosEnTotal: 0, porAbonar: 0, porAbonarVencidos: 0, agendadosSinDespachar: 0,
        pagosPorRevisar: 0, pagosEsperandoClienta: 0, entregasAtrasadas: 0,
        entregasFallidas: 0, paradasDeHoySinAsignar: 0, rutasDeHoySinSalir: 0,
      },
      actividad: {
        pedidosNuevos: 0, pedidosNuevosAnterior: 0, clientasNuevas: 0,
        clientasNuevasAnterior: 0, clientasEnTotal: 0,
      },
      // Treinta y seis filas en cero y ningún movimiento: las creó la carga
      // inicial, no es que se haya vendido todo.
      inventario: { cargado: false, filas: 36, sinMinimo: 36 },
      dinero: {
        entro: 0, entroAnterior: 0, pagosSinFecha: 0,
        entregado: { total: 0, pedidos: 0 },
        entregadoAnterior: { total: 0, pedidos: 0 },
        devueltos: 0,
        porCobrar: { total: 0, pedidos: 0 },
        serie: [],
      },
    };
  }

  const deLaSemana = nombre === "semana";
  return {
    ahora,
    hoy,
    periodo,
    anterior,
    // Distinto de cero a propósito: es la tarjeta que solo aparece cuando algo
    // va mal, y si nunca se ve no se sabe si está bien escrita.
    avisos: { sinPublicar: 2, masViejo: ahora - 23 * 60_000 },
    atencion: {
      pedidosEnTotal: 312,
      porAbonar: 6,
      porAbonarVencidos: 2,
      agendadosSinDespachar: 3,
      pagosPorRevisar: 4,
      pagosEsperandoClienta: 1,
      entregasAtrasadas: 1,
      entregasFallidas: 2,
      paradasDeHoySinAsignar: 5,
      rutasDeHoySinSalir: 1,
    },
    actividad: {
      pedidosNuevos: deLaSemana ? 23 : 4,
      pedidosNuevosAnterior: deLaSemana ? 19 : 6,
      clientasNuevas: deLaSemana ? 7 : 1,
      clientasNuevasAnterior: deLaSemana ? 7 : 0,
      clientasEnTotal: 247,
    },
    inventario: {
      cargado: true,
      filas: 118,
      sinMinimo: 41,
      unidades: 466,
      reservadas: 54,
      agotadas: 3,
      porAcabarse: 4,
      lista: [
        { codigo: "BC-003-RN", nombre: "Gorro de punto recién nacido", bodega: "Principal", libres: 0, minimo: 3 },
        { codigo: "BC-007-U", nombre: "Babero impermeable", bodega: "Casa", libres: 0, minimo: null },
        { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", bodega: "Principal", libres: 2, minimo: 6 },
        { codigo: "BC-011-6M", nombre: "Pijama de algodón 6 meses", bodega: "Casa", libres: 4, minimo: 4 },
      ],
      listaTruncada: false,
    },
    dinero: {
      entro: deLaSemana ? 38_900 : 7450,
      entroAnterior: deLaSemana ? 31_200 : 9800,
      // Uno sin ubicar, para que se vea la tarjeta que lo avisa.
      pagosSinFecha: 1,
      entregado: deLaSemana ? { total: 42_300, pedidos: 9 } : { total: 9900, pedidos: 2 },
      entregadoAnterior: deLaSemana ? { total: 51_000, pedidos: 11 } : { total: 4500, pedidos: 1 },
      devueltos: deLaSemana ? 1 : 0,
      porCobrar: { total: 27_650, pedidos: 8 },
      serie: SERIE.map((centavos, i) => ({ fecha: masDias(hoy, i - (SERIE.length - 1)), centavos })),
    },
  };
}

/**
 * Un asiento del libro con sus líneas, para no repetir la forma ocho veces.
 *
 * `totalCents` es la suma de un lado —los dos dan lo mismo, porque cuadra— y
 * se pasa a mano en vez de calcularlo: si un día una línea se escribe mal, el
 * total deja de coincidir y la pantalla lo enseña, que es lo que se quiere de
 * unos datos de muestra de contabilidad.
 */
const asiento = (id, fecha, descripcion, origen, hecho, totalCents, lineas, extra = {}) => ({
  id,
  fecha,
  descripcion,
  origen,
  hecho,
  referenciaTipo: null,
  referenciaId: null,
  revierteId: null,
  revertido: false,
  creadoPor: "yarielis@babycaleb.com",
  creadoEn: Date.parse(`${fecha}T15:00:00Z`),
  totalCents,
  lineas: lineas.map(([codigo, cuenta, debeCents, haberCents]) => ({
    codigo,
    cuenta,
    debeCents,
    haberCents,
    detalle: null,
  })),
  ...extra,
});

/**
 * Las clientas de muestra, con los TRES estados que la pantalla pinta
 * distinto: una a la que le falta casi todo, una que ya está lista para
 * cobrarle con tarjeta, y una sin dirección ni pedidos.
 *
 * Gente inventada y que se nota: nombres «de muestra», correos en `.test`
 * —que es un dominio reservado, no le llega a nadie— y cédulas de ceros.
 * Datos de clientas de verdad no entran en el repositorio, y menos en un
 * guion que existe para hacer capturas.
 *
 * El nombre largo es a propósito: una caja se rompe con el nombre largo, no
 * con «Ana».
 */
const CLIENTAS_DE_MUESTRA = [
  {
    id: "cli-muestra-1",
    nombre: "Clienta De Muestra Villarreal Quintero",
    celular_e164: "50760000101",
    pedidos: 3,
    ultimo_pedido: Date.now() - 2 * dia,
  },
  {
    id: "cli-muestra-2",
    nombre: "Clienta De Muestra Dos",
    celular_e164: "50760000102",
    pedidos: 1,
    ultimo_pedido: Date.now() - 20 * dia,
  },
  {
    id: "cli-muestra-3",
    nombre: "Clienta De Muestra Tres",
    celular_e164: "50760000103",
    pedidos: 0,
    ultimo_pedido: null,
  },
];

/**
 * La ficha de cada una, con la forma EXACTA de `leerFicha`.
 *
 * `falta` lo calcula el servidor de verdad; aquí se escribe a mano porque esto
 * no ejecuta el Worker. Si las dos listas se separaran, la auditoría estaría
 * mirando una pantalla que no existe — por eso cada una dice lo que de verdad
 * le falta a SUS datos, campo por campo.
 */
const FICHAS_DE_MUESTRA = {
  "cli-muestra-1": {
    clienta: {
      id: "cli-muestra-1",
      nombre: "Clienta De Muestra Villarreal Quintero",
      apellido: null,
      celular_e164: "50760000101",
      correo: null,
      identificacion: null,
      identificacion_tipo: null,
      notas: null,
      creado_en: Date.now() - 200 * dia,
      actualizado_en: Date.now() - 2 * dia,
      fusionado_en_id: null,
      anonimizado_en: null,
    },
    direcciones: [
      {
        id: "dir-muestra-1",
        zona: "Tocumen",
        texto: "Calle de muestra, casa 101, planta baja",
        referencia: "frente al parque de muestra",
        ciudad: null,
        provincia_iso: null,
        codigo_postal: null,
        pais: null,
        activa: 1,
      },
    ],
    pedidos: [
      { id: "ped-m-1", numero: "BC-1041", estado: "entregado", estado_pago: "pagado",
        creado_en: Date.now() - 2 * dia, lineas: 3, total_cents: 18_750, saldo_cents: 0 },
      { id: "ped-m-2", numero: "BC-1032", estado: "entregado", estado_pago: "pagado",
        creado_en: Date.now() - 40 * dia, lineas: 1, total_cents: 4_500, saldo_cents: 0 },
      { id: "ped-m-3", numero: "BC-1020", estado: "cancelado", estado_pago: "sin_pago",
        creado_en: Date.now() - 90 * dia, lineas: 2, total_cents: 9_900, saldo_cents: 9_900 },
    ],
    falta: {
      paraTarjeta: ["el apellido", "el correo", "la ciudad", "la provincia", "el código postal", "el país"],
      paraFactura: ["el apellido", "la cédula o el RUC"],
    },
  },
  "cli-muestra-2": {
    clienta: {
      id: "cli-muestra-2",
      nombre: "Clienta De Muestra",
      apellido: "Dos",
      celular_e164: "50760000102",
      correo: "clienta.dos@ejemplo.test",
      identificacion: "0-000-0000",
      identificacion_tipo: "cedula",
      notas: "Ficha de muestra, completa a propósito.",
      creado_en: Date.now() - 60 * dia,
      actualizado_en: Date.now() - dia,
      fusionado_en_id: null,
      anonimizado_en: null,
    },
    direcciones: [
      {
        id: "dir-muestra-2",
        zona: "San Francisco",
        texto: "Edificio de muestra, piso 2, apto 2B",
        referencia: null,
        ciudad: "Ciudad de muestra",
        provincia_iso: "PA-8",
        codigo_postal: "0000",
        pais: "PA",
        activa: 1,
      },
    ],
    pedidos: [
      { id: "ped-m-4", numero: "BC-1042", estado: "agendado", estado_pago: "abonado",
        creado_en: Date.now() - 20 * dia, lineas: 2, total_cents: 7_200, saldo_cents: 3_200 },
    ],
    falta: { paraTarjeta: [], paraFactura: [] },
  },
  "cli-muestra-3": {
    clienta: {
      id: "cli-muestra-3",
      nombre: "Clienta De Muestra Tres",
      apellido: null,
      celular_e164: "50760000103",
      correo: null,
      identificacion: null,
      identificacion_tipo: null,
      notas: null,
      creado_en: Date.now() - 3 * dia,
      actualizado_en: Date.now() - 3 * dia,
      fusionado_en_id: null,
      anonimizado_en: null,
    },
    direcciones: [],
    pedidos: [],
    falta: {
      paraTarjeta: ["el apellido", "el correo", "una dirección"],
      paraFactura: ["el apellido", "la cédula o el RUC"],
    },
  },
};

const RESPUESTAS = {
  "/api/yo": ok({
    usuario: {
      id: "01JBCX7K2M0000000000000000",
      correo: "duena@babycaleb.com",
      nombre: "Yarielis",
      rol: "duena",
      activo: 1,
    },
    permisos: PERMISOS_DUENA,
  }),

  // `/resumen`: la forma de `ResumenDelNegocio` (src/db/metricas.ts). Es una
  // función y no un objeto porque la pantalla pide `?periodo=` y porque tiene
  // DOS estados que hay que poder mirar (ver `resumenDeMuestra`).
  "/api/resumen": (url) =>
    ok(resumenDeMuestra(url.searchParams.get("periodo") === "semana" ? "semana" : "hoy")),

  /**
   * `/cobros`: la bandeja de comprobantes, con los cuatro casos que la
   * pantalla tiene que saber pintar distinto.
   *
   * Uno viejo (que pide atención), uno sin captura (que avisa de que no se
   * puede comprobar mirando), uno de un pedido YA ENTREGADO por un método que
   * todavía no tiene asiento para ese caso, y uno que se pasaría del total
   * (la señal de que la captura puede ser de otro pedido). Con un solo caso
   * bonito, los avisos no se ven nunca y nadie los revisa.
   */
  "/api/cobros": ok({
    hayMas: false,
    comprobantes: [
      {
        pagoId: "01JBCY0000000000000000001",
        pedidoId: "01JBCP0000000000000000001",
        numero: "BC-000412",
        cliente: "Ana Gómez",
        montoCents: 1500,
        metodo: "yappy",
        tipo: "abono",
        comprobanteR2: "comprobantes/ana.jpg",
        creadoEn: Date.now() - 3 * 60 * 60 * 1000,
        totalCents: 4650,
        pagadoCents: 0,
        estadoPedido: "por_abonar",
      },
      {
        pagoId: "01JBCY0000000000000000002",
        pedidoId: "01JBCP0000000000000000002",
        numero: "BC-000408",
        cliente: "Marielys Pérez",
        montoCents: 3150,
        metodo: "transferencia",
        tipo: "saldo",
        comprobanteR2: null,
        creadoEn: Date.now() - 2 * 24 * 60 * 60 * 1000,
        totalCents: 3150,
        pagadoCents: 0,
        estadoPedido: "agendado",
      },
      {
        pagoId: "01JBCY0000000000000000003",
        pedidoId: "01JBCP0000000000000000003",
        numero: "BC-000399",
        cliente: null,
        montoCents: 2000,
        metodo: "transferencia",
        tipo: "saldo",
        comprobanteR2: "comprobantes/sin-nombre.jpg",
        creadoEn: Date.now() - 20 * 60 * 1000,
        totalCents: 9300,
        pagadoCents: 1000,
        // Entregado: por eso este saldo no va a dejar asiento, y la ficha lo
        // avisa antes de confirmar.
        estadoPedido: "entregado",
      },
      {
        pagoId: "01JBCY0000000000000000004",
        pedidoId: "01JBCP0000000000000000004",
        numero: "BC-000387",
        cliente: "Yoselin Rodríguez de la Espriella",
        montoCents: 5000,
        metodo: "efectivo",
        tipo: "total",
        comprobanteR2: null,
        creadoEn: Date.now() - 9 * 24 * 60 * 60 * 1000,
        totalCents: 4650,
        pagadoCents: 1000,
        estadoPedido: "entregado",
      },
    ],
  }),

  /**
   * `/contabilidad` y sus cuatro hermanas.
   *
   * Esta pantalla NUNCA se había renderizado aquí, y es la que más falta hacía:
   * hasta que se engancharon los asientos, el libro diario de verdad salía
   * vacío siempre, así que nadie —ni una prueba ni una persona— había visto la
   * pantalla con datos dentro.
   *
   * LOS NÚMEROS CUADRAN ENTRE SÍ, Y ESO ES EL PUNTO. Son un mes de verdad:
   * tres abonos, dos entregas con su costo y un saldo cobrado en efectivo.
   * Ocho asientos. Si se inventan cifras sueltas, la pantalla sale bonita y no
   * se puede ver si MIENTE — que es justo lo que una pantalla de contabilidad
   * no puede hacer.
   *
   *   1101 Yappy      4 650   (abonos de BC-000412 y BC-000408)
   *   1103 Efectivo   1 000   (abono de BC-000399)
   *   1104-mot-01     3 150   (el saldo que cobró el motorizado y no ha entregado)
   *   1201 Por cobrar 8 300   (BC-000399, entregado y sin cobrar)
   *   1301 Inventario −5 700
   *   2101 Anticipos  3 150   (el abono de BC-000408, que no ha salido)
   *
   *   Activo 11 400 = pasivo 3 150 + patrimonio 0 + resultado 8 250 ✓
   *
   * **El inventario en NEGATIVO es a propósito y es el estado real de hoy.**
   * Salió mercancía que nunca entró en los libros, porque no hay asiento de
   * apertura: la fecha de arranque y los costos de apertura siguen PENDIENTES
   * de la dueña. Poner aquí un inventario positivo inventado escondería
   * exactamente lo que hay que ver antes de empezar a usar esto en serio.
   */
  /**
   * Pedidos.
   *
   * No estaba, y por eso `/pedidos` nunca se auditó: sin datos de muestra la
   * pantalla sale vacía y medirla no dice nada, así que quedó fuera de la
   * lista. El hueco se vio en un teléfono de verdad, no en CI.
   *
   * Los nombres largos son a propósito: una caja se rompe con el nombre largo,
   * no con «Ana». Si la muestra solo trae nombres cortos, la auditoría mide una
   * pantalla que no existe en la vida real.
   */
  "/api/pedidos": ok({
    pedidos: [
      // La cotización va PRIMERA, y con un nombre largo: es la fila nueva y es
      // la que nadie ha mirado todavía en un teléfono. Sin ella, el auditor
      // mediría la pantalla de pedidos sin una sola cotización y no diría nada
      // de la hoja que la confirma (docs/TRAMPAS.md §4: una pantalla que no se
      // mide no dice «está bien», no dice nada).
      {
        id: "ped-0",
        numero: "BC-1040",
        estado: "cotizacion",
        estado_pago: "sin_pago",
        cliente: "Madelaine Esther Castillo de Bethancourt",
        origen: "whatsapp",
        lineas: 2,
        creado_en: 1_794_190_000_000,
        // Sin fecha de caducidad: `cotizacion_dias_validez` está PENDIENTE, y
        // así es como se ve hoy de verdad.
        vence_en: null,
        total_cents: 12_300,
        pagado_cents: 0,
        saldo_cents: 12_300,
      },
      {
        id: "ped-1",
        numero: "BC-1041",
        estado: "por_abonar",
        estado_pago: "sin_pago",
        cliente: "María de los Ángeles Villarreal Quintero",
        origen: "web",
        lineas: 3,
        creado_en: 1_794_200_000_000,
        vence_en: 1_794_400_000_000,
        total_cents: 18_750,
        pagado_cents: 0,
        saldo_cents: 18_750,
      },
      {
        id: "ped-2",
        numero: "BC-1042",
        estado: "agendado",
        estado_pago: "abonado",
        cliente: "Yarielis Concepción",
        origen: "whatsapp",
        lineas: 1,
        creado_en: 1_794_210_000_000,
        vence_en: null,
        total_cents: 4_500,
        pagado_cents: 2_000,
        saldo_cents: 2_500,
      },
      {
        id: "ped-3",
        numero: "BC-1043",
        estado: "en_ruta",
        estado_pago: "abonado",
        cliente: "Rosa Elena Sánchez",
        origen: "instagram",
        lineas: 2,
        creado_en: 1_794_220_000_000,
        vence_en: null,
        total_cents: 9_900,
        pagado_cents: 5_000,
        saldo_cents: 4_900,
      },
      {
        id: "ped-4",
        numero: "BC-1044",
        estado: "entregado",
        estado_pago: "pagado",
        cliente: "Dayana I. Rodríguez de Hernández",
        origen: "web",
        lineas: 5,
        creado_en: 1_794_100_000_000,
        vence_en: null,
        total_cents: 32_400,
        pagado_cents: 32_400,
        saldo_cents: 0,
      },
      {
        id: "ped-5",
        numero: "BC-1045",
        estado: "cancelado",
        estado_pago: "sin_pago",
        cliente: null,
        origen: "bot",
        lineas: 1,
        creado_en: 1_794_090_000_000,
        vence_en: null,
        total_cents: null,
        pagado_cents: null,
        saldo_cents: null,
      },
      {
        id: "ped-6",
        numero: "BC-1046",
        estado: "devuelto",
        estado_pago: "reembolsado",
        cliente: "Kathia Mendoza",
        origen: "web",
        lineas: 2,
        creado_en: 1_794_080_000_000,
        vence_en: null,
        total_cents: 7_200,
        pagado_cents: 0,
        saldo_cents: 0,
      },
    ],
    hayMas: false,
  }),

  /**
   * `/checkout`: el veredicto que la pantalla de Ajustes enseña arriba.
   *
   * Es el estado REAL de hoy (2026-11-12): el interruptor encendido, tres
   * pasarelas, cero credenciales, y el carrito de la web terminando en
   * WhatsApp. Sin esta muestra, la tarjeta que explica todo eso se vería como
   * un 404 y la auditoría seguiría diciendo «sin fallas» sobre las filas que
   * ya estaban.
   */
  "/api/checkout": ok({
    interruptor: true,
    cobra: false,
    inerte: true,
    listas: [],
    enPrueba: [],
    impedimentos: [
      "Ninguna pasarela está encendida, así que no hay con qué cobrar. Se encienden una por una en Pasarelas de cobro, después de un cobro real de prueba y su reembolso.",
      "A ninguna de las 3 pasarelas se le han puesto todavía sus credenciales: Yappy · Botón de Pago, Tilopay · tarjetas y cuotas, PayPal. Las da cada pasarela cuando aprueba el comercio.",
      "El carrito de la web todavía no sabe mandar a pagar: termina en un mensaje de WhatsApp con el pedido ya escrito. Eso se programa cuando haya una pasarela con la que probarlo.",
    ],
    resumen: "Encendido, pero todavía sin efecto: la web no cobra. Abajo está lo que falta.",
    llave_maestra_puesta: true,
  }),

  "/api/contabilidad": ok({
    resumen: {
      desde: "2026-11-01",
      hasta: "2026-11-30",
      dinero: [
        { codigo: "1101", nombre: "Yappy Comercial (Banco General)", saldoCents: 4650 },
        { codigo: "1103", nombre: "Efectivo en caja", saldoCents: 1000 },
        { codigo: "1104-mot-01", nombre: "Caja de Luis", saldoCents: 3150 },
      ],
      dineroTotalCents: 8800,
      teDebenCents: 8300,
      debesCents: 3150,
      inventarioCents: -5700,
      resultados: {
        ventasCents: 12950,
        devolucionesCents: 0,
        costoDeVentasCents: 5700,
        mermasCents: 0,
        gananciaBrutaCents: 7250,
        ingresosEnvioCents: 1000,
        gastosCents: 0,
        gananciaNetaCents: 8250,
        margenBrutoBp: 5598,
        entregasSinCosto: 0,
        porCuenta: [
          { codigo: "4101", nombre: "Ventas", tipo: "ingreso", subtipo: null,
            debeCents: 0, haberCents: 12950, saldoCents: 12950 },
          { codigo: "4102", nombre: "Ingresos por envío", tipo: "ingreso", subtipo: null,
            debeCents: 0, haberCents: 1000, saldoCents: 1000 },
          { codigo: "5101", nombre: "Costo de lo vendido", tipo: "costo", subtipo: null,
            debeCents: 5700, haberCents: 0, saldoCents: 5700 },
        ],
      },
      balance: {
        activoCents: 11400, pasivoCents: 3150, patrimonioCents: 0,
        resultadoCents: 8250, diferenciaCents: 0, cuadra: true,
      },
      asientos: 8,
      asientosSinCuadre: 0,
      // Efectivo que está en la calle. A fin de mes tiene que estar en cero.
      cajasConSaldo: [{ codigo: "1104-mot-01", nombre: "Caja de Luis", saldoCents: 3150 }],
    },
    huecos: [
      { clave: "itbms", que: "Si los pañales, los wipes y los fulares llevan ITBMS, y a qué tasa cada uno.",
        quien: "La dueña con su contadora.", estado: "abierto", nota: "Hoy la columna vale 0 en los 36 artículos.",
        sinEsto: "El ITBMS no se cobra ni se separa, y la cuenta 2201 se queda vacía.",
        fuente: "05-contabilidad §2" },
      { clave: "banco", que: "En qué banco está la cuenta corriente del negocio.",
        quien: "La dueña.", estado: "abierto", nota: null,
        sinEsto: "La cuenta 1102 se sigue llamando «Banco (cuál: PENDIENTE)» en todos los informes.",
        fuente: "05-contabilidad §2" },
      { clave: "fecha_arranque", que: "El día 1 del mes en que la contabilidad arranca de verdad.",
        quien: "La dueña.", estado: "abierto",
        nota: "Mientras falte, el inventario sale en negativo: sale mercancía que nunca entró.",
        sinEsto: "No hay asiento de apertura, y los meses anteriores no se pueden dar por cerrados.",
        fuente: "05-contabilidad §7" },
      { clave: "costos_apertura", que: "Cuánto costó cada talla que hay hoy en bodega.",
        quien: "La contadora, con las facturas del proveedor.", estado: "lo_dice_una_persona", nota: null,
        sinEsto: "Las entregas salen sin costo y el margen no se puede calcular.",
        fuente: "05-contabilidad §7" },
    ],
  }),

  // Los ocho asientos del mes, en el orden en que pasaron. Cada uno cuadra.
  "/api/contabilidad/diario": ok({
    asientos: [
      asiento("01JBD1", "2026-11-03", "Abono recibido · Pedido BC-000412", "pago", "1", 1500,
        [["1101", "Yappy Comercial (Banco General)", 1500, 0], ["2101", "Anticipos de clientas", 0, 1500]],
        { referenciaTipo: "pago", referenciaId: "01JBCY0000000000000000001" }),
      asiento("01JBD2", "2026-11-05", "Abono recibido · Pedido BC-000399", "pago", "1", 1000,
        [["1103", "Efectivo en caja", 1000, 0], ["2101", "Anticipos de clientas", 0, 1000]],
        { referenciaTipo: "pago", referenciaId: "01JBCY0000000000000000005" }),
      asiento("01JBD3", "2026-11-07", "Entrega del pedido BC-000412", "entrega", "3", 4650,
        [["2101", "Anticipos de clientas", 1500, 0], ["1201", "Cuentas por cobrar a clientas", 3150, 0],
         ["4101", "Ventas", 0, 4150], ["4102", "Ingresos por envío", 0, 500]],
        { referenciaTipo: "pedido", referenciaId: "01JBCP0000000000000000001" }),
      asiento("01JBD4", "2026-11-07", "Costo de lo vendido del pedido BC-000412", "entrega", "3b", 1800,
        [["5101", "Costo de lo vendido", 1800, 0], ["1301", "Inventario", 0, 1800]],
        { referenciaTipo: "pedido", referenciaId: "01JBCP0000000000000000001" }),
      asiento("01JBD5", "2026-11-07", "Cobro del saldo del pedido BC-000412", "cobro", "4", 3150,
        [["1104-mot-01", "Caja de Luis", 3150, 0], ["1201", "Cuentas por cobrar a clientas", 0, 3150]],
        { referenciaTipo: "pago", referenciaId: "01JBCY0000000000000000006" }),
      asiento("01JBD6", "2026-11-09", "Entrega del pedido BC-000399", "entrega", "3", 9300,
        [["2101", "Anticipos de clientas", 1000, 0], ["1201", "Cuentas por cobrar a clientas", 8300, 0],
         ["4101", "Ventas", 0, 8800], ["4102", "Ingresos por envío", 0, 500]],
        { referenciaTipo: "pedido", referenciaId: "01JBCP0000000000000000003" }),
      asiento("01JBD7", "2026-11-09", "Costo de lo vendido del pedido BC-000399", "entrega", "3b", 3900,
        [["5101", "Costo de lo vendido", 3900, 0], ["1301", "Inventario", 0, 3900]],
        { referenciaTipo: "pedido", referenciaId: "01JBCP0000000000000000003" }),
      asiento("01JBD8", "2026-11-10", "Abono recibido · Pedido BC-000408", "pago", "1", 3150,
        [["1101", "Yappy Comercial (Banco General)", 3150, 0], ["2101", "Anticipos de clientas", 0, 3150]],
        { referenciaTipo: "pago", referenciaId: "01JBCY0000000000000000002" }),
    ],
  }),

  "/api/contabilidad/por-cobrar": ok({
    al: "2026-11-30",
    totalCents: 8300,
    porTramo: { "0-7": 8300, "8-30": 0, "mas-de-30": 0 },
    deudas: [
      { pedidoId: "01JBCP0000000000000000003", numero: "BC-000399", cliente: null,
        saldoCents: 8300, entregadoEl: "2026-11-09", dias: 2, tramo: "0-7" },
    ],
  }),

  // El mayor de una cuenta: se abre tocando una del resumen.
  "/api/contabilidad/cuentas/1201": ok({
    codigo: "1201",
    nombre: "Cuentas por cobrar a clientas",
    apuntes: [
      { asientoId: "01JBD3", fecha: "2026-11-07", descripcion: "Entrega del pedido BC-000412",
        hecho: "3", debeCents: 3150, haberCents: 0, detalle: "Pedido BC-000412" },
      { asientoId: "01JBD5", fecha: "2026-11-07", descripcion: "Cobro del saldo del pedido BC-000412",
        hecho: "4", debeCents: 0, haberCents: 3150, detalle: "Pedido BC-000412" },
      { asientoId: "01JBD6", fecha: "2026-11-09", descripcion: "Entrega del pedido BC-000399",
        hecho: "3", debeCents: 8300, haberCents: 0, detalle: "Pedido BC-000399" },
    ],
  }),

  /**
   * El cierre, con la mezcla de estados que de verdad va a salir.
   *
   * No se puede cerrar, y por un motivo concreto: la caja del motorizado tiene
   * $31.50 que él todavía no ha entregado. Es la casilla que hace que un
   * cierre signifique algo.
   */
  "/api/contabilidad/cierre": ok({
    mes: "2026-11",
    estadoDelMes: "abierto",
    sePuedeCerrar: false,
    mesTerminado: false,
    casillas: [
      { clave: "extracto", titulo: "Extractos del mes importados y sin líneas por cruzar",
        estado: "no_se_puede_comprobar",
        detalle: "No se ha importado ningún extracto de este mes. La importación de CSV llega con la conciliación (F5.7)." },
      { clave: "pagos", titulo: "Pagos aprobados sin conciliar", estado: "aviso",
        detalle: "4 pagos aprobados que todavía no se han cruzado con un extracto." },
      { clave: "liquidaciones", titulo: "Liquidaciones de las pasarelas recibidas",
        estado: "no_se_puede_comprobar",
        detalle: "Todavía no hay ninguna pasarela encendida: los trámites de Yappy, Tilopay y PayPal siguen en curso." },
      { clave: "cajas", titulo: "Cajas de los motorizados en cero", estado: "falta",
        detalle: "1 con saldo: Caja de Luis." },
      { clave: "sin_costo", titulo: "Pedidos entregados sin costo", estado: "ok", detalle: "Ninguno." },
      { clave: "facturas", titulo: "Compras recibidas sin factura adjunta",
        estado: "no_se_puede_comprobar", detalle: "Las compras a proveedor llegan en otra parte del sistema (F5.4)." },
      { clave: "existencias", titulo: "Las existencias cuadran con sus movimientos", estado: "ok", detalle: "Cuadran." },
      { clave: "balance", titulo: "El balance cuadra", estado: "ok",
        detalle: "Activos = pasivos + patrimonio + el resultado del periodo." },
      { clave: "venta_sin_asiento", titulo: "Todas las entregas del mes tienen su asiento de venta",
        estado: "ok", detalle: "Todas." },
      { clave: "devolucion_sin_asiento", titulo: "Todas las devoluciones del mes tienen su asiento",
        estado: "ok", detalle: "Todas." },
      { clave: "pago_sin_asiento", titulo: "Todo el dinero que entró tiene su asiento",
        estado: "ok", detalle: "Todo." },
      { clave: "cuadre", titulo: "Todos los asientos del mes tienen su cuadre", estado: "ok", detalle: "Todos." },
    ],
  }),

  /**
   * `/mcp/llaves`: las llaves de conexión de quien mira.
   *
   * Tres estados a la vez porque los tres se pintan distinto: una recién
   * creada que nunca se ha usado, una que se usa a diario, y una revocada.
   * Con una sola, la pantalla de «revocadas» no la mira nunca nadie.
   */
  "/api/mcp/llaves": ok([
    { id: "llv-1", nombre: "Mi computadora", creado_en: 1762900000000, ultimo_uso_en: 1762990000000, revocado_en: null },
    { id: "llv-2", nombre: "El servidor de la casa", creado_en: 1762700000000, ultimo_uso_en: null, revocado_en: null },
    { id: "llv-3", nombre: "La portátil vieja", creado_en: 1760000000000, ultimo_uso_en: 1761000000000, revocado_en: 1762000000000 },
  ]),

  /**
   * `/asistente`: un turno de Caleb.
   *
   * Contesta SIEMPRE lo mismo y sin llamar a ningún modelo: lo que el auditor
   * mide aquí es la hoja —sus burbujas, su campo de escribir y sus botones de
   * permiso—, no si el asistente acierta. Un modelo de verdad haría que la
   * auditoría costara dinero y diera una captura distinta cada vez.
   */
  "/api/asistente": ok({
    clase: "dijo",
    texto: "De la talla M quedan 30 cajas en la bodega principal y ninguna en la casa.",
    historial: [
      { rol: "user", contenido: "¿cuánto queda de la M?" },
      { rol: "assistant", contenido: "De la talla M quedan 30 cajas." },
    ],
    pasos: 1,
  }),

  /**
   * `/clientes`: el buscador de la pantalla de Clientas.
   *
   * Gente inventada, y que se note. La forma es la de `ClientaEnLista`
   * (src/db/clientes.ts). Con la búsqueda vacía no devuelve a nadie, igual que
   * la ruta de verdad: una lista completa de personas con su teléfono no sale
   * de un panel sin que alguien la haya pedido, y la muestra tiene que
   * enseñar ESA pantalla, no una más cómoda.
   */
  "/api/clientes": (url) =>
    ok({
      clientas: (url.searchParams.get("buscar") ?? "").trim() === "" ? [] : CLIENTAS_DE_MUESTRA,
    }),

  /**
   * `/cotizaciones`: lo que contesta el servidor al hacer una.
   *
   * La pantalla pinta la pantalla de «listo» con ESTA respuesta —el número, el
   * total, y sobre todo `aparto: false`, que es lo que le hace escribir «esto
   * no aparta mercancía»—. Sin la muestra, esa pantalla final contestaría «Sin
   * muestra para /api/cotizaciones» y el aviso que explica qué es una
   * cotización no lo vería nunca nadie.
   *
   * `venceEn` en nulo porque `cotizacion_dias_validez` está PENDIENTE: así se
   * ve el texto de «no caduca», que es el de hoy.
   */
  "/api/cotizaciones": ok({
    id: "ped-nueva",
    numero: "BC-1047",
    token: "tok-de-muestra",
    totalCents: 9_900,
    envioCents: 350,
    abonoMinimoCents: 1_000,
    requierePagoTotal: false,
    venceEn: null,
    estado: "cotizacion",
    aparto: false,
  }),

  // `/catalogo`: las columnas del SELECT, con costo porque el rol es dueña.
  "/api/catalogo": ok({
    muestraCosto: true,
    variantes: [
      // `pedir_por_whatsapp`: los TRES estados tienen que verse en la muestra.
      // `null` es «lo que diga Ajustes» y es el de casi todo; el 0 y el 1 son
      // decisiones por artículo. Una hoja que solo se ha mirado con el valor
      // de fábrica es una hoja que no se ha mirado.
      { codigo: "BC-001-03", nombre: "Body manga larga pima", talla: "0-3m", unidades_por_caja: 12,
        precio_cents: 1250, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Ropa",
        pedir_por_whatsapp: null,
        producto: "Body manga larga algodón pima", costo_unidades: 23, costo_valor_cents: 14720 },
      { codigo: "BC-001-36", nombre: "Body manga larga pima", talla: "3-6m", unidades_por_caja: 12,
        precio_cents: 1250, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Ropa",
        pedir_por_whatsapp: null,
        producto: "Body manga larga algodón pima", costo_unidades: 11, costo_valor_cents: 7040 },
      { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", talla: "Única", unidades_por_caja: 6,
        precio_cents: 2890, tasa_itbms_bp: 700, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Textil",
        pedir_por_whatsapp: 1,
        producto: "Set de 3 mantas de muselina", costo_unidades: 2, costo_valor_cents: 3020 },
      { codigo: "BC-003-RN", nombre: "Gorro de punto recién nacido", talla: "RN", unidades_por_caja: 24,
        precio_cents: 790, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Accesorios",
        pedir_por_whatsapp: null,
        producto: "Gorro de punto recién nacido", costo_unidades: 0, costo_valor_cents: 0 },
      { codigo: "BC-004-U", nombre: "Pañalera impermeable grande", talla: "Única", unidades_por_caja: 4,
        precio_cents: 4550, tasa_itbms_bp: 700, publicado: 0, activo: 0, version: 1, imagen: null, es_combo: 0, familia: "Bolsos",
        pedir_por_whatsapp: 0,
        producto: "Pañalera impermeable grande", costo_unidades: 11, costo_valor_cents: 26400 },
          {
        codigo: "BC-COMBO-1", producto: "Combo recién nacido", nombre: "Combo recién nacido",
        talla: null, unidades_por_caja: 1, precio_cents: 3500, tasa_itbms_bp: 0,
        publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 1, familia: "Combos",
        pedir_por_whatsapp: 0,
        costo_unidades: null, costo_valor_cents: null,
      },
],
  }),

  // `/existencias`: codigo, nombre, bodega_id, bodega, fisico, reservado, libres, minimo.
  "/api/existencias": ok({
    existencias: [
      { codigo: "BC-001-03", nombre: "Body manga larga pima", bodega_id: "b1", bodega: "Principal",
        fisico: 14, reservado: 2, libres: 12, minimo: 5 },
      { codigo: "BC-001-36", nombre: "Body manga larga pima", bodega_id: "b1", bodega: "Principal",
        fisico: 11, reservado: 0, libres: 11, minimo: 5 },
      { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", bodega_id: "b1", bodega: "Principal",
        fisico: 4, reservado: 2, libres: 2, minimo: 6 },
      { codigo: "BC-003-RN", nombre: "Gorro de punto recién nacido", bodega_id: "b2", bodega: "Casa",
        fisico: 0, reservado: 0, libres: 0, minimo: 3 },
      { codigo: "BC-011-6M", nombre: "Pijama de algodón 6 meses", bodega_id: "b2", bodega: "Casa",
        fisico: 4, reservado: 0, libres: 4, minimo: 4 },
      // Sin mínimo puesto: la columna tiene que aguantar el nulo.
      { codigo: "BC-004-U", nombre: "Pañalera impermeable grande", bodega_id: "b1", bodega: "Principal",
        fisico: 11, reservado: 1, libres: 10, minimo: null },
    ],
  }),

  "/api/bodegas": ok({
    bodegas: [
      { id: "b1", nombre: "Principal", activa: 1, variantes: 96, unidades: 412 },
      { id: "b2", nombre: "Casa", activa: 1, variantes: 22, unidades: 54 },
      { id: "b3", nombre: "Feria (temporal)", activa: 0, variantes: 0, unidades: 0 },
    ],
  }),

  // `/zonas`: ya con `alias` como lista (el Worker desarma `alias_json`).
  //
  // `region` y `metodo` son los del CHECK de `zonas_envio` —'ciudad' /
  // 'interior' y 'motorizado' / 'ferguson' / 'otro'— y no los que suenan bien.
  // Antes decían «Panamá Oeste» y «encomienda», que no existen: la pantalla
  // los pintaba igual porque solo los mostraba, pero la hoja de editar elige
  // entre las opciones de verdad y con un valor inventado no quedaría ninguna
  // marcada. Una muestra que miente sobre los valores aprueba una pantalla que
  // en producción sale distinta.
  //
  // `bodega_preferida_id` además del nombre: es lo que la hoja necesita para
  // dejar marcada la bodega que ya estaba.
  "/api/zonas": ok({
    zonas: [
      { id: "z1", nombre: "Ciudad de Panamá — centro", region: "ciudad", metodo: "motorizado",
        tarifa_cents: 350, requiere_pago_total: 0, activa: 1,
        bodega_preferida: "Principal", bodega_preferida_id: "b1",
        alias: ["San Francisco", "Obarrio", "Bella Vista", "El Cangrejo"] },
      { id: "z2", nombre: "Panamá Oeste", region: "ciudad", metodo: "motorizado",
        tarifa_cents: 600, requiere_pago_total: 0, activa: 1,
        bodega_preferida: "Principal", bodega_preferida_id: "b1",
        alias: ["Arraiján", "La Chorrera", "Vista Alegre"] },
      // Tarifa nula: «se cotiza a mano». Es el caso que la pantalla tiene que
      // enseñar con palabras y no con un hueco, y sin una fila así no se mira
      // nunca.
      { id: "z3", nombre: "Interior", region: "interior", metodo: "ferguson",
        tarifa_cents: null, requiere_pago_total: 1, activa: 1,
        bodega_preferida: null, bodega_preferida_id: null,
        alias: ["Chitré", "David", "Santiago", "Las Tablas"] },
      // Sin alias, y con tarifa CERO: el envío no se cobra. Al lado de la de
      // arriba se ve la diferencia entre «gratis» y «todavía no se sabe».
      { id: "z4", nombre: "Retiro en tienda", region: "ciudad", metodo: "otro",
        tarifa_cents: 0, requiere_pago_total: 0, activa: 1,
        bodega_preferida: "Principal", bodega_preferida_id: "b1", alias: [] },
      // Pausada: el otro estado de la pastilla.
      { id: "z5", nombre: "Colón", region: "interior", metodo: "otro",
        tarifa_cents: null, requiere_pago_total: 1, activa: 0,
        bodega_preferida: null, bodega_preferida_id: null, alias: ["Colon"] },
    ],
  }),

  // `/usuarios`: el `id` de Yarielis es el MISMO que devuelve `/api/yo`. La
  // hoja compara los dos para avisar «es su propia cuenta», y con ids
  // distintos ese aviso no se ve nunca en la auditoría.
  "/api/usuarios": ok({
    usuarios: [
      { id: "01JBCX7K2M0000000000000000", correo: "duena@babycaleb.com", nombre: "Yarielis", rol: "duena",
        telegram_chat_id: "123456", activo: 1, creado_en: Date.now() - 60 * dia },
      { id: "u2", correo: "tienda@babycaleb.com", nombre: "Asistente de tienda", rol: "asistente",
        telegram_chat_id: null, activo: 1, creado_en: Date.now() - 20 * dia },
      { id: "u3", correo: "contadora@externa.com", nombre: "Contadora", rol: "contadora",
        telegram_chat_id: null, activo: 0, creado_en: Date.now() - 5 * dia },
    ],
  }),

  // `/ajustes`: la lista entera que devuelve `leerVigentes`, con las tres
  // procedencias que la pantalla tiene que enseñar distinto — puesto por
  // alguien, valor de arranque, y sin decidir — más una estructura llena para
  // que el camino de las ventanas y el de las comisiones se vea de verdad.
  "/api/ajustes": ok({
    ahora: Date.now(),
    ajustes: [
      ajuste("abono_minimo_cents", 1000, {
        origen: "guardado", version: 3, vigente_desde: Date.now() - 9 * dia,
        cambiado_por: "duena@babycaleb.com", motivo: "Subió de $5 a $10 en octubre",
      }),
      ajuste("stock_bajo", 5),
      ajuste("ferguson_pago_total", true),
      // ENCENDIDO, como en producción, y a propósito.
      //
      // Antes la muestra lo traía apagado, así que la auditoría nunca veía el
      // estado que de verdad tiene la dueña delante: encendido y sin hacer
      // nada. Una muestra que esquiva el caso incómodo aprueba una pantalla
      // que en producción se lee distinto.
      ajuste("checkout_activo", true, {
        origen: "guardado", version: 1, vigente_desde: Date.now() - 40 * dia,
        cambiado_por: "duena@babycaleb.com", motivo: "Para poder cobrar en la página",
      ajuste("whatsapp_pedidos_activo", true),
      ajuste("whatsapp_numero", "50767575065", {
      }),
      ajuste("pasarelas_activas", []),
      ajuste("metodos_para_abono", ["yappy", "manual"]),
      ajuste("cotizacion_dias_validez", PENDIENTE),
      ajuste("reserva_minutos_pago_en_linea", 30, {
        origen: "guardado", version: 1, vigente_desde: Date.now() - 2 * dia,
        cambiado_por: "duena@babycaleb.com", motivo: "Media hora alcanza para pagar por Yappy",
      }),
      ajuste("reserva_horas_comprobante", PENDIENTE),
      ajuste("ventanas_entrega", [
        { id: "manana", etiqueta: "Mañana", desde: "08:00", hasta: "12:00" },
        { id: "tarde", etiqueta: "Tarde", desde: "13:00", hasta: "18:00" },
      ], {
        origen: "guardado", version: 2, vigente_desde: Date.now() - 20 * dia,
        cambiado_por: "duena@babycaleb.com", motivo: "Dos franjas, como las entregas de ahora",
      }),
      ajuste("comisiones", {
        yappy: { porcentaje_bp: 350, fijo_cents: 0, lleva_itbms: true },
        tilopay: PENDIENTE,
        paypal: PENDIENTE,
      }, {
        origen: "guardado", version: 1, vigente_desde: Date.now() - dia,
        cambiado_por: "duena@babycaleb.com", motivo: "Llegó el contrato de Yappy",
      }),
      ajuste("cancelacion_con_abono", PENDIENTE),
      ajuste("modelo_asistente", "muse-spark-1.2-contributor"),
      ajuste("modelo_respaldo", PENDIENTE),
      ajuste("ia_entrena_con_datos", true),
      ajuste("tope_ia_mensual_usd", PENDIENTE),
    ],
  }),
};

const servidor = createServer(async (pet, res) => {
  const ruta = new URL(pet.url ?? "/", "http://x").pathname;

  if (Object.hasOwn(RESPUESTAS, ruta)) {
    const respuesta = RESPUESTAS[ruta];
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(typeof respuesta === "function" ? respuesta(new URL(pet.url ?? "/", "http://x")) : respuesta);
    return;
  }
  // El veredicto de borrado, que la pantalla pide ANTES de enseñar el
  // «¿seguro?». Se responde según el código para poder ver las DOS pantallas:
  // la que borra de verdad y la que avisa de que solo se oculta. Sin esto, la
  // confirmación más delicada del panel no la mira nunca nadie.
  // La receta de un combo. Sin esto, la pantalla del combo —que es la que
  // tiene la lógica de «cuál frena»— no la mira nunca nadie.
  const receta = /^\/api\/catalogo\/variantes\/([^/]+)\/receta$/.exec(ruta);
  if (receta !== null) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      ok([
        { codigo: "BC-001-03", nombre: "Body manga larga pima", cantidad: 2, libres: 18 },
        { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", cantidad: 1, libres: 0 },
      ]),
    );
    return;
  }

  // El historial de un ajuste, que la hoja de cambiarlo pide al abrirse. Sin
  // esto, la parte que contesta «¿quién cambió esto y cuándo?» no la mira nunca
  // nadie. Se contesta con versiones para `abono_minimo_cents` y vacío para el
  // resto, que son los dos estados que la hoja enseña distinto.
  // La ficha de una clienta. Sin esto, la hoja donde se escribe la cédula —que
  // es la razón de existir de la pantalla de Clientas— no la mira nunca nadie.
  const ficha = /^\/api\/clientes\/([^/]+)$/.exec(ruta);
  if (ficha !== null) {
    const id = decodeURIComponent(ficha[1]);
    const suya = FICHAS_DE_MUESTRA[id];
    if (suya === undefined) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, codigo: "no_encontrado", mensaje: "no existe esa clienta" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(ok(suya));
    return;
  }

  const hist = /^\/api\/ajustes\/([^/]+)\/historial$/.exec(ruta);
  if (hist !== null) {
    const clave = decodeURIComponent(hist[1]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      ok({
        clave,
        versiones:
          clave === "abono_minimo_cents"
            ? [
                { version: 3, valor: 1000, vigente_desde: Date.now() - 9 * dia,
                  cambiado_por: "duena@babycaleb.com", motivo: "Subió de $5 a $10 en octubre",
                  vigente: true, futura: false },
                { version: 2, valor: 700, vigente_desde: Date.now() - 60 * dia,
                  cambiado_por: "duena@babycaleb.com", motivo: "Prueba de un mes a $7",
                  vigente: false, futura: false },
                { version: 1, valor: 500, vigente_desde: Date.now() - 120 * dia,
                  cambiado_por: "duena@babycaleb.com", motivo: "El de la KB", vigente: false,
                  futura: false },
              ]
            : [],
      }),
    );
    return;
  }

  const borrado = /^\/api\/catalogo\/variantes\/([^/]+)\/borrado$/.exec(ruta);
  if (borrado !== null) {
    const codigo = decodeURIComponent(borrado[1]);
    // BC-001-03 es el que la auditoría abre: se deja con historia, que es el
    // caso que hay que ver.
    const tieneHistoria = codigo !== "BC-SIN-HISTORIA";
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      ok(
        tieneHistoria
          ? { modo: "se_oculta", yaOculta: false, razones: ["está en 3 pedidos", "tiene 12 unidades en bodega"] }
          : { modo: "se_borra", archivos: 1, razones: [] },
      ),
    );
    return;
  }

  if (ruta.startsWith("/api/")) {
    // Una ruta del API que no está en la muestra se dice, no se inventa: si una
    // pantalla pide algo que aquí no existe, hay que añadirlo arriba.
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, codigo: "no_encontrado", mensaje: `Sin muestra para ${ruta}` }));
    return;
  }

  // Lo demás: el archivo si existe y el index si no, igual que hace el Worker
  // con `not_found_handling: single-page-application`.
  const pedido = ruta === "/" ? "/index.html" : ruta;
  const destino = resolve(join(RAIZ, pedido));
  if (!destino.startsWith(RAIZ)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const cuerpo = await readFile(destino);
    res.writeHead(200, { "content-type": TIPOS[extname(destino)] ?? "application/octet-stream" });
    res.end(cuerpo);
  } catch {
    res.writeHead(200, { "content-type": TIPOS[".html"] });
    res.end(await readFile(join(RAIZ, "index.html")));
  }
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`Panel de muestra en http://127.0.0.1:${PUERTO}`);
});
