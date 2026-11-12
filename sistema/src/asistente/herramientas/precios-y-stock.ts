import { z } from "zod";
import { editarVariante } from "../../db/catalogo-admin";
import { aplicar, bodegaPorNombre, trasladar } from "../../db/inventario";
import { ulid } from "../../ids";
import { definir } from "../registro";

/**
 * Las primeras herramientas que CAMBIAN algo (F3.8).
 *
 * Todas son `sensible`, así que el asistente no las ejecuta: las PROPONE con
 * el detalle exacto y espera a que una persona toque «Permitir»
 * (06-asistente §3). Lo que la persona lee es el resumen que arma
 * `ejecutar.ts`, con los números ya en dólares.
 *
 * Y todas escriben en los libros como escribe el resto del sistema: un
 * movimiento que explica el cambio, nunca un número reescrito. Un stock sin
 * historia que lo explique es un stock en el que nadie puede confiar dentro de
 * tres meses.
 */

const codigo = z
  .string()
  .min(1)
  .max(40)
  .describe("El código del artículo, como NAT-M o DANY-AW600.");

const motivo = z
  .string()
  .min(3)
  .max(200)
  .describe("Por qué se hace. Queda escrito en los libros y es lo que lo explica después.");

export const cambiarPrecio = definir({
  nombre: "cambiar_precio",
  descripcion:
    "Cambia el precio de venta de un artículo. El precio va en CENTAVOS: $15.00 son 1500. Ejemplo: cambiar_precio con codigo «NAT-M» y precio_cents 5500 lo sube a $55.00 en el panel, en la web y en el bot a la vez.",
  parametros: z.object({
    codigo,
    precio_cents: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .describe("El precio nuevo en centavos. $15.00 son 1500."),
    motivo,
  }),
  nivel: "sensible",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const antes = await ctx.db
      .prepare("SELECT precio_cents, version FROM variantes WHERE codigo = ?")
      .bind(args.codigo)
      .first<{ precio_cents: number; version: number }>();

    if (antes === null) throw new Error(`no existe el artículo ${args.codigo}`);
    if (antes.precio_cents === args.precio_cents) {
      throw new Error(`${args.codigo} ya está en ese precio`);
    }

    // Cada precio deja su fila con la fecha en que empezó a valer. Sin
    // `precios_historial`, la pregunta «¿a cuánto lo vendíamos en septiembre?»
    // no tiene respuesta, y esa pregunta se hace cada vez que se cierra un mes.
    //
    // La fila es la del precio NUEVO: la tabla guarda desde cuándo vale cada
    // uno, no hasta cuándo valió el anterior.
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO precios_historial (id, codigo, precio_cents, vigente_desde, cambiado_por, motivo)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(ulid(ctx.ahora), args.codigo, args.precio_cents, ctx.ahora, ctx.usuario.id, args.motivo),
      ctx.db
        .prepare(
          `UPDATE variantes SET precio_cents = ?, version = version + 1, actualizado_en = ?
           WHERE codigo = ? AND version = ?`,
        )
        .bind(args.precio_cents, ctx.ahora, args.codigo, antes.version),
      // Fila de control: si otra persona cambió el precio entre que se propuso
      // y se confirmó, la versión no casa, el UPDATE no toca nada y esto tumba
      // el batch. Sin ella se perdería el cambio del otro en silencio.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, 'cambiar_precio', (SELECT COUNT(*) FROM variantes WHERE codigo = ? AND version = ?), ?)`,
        )
        .bind(ulid(ctx.ahora), args.codigo, antes.version + 1, ctx.ahora),
    ]);

    return {
      codigo: args.codigo,
      antes_cents: antes.precio_cents,
      ahora_cents: args.precio_cents,
    };
  },
});

export const ajustarStock = definir({
  nombre: "ajustar_stock",
  descripcion:
    "Corrige las existencias de un artículo en una bodega después de un conteo. «fijar» pone el número que se contó; «sumar» y «restar» mueven por la diferencia. Ejemplo: ajustar_stock con codigo «NAT-M», bodega «Bodega Ciudad de Panamá», modo «fijar» y cantidad 12.",
  parametros: z.object({
    codigo,
    bodega: z.string().min(1).max(60).describe("El nombre de la bodega, tal como aparece en el panel."),
    modo: z.enum(["sumar", "restar", "fijar"]).describe("«fijar» es lo que se usa tras un conteo."),
    cantidad: z.number().int().min(0).max(1_000_000),
    motivo,
  }),
  nivel: "sensible",
  categoria: "inventario",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const bodega = await bodegaPorNombre(ctx.db, args.bodega);
    if (bodega === null) throw new Error(`no existe la bodega «${args.bodega}»`);

    const fila = await ctx.db
      .prepare("SELECT fisico FROM existencias WHERE codigo = ? AND bodega_id = ?")
      .bind(args.codigo, bodega.id)
      .first<{ fisico: number }>();
    if (fila === null) throw new Error(`${args.codigo} no está dado de alta en «${args.bodega}»`);

    const delta =
      args.modo === "sumar"
        ? args.cantidad
        : args.modo === "restar"
          ? -args.cantidad
          : args.cantidad - fila.fisico;

    if (delta === 0) throw new Error(`${args.codigo} ya está en ${args.cantidad} en «${args.bodega}»`);

    const r = await aplicar(
      { db: ctx.db, actor: ctx.usuario.id, ahora: ctx.ahora },
      [{ codigo: args.codigo, bodegaId: bodega.id, delta, tipo: "ajuste", motivo: args.motivo }],
      { tipo: "ajuste", id: ulid(ctx.ahora) },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return { codigo: args.codigo, bodega: bodega.nombre, antes: fila.fisico, ahora: fila.fisico + delta, deshacerId: r.datos.deshacerId };
  },
});

export const trasladarStock = definir({
  nombre: "trasladar_stock",
  descripcion:
    "Mueve existencias de una bodega a otra. Ejemplo: trasladar_stock con codigo «NAT-M», desde «Bodega Ciudad de Panamá», hacia «Bodega Panamá Oeste» y cantidad 10.",
  parametros: z.object({
    codigo,
    desde: z.string().min(1).max(60),
    hacia: z.string().min(1).max(60),
    cantidad: z.number().int().positive().max(1_000_000),
    motivo,
  }),
  nivel: "sensible",
  categoria: "inventario",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    // El asistente habla de bodegas por su nombre y el motor por su id: esta
    // es la única traducción. El traslado en sí lo hace `trasladar`, el mismo
    // que llama el panel — dos caminos distintos hacia el inventario acabarían
    // discrepando, y el que se equivoque del lado flojo es el que nadie
    // revisa.
    const origen = await bodegaPorNombre(ctx.db, args.desde);
    const destino = await bodegaPorNombre(ctx.db, args.hacia);
    if (origen === null) throw new Error(`no existe la bodega «${args.desde}»`);
    if (destino === null) throw new Error(`no existe la bodega «${args.hacia}»`);

    const r = await trasladar(
      { db: ctx.db, actor: ctx.usuario.id, ahora: ctx.ahora },
      {
        codigo: args.codigo,
        desdeId: origen.id,
        haciaId: destino.id,
        cantidad: args.cantidad,
        motivo: args.motivo,
      },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      codigo: args.codigo,
      desde: origen.nombre,
      hacia: destino.nombre,
      cantidad: args.cantidad,
      deshacerId: r.datos.deshacerId,
    };
  },
});

export const registrarMerma = definir({
  nombre: "registrar_merma",
  descripcion:
    "Da de baja mercancía que se perdió, se dañó o se venció. Ejemplo: registrar_merma con codigo «NAT-M», bodega «Bodega Ciudad de Panamá», cantidad 2 y motivo «caja mojada en la entrega».",
  parametros: z.object({
    codigo,
    bodega: z.string().min(1).max(60),
    cantidad: z.number().int().positive().max(1_000_000),
    motivo,
  }),
  nivel: "sensible",
  categoria: "inventario",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const bodega = await bodegaPorNombre(ctx.db, args.bodega);
    if (bodega === null) throw new Error(`no existe la bodega «${args.bodega}»`);

    const r = await aplicar(
      { db: ctx.db, actor: ctx.usuario.id, ahora: ctx.ahora },
      [
        {
          codigo: args.codigo,
          bodegaId: bodega.id,
          delta: -args.cantidad,
          tipo: "merma",
          motivo: args.motivo,
        },
      ],
      { tipo: "merma", id: ulid(ctx.ahora) },
    );
    if (!r.ok) throw new Error(r.mensaje);

    return { codigo: args.codigo, bodega: bodega.nombre, cantidad: args.cantidad, deshacerId: r.datos.deshacerId };
  },
});

export const cambiarBotonWhatsapp = definir({
  nombre: "cambiar_boton_whatsapp",
  descripcion:
    "Decide si la web enseña el botón «Pedir por WhatsApp» en UN artículo. «heredar» lo deja como diga Ajustes, que es lo normal; «si» y «no» lo deciden solo para ese artículo. Para apagarlo en TODA la tienda se usa cambiar_ajuste con «whatsapp_pedidos_activo». Ejemplo: cambiar_boton_whatsapp con codigo «BC-COMBO-1» y mostrar «no» quita el botón de ese combo y lo deja solo con el carrito.",
  parametros: z.object({
    codigo,
    mostrar: z
      .enum(["si", "no", "heredar"])
      .describe(
        "«heredar» = lo que diga Ajustes (es el valor de fábrica de todos los artículos).",
      ),
    motivo,
  }),
  nivel: "sensible",
  categoria: "catalogo",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const antes = await ctx.db
      .prepare("SELECT pedir_por_whatsapp, version FROM variantes WHERE codigo = ?")
      .bind(args.codigo)
      .first<{ pedir_por_whatsapp: number | null; version: number }>();

    if (antes === null) throw new Error(`no existe el artículo ${args.codigo}`);

    const quiere = args.mostrar === "heredar" ? null : args.mostrar === "si" ? 1 : 0;
    // `antes.pedir_por_whatsapp` puede ser null, y `null === null` es true en
    // JavaScript: aquí sí se pueden comparar directo. En SQL no, y por eso el
    // control de abajo usa `IS`.
    if (antes.pedir_por_whatsapp === quiere) {
      throw new Error(`${args.codigo} ya estaba así`);
    }

    // Va por el MISMO camino que el panel —`editarVariante`— y no con un
    // UPDATE propio: ahí viven el control contra la actualización perdida y la
    // comparación con `IS` que hace falta para una columna que puede ser nula.
    // Un segundo camino hacia la misma columna es un segundo sitio donde esas
    // dos cosas se olvidan (es la lección de `trasladar_stock`, aquí arriba).
    const r = await editarVariante(
      { db: ctx.db, actor: ctx.usuario.id, ahora: ctx.ahora },
      args.codigo,
      {
        pedirPorWhatsapp: quiere === null ? null : quiere === 1,
        motivo: args.motivo,
      },
      antes.version,
    );
    if (!r.ok) throw new Error(r.mensaje);

    return {
      codigo: args.codigo,
      antes:
        antes.pedir_por_whatsapp === null
          ? "heredar"
          : antes.pedir_por_whatsapp === 1
            ? "si"
            : "no",
      ahora: args.mostrar,
      // Lo que de verdad va a ver la clienta depende TAMBIÉN del ajuste
      // global, así que se dice aquí: un «sí» en el artículo con el ajuste
      // apagado no enseña ningún botón, y quien lo pidió tiene que saberlo
      // ahora y no cuando mire la web.
      aviso:
        "Lo que la web enseña sale de esto Y del ajuste «whatsapp_pedidos_activo». Si ese está apagado, o no hay número puesto en «whatsapp_numero», el botón no sale en ningún artículo.",
      version: r.datos.version,
    };
  },
});

export const HERRAMIENTAS_DE_PRECIOS_Y_STOCK = [
  cambiarPrecio,
  ajustarStock,
  trasladarStock,
  registrarMerma,
  cambiarBotonWhatsapp,
] as const;
