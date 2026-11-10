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

  // `/resumen`: cuentas + `porAcabarse` (codigo, nombre, bodega, libres, minimo).
  "/api/resumen": ok({
    variantes: 118,
    bodegas: 2,
    zonas: 11,
    clientes: 247,
    // A propósito distinto de cero: es la tarjeta que solo aparece cuando algo
    // va mal, y si nunca se ve no se sabe si está bien escrita.
    avisosSinPublicar: 2,
    avisoMasViejo: Date.now() - 23 * 60_000,
    porAcabarse: [
      { codigo: "BC-003-RN", nombre: "Gorro de punto recién nacido", bodega: "Principal", libres: 0, minimo: 3 },
      { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", bodega: "Principal", libres: 2, minimo: 6 },
      { codigo: "BC-011-6M", nombre: "Pijama de algodón 6 meses", bodega: "Casa", libres: 4, minimo: 4 },
    ],
  }),

  // `/catalogo`: las columnas del SELECT, con costo porque el rol es dueña.
  "/api/catalogo": ok({
    muestraCosto: true,
    variantes: [
      { codigo: "BC-001-03", nombre: "Body manga larga pima", talla: "0-3m", unidades_por_caja: 12,
        precio_cents: 1250, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Ropa",
        producto: "Body manga larga algodón pima", costo_unidades: 23, costo_valor_cents: 14720 },
      { codigo: "BC-001-36", nombre: "Body manga larga pima", talla: "3-6m", unidades_por_caja: 12,
        precio_cents: 1250, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Ropa",
        producto: "Body manga larga algodón pima", costo_unidades: 11, costo_valor_cents: 7040 },
      { codigo: "BC-002-U", nombre: "Set de 3 mantas de muselina", talla: "Única", unidades_por_caja: 6,
        precio_cents: 2890, tasa_itbms_bp: 700, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Textil",
        producto: "Set de 3 mantas de muselina", costo_unidades: 2, costo_valor_cents: 3020 },
      { codigo: "BC-003-RN", nombre: "Gorro de punto recién nacido", talla: "RN", unidades_por_caja: 24,
        precio_cents: 790, tasa_itbms_bp: 0, publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 0, familia: "Accesorios",
        producto: "Gorro de punto recién nacido", costo_unidades: 0, costo_valor_cents: 0 },
      { codigo: "BC-004-U", nombre: "Pañalera impermeable grande", talla: "Única", unidades_por_caja: 4,
        precio_cents: 4550, tasa_itbms_bp: 700, publicado: 0, activo: 0, version: 1, imagen: null, es_combo: 0, familia: "Bolsos",
        producto: "Pañalera impermeable grande", costo_unidades: 11, costo_valor_cents: 26400 },
          {
        codigo: "BC-COMBO-1", producto: "Combo recién nacido", nombre: "Combo recién nacido",
        talla: null, unidades_por_caja: 1, precio_cents: 3500, tasa_itbms_bp: 0,
        publicado: 1, activo: 1, version: 1, imagen: null, es_combo: 1, familia: "Combos",
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
  "/api/zonas": ok({
    zonas: [
      { id: "z1", nombre: "Ciudad de Panamá — centro", region: "Panamá", metodo: "motorizado",
        tarifa_cents: 350, requiere_pago_total: 0, activa: 1, bodega_preferida: "Principal",
        alias: ["San Francisco", "Obarrio", "Bella Vista", "El Cangrejo"] },
      { id: "z2", nombre: "Panamá Oeste", region: "Panamá Oeste", metodo: "motorizado",
        tarifa_cents: 600, requiere_pago_total: 0, activa: 1, bodega_preferida: "Principal",
        alias: ["Arraiján", "La Chorrera", "Vista Alegre"] },
      { id: "z3", nombre: "Interior", region: "Interior", metodo: "encomienda",
        tarifa_cents: 900, requiere_pago_total: 1, activa: 1, bodega_preferida: null,
        alias: ["Chitré", "David", "Santiago", "Las Tablas"] },
      // Sin alias: la celda tiene que decir algo, no quedarse vacía.
      { id: "z4", nombre: "Retiro en tienda", region: "Panamá", metodo: "retiro",
        tarifa_cents: 0, requiere_pago_total: 0, activa: 1, bodega_preferida: "Principal", alias: [] },
    ],
  }),

  "/api/usuarios": ok({
    usuarios: [
      { id: "u1", correo: "duena@babycaleb.com", nombre: "Yarielis", rol: "duena",
        telegram_chat_id: "123456", activo: 1, creado_en: Date.now() - 60 * dia },
      { id: "u2", correo: "tienda@babycaleb.com", nombre: "Asistente de tienda", rol: "asistente",
        telegram_chat_id: null, activo: 1, creado_en: Date.now() - 20 * dia },
      { id: "u3", correo: "contadora@externa.com", nombre: "Contadora", rol: "contadora",
        telegram_chat_id: null, activo: 0, creado_en: Date.now() - 5 * dia },
    ],
  }),

  // `/ajustes`: solo algunas claves puestas, para que se vea el camino de
  // «esto viene de fábrica» y el de «esto falta decidirlo».
  "/api/ajustes": ok({
    ahora: Date.now(),
    vigentes: [
      { clave: "abono_minimo_cents", version: 3, valor: 1000, vigente_desde: Date.now() - 9 * dia,
        cambiado_por: "duena", motivo: "Subió de $5 a $10 en octubre" },
      { clave: "itbms_tasa_bp", version: 1, valor: 700, vigente_desde: Date.now() - 40 * dia,
        cambiado_por: "duena", motivo: null },
      { clave: "umbral_pocas", version: 2, valor: 5, vigente_desde: Date.now() - 3 * dia,
        cambiado_por: "duena", motivo: null },
    ],
  }),
};

const servidor = createServer(async (pet, res) => {
  const ruta = new URL(pet.url ?? "/", "http://x").pathname;

  if (Object.hasOwn(RESPUESTAS, ruta)) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(RESPUESTAS[ruta]);
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
