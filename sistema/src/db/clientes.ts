import { fallo, ok } from "../contrato/resultado";
import type { Resultado } from "../contrato/resultado";
import { ulid } from "../ids";

/**
 * Las clientas, para quien atiende desde el panel.
 *
 * El camino del CRM (`rpc/crm.ts`) resuelve una clienta por su IDENTIDAD en un
 * canal —el id de WhatsApp, el de Telegram—, que es lo que trae un chat. Quien
 * atiende por teléfono no tiene eso: tiene un nombre y un celular. Son dos
 * puertas distintas a la misma persona, y por eso esto vive aparte en vez de
 * retorcer la otra.
 *
 * Lo que NO es distinto es la regla contra los duplicados, y aquí es el punto
 * entero del módulo: un negocio que lleva años atendiendo por WhatsApp acaba
 * con la misma señora tres veces —«Rosa», «Rosa E.», «rosa sanchez»— y
 * entonces su historial de compras no existe, está repartido. Limpiar eso
 * después es trabajo manual y se hace mal.
 *
 * Por eso aquí no hay «crear clienta». Hay `encontrarOCrear`: si el celular ya
 * es de alguien, devuelve a ESA persona en vez de inventar otra ficha. El
 * esquema además lo respalda con `celular_e164 UNIQUE`, así que ni una carrera
 * entre dos pestañas puede colar la segunda.
 */

export interface Contexto {
  readonly db: D1Database;
  readonly ahora: number;
  readonly actor: string;
}

export interface ClientaEnLista {
  readonly id: string;
  readonly nombre: string | null;
  readonly celular_e164: string | null;
  readonly pedidos: number;
  readonly ultimo_pedido: number | null;
}

/** Cuántas caben en una búsqueda. Es un selector, no un listado. */
const TOPE = 20;

/**
 * El celular, en el formato en que lo guarda la base: `5076XXXXXXX`, sin `+`.
 *
 * Quien atiende lo teclea como le sale —con espacios, con guiones, con `+`, o
 * solo los ocho dígitos de Panamá— y las tres formas tienen que llegar a la
 * MISMA fila. Si no, el formato de tecleo se convierte en una clienta nueva, y
 * el duplicado que este módulo existe para evitar entra por la puerta de atrás.
 */
export function normalizarCelular(crudo: string): string | null {
  const solo = crudo.replace(/\D/g, "");
  if (solo === "") return null;
  // Panamá: 8 dígitos sueltos se asumen locales. Con 507 delante, ya está.
  if (solo.length === 8) return `507${solo}`;
  if (solo.length === 11 && solo.startsWith("507")) return solo;
  // Cualquier otro largo es un número de otro país o un dedo gordo: se guarda
  // tal cual y se deja que la persona lo vea escrito.
  return solo.length >= 7 && solo.length <= 15 ? solo : null;
}

/**
 * Buscar por nombre o por celular.
 *
 * La búsqueda por celular normaliza ANTES de comparar, para que «6000-0001»
 * encuentre a quien está guardada como `50760000001`.
 */
export async function buscar(
  db: D1Database,
  consulta: string,
  limite = TOPE,
): Promise<Resultado<{ clientas: ClientaEnLista[] }>> {
  const texto = consulta.trim();
  if (texto === "") return ok({ clientas: [] });

  const tope = Math.min(Math.max(1, limite), TOPE);
  const porNombre = `%${texto.toLowerCase()}%`;
  const porCelular = normalizarCelular(texto);

  const { results } = await db
    .prepare(
      `SELECT c.id, c.nombre, c.celular_e164,
              (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos,
              (SELECT MAX(p.creado_en) FROM pedidos p WHERE p.cliente_id = c.id) AS ultimo_pedido
         FROM clientes c
        WHERE c.anonimizado_en IS NULL
          AND c.fusionado_en_id IS NULL
          AND (LOWER(COALESCE(c.nombre,'')) LIKE ?1
               OR (?2 IS NOT NULL AND c.celular_e164 = ?2))
        ORDER BY ultimo_pedido DESC NULLS LAST, c.nombre
        LIMIT ?3`,
    )
    .bind(porNombre, porCelular, tope)
    .all<ClientaEnLista>();

  return ok({ clientas: results });
}

/**
 * La clienta de ese celular, o una nueva si no existe.
 *
 * Devuelve `nuevo` para que la pantalla pueda decir «ya la tenía» en vez de
 * dejar a quien atiende con la duda de si acaba de crear un duplicado.
 *
 * Una clienta FUSIONADA devuelve la ficha que quedó viva: el celular viejo
 * sigue apuntando a la persona, que es de lo que se trata.
 */
export async function encontrarOCrear(
  ctx: Contexto,
  datos: { readonly nombre: string; readonly celular: string },
): Promise<Resultado<{ clienteId: string; nuevo: boolean; nombre: string | null }>> {
  const nombre = datos.nombre.trim();
  if (nombre === "") return fallo("entrada_invalida", "la clienta necesita un nombre");

  const celular = normalizarCelular(datos.celular);
  if (celular === null) {
    return fallo("entrada_invalida", "ese celular no se entiende. Escríbalo como 6000-0001");
  }

  const ya = await ctx.db
    .prepare(
      "SELECT id, nombre, fusionado_en_id FROM clientes WHERE celular_e164 = ? AND anonimizado_en IS NULL",
    )
    .bind(celular)
    .first<{ id: string; nombre: string | null; fusionado_en_id: string | null }>();

  if (ya !== null) {
    // Si esa ficha se fusionó en otra, la persona es la que quedó viva.
    const id = ya.fusionado_en_id ?? ya.id;
    return ok({ clienteId: id, nuevo: false, nombre: ya.nombre });
  }

  const clienteId = ulid(ctx.ahora);
  try {
    await ctx.db
      .prepare(
        `INSERT INTO clientes (id,nombre,celular_e164,consentimiento_origen,creado_en,actualizado_en)
         VALUES (?,?,?,'panel',?,?)`,
      )
      .bind(clienteId, nombre, celular, ctx.ahora, ctx.ahora)
      .run();
  } catch (e) {
    // El UNIQUE del celular: otra pestaña la creó entre la lectura y esta
    // escritura. No es un error que la persona deba ver — la clienta existe,
    // que es lo que se pedía.
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      const otra = await ctx.db
        .prepare("SELECT id, nombre FROM clientes WHERE celular_e164 = ?")
        .bind(celular)
        .first<{ id: string; nombre: string | null }>();
      if (otra !== null) return ok({ clienteId: otra.id, nuevo: false, nombre: otra.nombre });
    }
    return fallo("interno", "no se pudo guardar la clienta");
  }

  return ok({ clienteId, nuevo: true, nombre });
}
