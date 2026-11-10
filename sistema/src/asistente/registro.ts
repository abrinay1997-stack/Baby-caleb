import { z } from "zod";
import type { Rol } from "../seguridad/roles";

/**
 * El contrato de una herramienta del asistente.
 *
 * Es `dcasa_brian/models/registro.py` traducido a TypeScript (06-asistente §2).
 * Una herramienta declara qué es y qué necesita, y el registro se encarga del
 * resto: de enseñárselas al modelo siempre en el mismo orden, de validar los
 * argumentos antes de ejecutar y de que no exista ninguna que el rol no pueda
 * usar.
 *
 * Lo que NO está aquí importa tanto como lo que está: no hay forma de declarar
 * una herramienta que borre un asiento, cambie un permiso o ejecute SQL. Esas
 * no se bloquean con una comprobación —se bloquean no existiendo
 * (06-asistente §3).
 */

/** Qué tan lejos llega una herramienta. */
export const NIVELES = ["lectura", "construccion", "sensible"] as const;
export type NivelHerramienta = (typeof NIVELES)[number];

export const CATEGORIAS = [
  "inventario",
  "catalogo",
  "pedidos",
  "clientes",
  "dinero",
  "compras",
  "entregas",
  "contabilidad",
  "ajustes",
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** El canal por el que entró la petición. */
export const CANALES = ["panel", "telegram", "mcp"] as const;
export type Canal = (typeof CANALES)[number];

/** Quién pregunta, por dónde y con qué a mano. */
export interface Contexto {
  readonly db: D1Database;
  readonly usuario: { readonly id: string; readonly correo: string; readonly rol: Rol };
  readonly canal: Canal;
  readonly conversacionId: string | null;
  /** El reloj entra por aquí para que las pruebas no dependan del de verdad. */
  readonly ahora: number;
}

/**
 * Una herramienta.
 *
 * `A` es lo que el esquema deja pasar; `ejecutar` recibe eso ya validado, no
 * lo que mandó el modelo. Esa diferencia es el punto: 06-asistente §6 dice que
 * no se cuenta con que el modelo valide nada, así que la validación del
 * servidor es la única que hay.
 */
export interface Herramienta<A = unknown, R = unknown> {
  readonly nombre: string;
  /** Una o dos frases, con un ejemplo. Es lo que lee el modelo para elegir. */
  readonly descripcion: string;
  readonly parametros: z.ZodType<A>;
  readonly nivel: NivelHerramienta;
  readonly categoria: Categoria;
  readonly roles: readonly Rol[];
  /**
   * Si lo que devuelve puede llevar texto escrito por una clienta (una nota, un
   * mensaje). La política lo usa para endurecer el resto del turno
   * (06-asistente §7): después de leer texto de fuera, construir pide
   * confirmación.
   */
  readonly textoExterno?: boolean;
  readonly ejecutar: (ctx: Contexto, args: A) => Promise<R>;
}

/** Una herramienta de la que ya no se sabe el tipo de sus argumentos. */
export type HerramientaCualquiera = Herramienta<never, unknown>;

/**
 * Define una herramienta conservando el tipo de sus argumentos.
 *
 * Existe solo para que TypeScript ate `parametros` con lo que recibe
 * `ejecutar`: escribiendo el objeto a pelo, `args` queda en `unknown` y se
 * pierde justo la comprobación que más vale.
 */
export function definir<A, R>(h: Herramienta<A, R>): Herramienta<A, R> {
  return h;
}

/** Nombre de herramienta: verbo + objeto, en español, sin acentos ni mayúsculas. */
const NOMBRE_VALIDO = /^[a-z][a-z0-9_]{2,47}$/;

/**
 * El registro.
 *
 * Guarda las herramientas y las entrega SIEMPRE EN EL MISMO ORDEN
 * (06-asistente §6): con este modelo preseleccionar no ahorra nada que importe
 * —~6.000 tokens cuestan unas seis diezmilésimas de dólar por llamada— y una
 * lista fija da respuestas más predecibles.
 */
export class Registro {
  readonly #porNombre = new Map<string, HerramientaCualquiera>();

  constructor(herramientas: readonly Herramienta<never, never>[] = []) {
    for (const h of herramientas) this.registrar(h as HerramientaCualquiera);
  }

  registrar(h: HerramientaCualquiera): void {
    if (!NOMBRE_VALIDO.test(h.nombre)) {
      throw new Error(
        `«${h.nombre}» no sirve de nombre: verbo + objeto en minúsculas, sin acentos (ej. ver_stock)`,
      );
    }
    if (this.#porNombre.has(h.nombre)) {
      // Dos herramientas con el mismo nombre es un error de programación que
      // en producción se vería como «a veces hace una cosa y a veces otra».
      throw new Error(`la herramienta «${h.nombre}» ya está registrada`);
    }
    if (h.roles.length === 0) {
      throw new Error(`«${h.nombre}» no la puede usar nadie: declare al menos un rol`);
    }
    this.#porNombre.set(h.nombre, h);
  }

  /** Todas, en orden fijo (alfabético), pase lo que pase. */
  todas(): HerramientaCualquiera[] {
    return [...this.#porNombre.values()].sort((a, b) => (a.nombre < b.nombre ? -1 : 1));
  }

  buscar(nombre: string): HerramientaCualquiera | undefined {
    return this.#porNombre.get(nombre);
  }

  /** Las que puede usar un rol, en el mismo orden fijo. */
  para(rol: Rol): HerramientaCualquiera[] {
    return this.todas().filter((h) => h.roles.includes(rol));
  }

  /**
   * Lo que se le manda al modelo.
   *
   * `additionalProperties: false` en todos los objetos (06-asistente §2): sin
   * eso, un argumento de más viaja hasta el servidor y hay que acordarse de
   * descartarlo en cada herramienta.
   */
  definicionesPara(rol: Rol): DefinicionDeHerramienta[] {
    return this.para(rol).map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      input_schema: cerrado(z.toJSONSchema(h.parametros)),
    }));
  }
}

export interface DefinicionDeHerramienta {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/**
 * Cierra todos los objetos de un JSON Schema, hasta el fondo.
 *
 * zod lo pone en la raíz, pero un objeto anidado se queda abierto, y es
 * exactamente donde se cuela un argumento que nadie espera.
 */
export function cerrado(esquema: unknown): Record<string, unknown> {
  if (Array.isArray(esquema)) return esquema.map(cerrado) as unknown as Record<string, unknown>;
  if (esquema === null || typeof esquema !== "object") {
    return esquema as unknown as Record<string, unknown>;
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(esquema as Record<string, unknown>)) {
    salida[clave] =
      valor !== null && typeof valor === "object" ? cerrado(valor) : valor;
  }
  if (salida["type"] === "object" && salida["additionalProperties"] === undefined) {
    salida["additionalProperties"] = false;
  }
  return salida;
}
