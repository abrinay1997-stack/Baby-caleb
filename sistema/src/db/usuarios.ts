import { fallo, ok, type Resultado } from "../contrato/resultado";
import { ulid } from "../ids";
import { ROLES_DE_PANEL, esRolDePanel, type RolDePanel } from "../seguridad/roles";

/**
 * Quién entra al panel: darlo de alta y quitarle el acceso.
 *
 * ## El correo no distingue mayúsculas
 *
 * Es la LLAVE DE ENTRADA: Cloudflare Access entrega el correo del token y el
 * Worker lo cruza con `usuarios.correo`. Access lo entrega siempre en
 * minúsculas, pero estas filas las escribe una persona, así que un
 * «Yarielis@Gmail.com» tecleado con mayúscula dejaría a esa persona fuera para
 * siempre, con un «no autorizado» que no explica nada — y en un panel cuya
 * dueña no usa la terminal, eso es un callejón sin salida.
 *
 * Se cierra por los dos lados: aquí el correo se guarda en minúsculas, y la
 * migración 0005 tiene un índice único `COLLATE NOCASE`, así que dos filas que
 * solo se diferencien en mayúsculas no pueden ni existir. Dos correos que solo
 * cambian de caja son la misma persona.
 *
 * ## Tiene que quedar una dueña
 *
 * Quitarle el acceso a la última dueña activa deja el sistema sin nadie que
 * pueda administrarlo: los permisos de `ajustes` solo los tiene ese rol, así
 * que nadie podría volver a dar de alta a nadie — ni a sí mismo. No se arregla
 * desde el panel, se arregla por SQL, que es justo lo que la dueña no sabe
 * hacer.
 *
 * Esa regla NO se comprueba leyendo antes y decidiendo después: se comprueba
 * en la FILA DE CONTROL del mismo batch, mirando cuántas dueñas activas
 * quedaron DESPUÉS del UPDATE. Una lectura previa deja una rendija —entre leer
 * y escribir cabe otra baja— y además dejaría al control sin nada que
 * detectar, que es la forma de tener un control que no vigila nada.
 */

export interface ContextoUsuario {
  readonly db: D1Database;
  readonly ahora: number;
}

const LARGO_NOMBRE = 80;
const LARGO_CORREO = 160;

/**
 * La forma de un correo, sin pretender validarlo de verdad.
 *
 * Quien decide si ese correo entra es Cloudflare Access, no esto: aquí solo se
 * atajan los dedazos obvios —sin arroba, con espacios, sin punto en el
 * dominio— para que el error llegue al teclearlo y no tres días después, en
 * forma de «no autorizado» sobre una persona que creía tener acceso.
 */
const FORMA_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function revisarCorreo(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "falta el correo");
  // A minúsculas al guardar: Access lo entrega así, y guardarlo igual es lo
  // que hace que la comparación de la puerta sea trivialmente correcta.
  const correo = crudo.trim().toLowerCase();
  if (correo === "") return fallo("entrada_invalida", "falta el correo");
  if (correo.length > LARGO_CORREO) {
    return fallo("entrada_invalida", `el correo no puede pasar de ${LARGO_CORREO} letras`);
  }
  if (!FORMA_CORREO.test(correo)) {
    return fallo("entrada_invalida", `«${correo}» no parece un correo`);
  }
  return ok(correo);
}

function revisarNombre(crudo: unknown): Resultado<string> {
  if (typeof crudo !== "string") return fallo("entrada_invalida", "falta el nombre");
  const nombre = crudo.trim().replace(/\s+/g, " ");
  if (nombre === "") return fallo("entrada_invalida", "falta el nombre");
  if (nombre.length > LARGO_NOMBRE) {
    return fallo("entrada_invalida", `el nombre no puede pasar de ${LARGO_NOMBRE} letras`);
  }
  return ok(nombre);
}

function revisarRol(crudo: unknown): Resultado<RolDePanel> {
  // El motorizado es un rol del sistema pero NO tiene fila en `usuarios`: vive
  // en `motorizados` y entra por su PIN a otra superficie. El CHECK de la
  // tabla dice lo mismo; aquí se dice antes y con palabras.
  if (typeof crudo !== "string" || !esRolDePanel(crudo)) {
    return fallo(
      "entrada_invalida",
      `«${String(crudo)}» no es un rol del panel; los hay: ${ROLES_DE_PANEL.join(", ")}`,
    );
  }
  return ok(crudo);
}

/** Quién tiene ya ese correo, sin importar las mayúsculas. */
async function quienTieneElCorreo(
  db: D1Database,
  correo: string,
): Promise<{ id: string; nombre: string } | null> {
  return await db
    .prepare("SELECT id, nombre FROM usuarios WHERE correo = ? COLLATE NOCASE")
    .bind(correo)
    .first<{ id: string; nombre: string }>();
}

/**
 * Dar de alta a alguien.
 *
 * Nace con acceso (`activo = 1`): dar de alta a una persona es dejarla entrar,
 * y una fila apagada obligaría a dos pasos para lo normal. Quitarle el acceso
 * es un acto aparte y explícito.
 *
 * Sin fila de control: es un solo `INSERT`, que o entra o revienta. El índice
 * único del correo es lo que impide el duplicado, y se comprueba preguntando
 * —no leyendo el texto del error— para poder decir CON QUIÉN choca.
 */
export async function alta(
  ctx: ContextoUsuario,
  datos: { readonly correo?: unknown; readonly nombre?: unknown; readonly rol?: unknown },
): Promise<Resultado<{ id: string; correo: string }>> {
  const correo = revisarCorreo(datos.correo);
  if (!correo.ok) return correo;

  const nombre = revisarNombre(datos.nombre);
  if (!nombre.ok) return nombre;

  const rol = revisarRol(datos.rol);
  if (!rol.ok) return rol;

  const id = ulid(ctx.ahora);

  try {
    await ctx.db
      .prepare(
        `INSERT INTO usuarios (id, correo, nombre, rol, telegram_chat_id, activo, creado_en)
         VALUES (?,?,?,?,NULL,1,?)`,
      )
      .bind(id, correo.datos, nombre.datos, rol.datos, ctx.ahora)
      .run();
  } catch {
    const ya = await quienTieneElCorreo(ctx.db, correo.datos);
    if (ya !== null) {
      return fallo(
        "repetido",
        `ese correo ya es de ${ya.nombre}. Dos correos que solo cambian de mayúsculas son la misma persona.`,
      );
    }
    return fallo("interno", "no se pudo dar de alta a esa persona");
  }

  return ok({ id, correo: correo.datos });
}

/**
 * Quitarle o devolverle el acceso a alguien.
 *
 * Quitar el acceso tiene efecto en la SIGUIENTE petición de esa persona, sin
 * esperar a que le caduque la sesión de Access y sin tocar nada en Cloudflare:
 * la puerta cruza el correo con esta tabla en cada llamada (07-seguridad §2).
 */
export async function cambiarAcceso(
  ctx: ContextoUsuario,
  id: string,
  activo: boolean,
): Promise<Resultado<{ id: string; activo: boolean }>> {
  const valor = activo ? 1 : 0;

  try {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE usuarios SET activo = ? WHERE id = ?").bind(valor, id),
      // Dos cosas, las dos sobre el estado YA CAMBIADO:
      //
      //  1. Que la fila exista y haya quedado con el valor que este batch
      //     quería escribir. Un UPDATE que no casa con nada afecta cero filas
      //     y no falla, así que sin esto «quité el acceso» saldría bien sobre
      //     un id que no existe.
      //  2. Que siga habiendo al menos una dueña activa. Esta es la que
      //     importa: es la única forma de impedir que el sistema se quede sin
      //     quien lo administre, y tiene que mirarse DESPUÉS del UPDATE,
      //     porque antes la respuesta siempre es que sí.
      ctx.db
        .prepare(
          `INSERT INTO controles (id, regla, ok, creado_en)
           VALUES (?, ?, (SELECT CASE WHEN
               (SELECT COUNT(*) FROM usuarios WHERE id = ? AND activo IS ?) = 1
           AND (SELECT COUNT(*) FROM usuarios WHERE rol = 'duena' AND activo = 1) >= 1
             THEN 1 ELSE 0 END), ?)`,
        )
        .bind(ulid(ctx.ahora), `acceso-usuario:${id}`, id, valor, ctx.ahora),
    ]);
  } catch {
    return await porQueNoSePudo(ctx, id, activo);
  }

  return ok({ id, activo });
}

/**
 * Por qué se cayó el batch, preguntándole a la base en vez de adivinando.
 *
 * Nada cambió —el batch es todo o nada—, así que el estado de ahora es el de
 * antes y se puede volver a mirar. Cada causa lleva su propio código: un error
 * mal etiquetado manda a buscar al sitio equivocado (trampa nº 10).
 */
async function porQueNoSePudo(
  ctx: ContextoUsuario,
  id: string,
  activo: boolean,
): Promise<Resultado<never>> {
  const quien = await ctx.db
    .prepare("SELECT nombre, rol, activo FROM usuarios WHERE id = ?")
    .bind(id)
    .first<{ nombre: string; rol: string; activo: number }>();

  if (quien === null) return fallo("no_encontrado", "no existe esa persona");

  if (!activo && quien.rol === "duena") {
    const otras = await ctx.db
      .prepare("SELECT COUNT(*) AS cuantas FROM usuarios WHERE rol = 'duena' AND activo = 1 AND id <> ?")
      .bind(id)
      .first<{ cuantas: number }>();
    if ((otras?.cuantas ?? 0) === 0) {
      return fallo(
        "transicion_invalida",
        `${quien.nombre} es la única dueña con acceso. Si se lo quita, no quedaría nadie que pueda administrar el sistema ni devolverle el acceso a nadie. Dé de alta a otra dueña primero.`,
      );
    }
  }

  return fallo("interno", "no se pudo cambiar el acceso");
}
