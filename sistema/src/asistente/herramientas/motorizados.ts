import { z } from "zod";
import { cambiarEstado, crear, editar, listar } from "../../db/motorizados";
import { ESTADOS_MOTORIZADO, VEHICULOS } from "../../dominio/motorizado";
import { definir } from "../registro";

/**
 * Los motorizados por la puerta del asistente, y por tanto por MCP.
 *
 * Van en el mismo cambio que las rutas del panel, porque es lo que manda
 * `CLAUDE.md`: una capacidad nueva no está terminada hasta que también se
 * alcanza por MCP. Aquí además se nota el porqué de la regla — dar de alta a
 * un motorizado es lo PRIMERO que hay que hacer para que la cadena de
 * entregas arranque, y si eso solo se pudiera desde una pantalla, el día que
 * la pantalla falle el negocio no puede despachar.
 *
 * Ninguna trae lógica propia: las cuatro llaman a las MISMAS funciones de
 * `src/db/motorizados.ts` que llama `src/api/panel.ts`.
 *
 * ## El celular de un motorizado SÍ sale, y eso es a propósito
 *
 * D-20 esconde del modelo los datos de las CLIENTAS. Un motorizado no es una
 * clienta: es personal del negocio, su celular es el número de trabajo que la
 * dueña marca para preguntarle dónde va, y sin verlo no se puede confirmar a
 * quién se está dando de alta ni detectar que se tecleó mal un dígito. La
 * frontera que protege a las clientas no se mueve por esto: lo que no sale
 * sigue siendo el nombre, el teléfono y la dirección de quien compra.
 */

const idDeMotorizado = z
  .string()
  .min(1)
  .max(40)
  .describe("El id del motorizado, tal como lo da ver_motorizados.");

/**
 * El porqué, para la bitácora del asistente.
 *
 * `motorizados` no tiene dónde guardar un motivo —no hay columna— así que
 * aquí no se promete que aparezca en su ficha: queda en `acciones`, con quién
 * lo pidió, por dónde y a qué hora, y esa tabla no se edita ni se borra. Es el
 * mismo trato que en las herramientas de entregas, y lo exige
 * `registro.test.ts`: lo que escribe, pide motivo.
 */
const motivoEnLaBitacora = z
  .string()
  .min(3)
  .max(300)
  .optional()
  .describe(
    "Por qué se hace. Queda en la bitácora del asistente (acciones), no en la ficha del motorizado.",
  );

const vehiculo = z
  .enum(VEHICULOS)
  .describe("En qué anda. Si no se sabe, se deja sin poner.");

export const verMotorizados = definir({
  nombre: "ver_motorizados",
  descripcion:
    "Quiénes reparten, en qué andan, si están activos y cuántas entregas llevan hoy. Ejemplo: ver_motorizados para saber a quién asignarle la ruta.",
  parametros: z.object({
    todos: z
      .boolean()
      .optional()
      .describe("Con true salen también los inactivos. Por defecto, no."),
  }),
  nivel: "lectura",
  categoria: "entregas",
  // La asistente ve la lista porque es quien reparte las rutas del día.
  roles: ["duena", "asistente"],

  async ejecutar(ctx, args) {
    const todos = args.todos === true;
    const r = await listar(ctx.db, { incluirInactivos: todos });
    if (!r.ok) throw new Error(r.mensaje);

    // Una lista vacía tiene DOS causas y el modelo no puede distinguirlas
    // solas: que no haya nadie dado de alta, o que los que hay estén fuera y
    // no se pidieran. Sin decirlo, contestaría «no hay quién reparta» sobre un
    // equipo que existe. Es la frontera que vigila `fronteras.test.ts`.
    const aviso =
      r.datos.motorizados.length > 0
        ? undefined
        : todos
          ? "No hay nadie dado de alta. Sin alguien aquí no se puede armar una ruta: las entregas se quedan preparadas y sin dueño. Se da de alta en el panel, en Entregas › Quién reparte, o con dar_de_alta_motorizado."
          : "Nadie activo ni en pausa. Puede que sí haya gente que ya no trabaja aquí: vuelva a preguntar con todos = true.";

    return { motorizados: r.datos.motorizados, ...(aviso === undefined ? {} : { aviso }) };
  },
});

export const darDeAltaMotorizado = definir({
  nombre: "dar_de_alta_motorizado",
  descripcion:
    "Da de alta a alguien que va a repartir. Nace activo. Ejemplo: dar_de_alta_motorizado con nombre «Luis Pérez», celular «6000-0001» y vehiculo «moto».",
  parametros: z.object({
    nombre: z.string().min(1).max(60).describe("Cómo se llama."),
    celular: z
      .string()
      .min(7)
      .max(20)
      .describe("Su celular. Se entiende con guiones, con espacios o solo los 8 dígitos."),
    vehiculo: vehiculo.optional(),
    motivo: motivoEnLaBitacora,
  }),
  /**
   * Sensible, y no por el dinero: por quién.
   *
   * Dar de alta a un motorizado es darle un sitio en la lista de a quién se le
   * confía la mercancía y la dirección de una clienta. Eso se confirma antes
   * de hacerse —`politica.ts` lo convierte en un «¿lo hago?»— y lo pide solo
   * la dueña, igual que la ruta del panel, que va con el permiso de ajustes.
   */
  nivel: "sensible",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await crear(
      { db: ctx.db, ahora: ctx.ahora },
      { nombre: args.nombre, celular: args.celular, vehiculo: args.vehiculo },
    );
    if (!r.ok) throw new Error(r.mensaje);
    return r.datos;
  },
});

export const corregirMotorizado = definir({
  nombre: "corregir_motorizado",
  descripcion:
    "Le arregla el nombre, el celular o el vehículo a alguien que ya reparte. Ejemplo: corregir_motorizado con su id y celular «6000-0002» porque cambió de número.",
  parametros: z
    .object({
      motorizadoId: idDeMotorizado,
      nombre: z.string().min(1).max(60).optional(),
      celular: z.string().min(7).max(20).optional(),
      vehiculo: vehiculo.optional(),
      motivo: motivoEnLaBitacora,
    })
    .refine((a) => a.nombre !== undefined || a.celular !== undefined || a.vehiculo !== undefined, {
      message: "hay que decir qué cambiar: nombre, celular o vehiculo",
    }),
  // Corregir un dato de contacto no mueve dinero ni mercancía.
  nivel: "construccion",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await editar({ db: ctx.db, ahora: ctx.ahora }, args.motorizadoId, {
      ...(args.nombre === undefined ? {} : { nombre: args.nombre }),
      ...(args.celular === undefined ? {} : { celular: args.celular }),
      ...(args.vehiculo === undefined ? {} : { vehiculo: args.vehiculo }),
    });
    if (!r.ok) throw new Error(r.mensaje);
    return r.datos;
  },
});

export const cambiarEstadoDeMotorizado = definir({
  nombre: "cambiar_estado_motorizado",
  descripcion:
    "Lo pone activo, en pausa o fuera. Solo un activo recibe ruta. Ejemplo: cambiar_estado_motorizado con su id y estado «pausa» porque hoy no trabaja.",
  parametros: z.object({
    motorizadoId: idDeMotorizado,
    estado: z
      .enum(ESTADOS_MOTORIZADO)
      .describe(
        "activo (recibe rutas), pausa (hoy no trabaja, mañana sí) o inactivo (ya no trabaja aquí).",
      ),
    motivo: motivoEnLaBitacora,
  }),
  /**
   * Sensible porque corta el trabajo de alguien.
   *
   * Pausar al único motorizado activo deja el día sin quién reparta, y eso se
   * descubre cuando hay cajas listas y nadie a quien asignarlas. Devuelve
   * cuántas rutas tiene sin cerrar para que la respuesta lo diga.
   */
  nivel: "sensible",
  categoria: "entregas",
  roles: ["duena"],

  async ejecutar(ctx, args) {
    const r = await cambiarEstado({ db: ctx.db, ahora: ctx.ahora }, args.motorizadoId, args.estado);
    if (!r.ok) throw new Error(r.mensaje);
    return r.datos;
  },
});

export const HERRAMIENTAS_DE_MOTORIZADOS = [
  verMotorizados,
  darDeAltaMotorizado,
  corregirMotorizado,
  cambiarEstadoDeMotorizado,
] as const;
