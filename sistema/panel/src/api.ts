import { useEffect, useState } from "react";
import type { Nivel, Permiso, RolDePanel } from "./permisos";

/**
 * Hablar con el Worker.
 *
 * Todo lo que responde el panel viene con la forma del contrato
 * (`{ ok: true, datos }` o `{ ok: false, codigo, mensaje }`), así que aquí se
 * desenvuelve una vez y las pantallas reciben datos o un error con mensaje en
 * español. Ninguna pantalla debería estar mirando códigos HTTP.
 */

export interface Yo {
  usuario: { id: string; correo: string; nombre: string; rol: RolDePanel; activo: boolean };
  permisos: Record<Permiso, Nivel>;
}

export type Estado<T> =
  | { fase: "cargando" }
  | { fase: "listo"; datos: T }
  // `detalle` es lo que dijo el SERVIDOR, tal cual. `mensaje` es lo que lee
  // la dueña. Los dos, porque el primero sirve para reparar y el segundo
  // para no asustarse: tirar el del servidor deja a quien repara a ciegas.
  | { fase: "error"; mensaje: string; codigo?: string; detalle?: string };

/** Lo que llega por el cable tiene la forma del contrato, bien o mal. */
type Sobre<T> =
  | { ok: true; datos?: T }
  | { ok: false; codigo?: string; mensaje?: string };

/**
 * Traduce lo que puede fallar a algo que una persona entienda.
 *
 * Importa más de lo que parece: la dueña va a ver esto en un teléfono, sin
 * nadie a quien preguntarle, y «Failed to fetch» no le dice qué hacer.
 */
function mensajeDeFallo(codigo: string | undefined, crudo: string | undefined): string {
  switch (codigo) {
    case "no_autorizado":
      // El sistema todavía no tiene puerta. No es que la sesión se haya
      // caído: es que Access no existe, y decirle a alguien «vuelva a entrar»
      // cuando no hay dónde entrar le hace perder la tarde buscando el fallo
      // en el sitio equivocado. Lo vio la primera persona que abrió el panel
      // recién desplegado.
      if (crudo?.includes("sin configurar") === true) {
        return "El panel todavía no tiene puerta de entrada: falta configurar Cloudflare Access. Nadie puede entrar hasta entonces, y eso es a propósito. Avísele a Juan.";
      }
      return "Su sesión no está activa o su cuenta no tiene acceso a esta parte. Vuelva a entrar; si sigue igual, avísele a Juan.";
    case "no_encontrado":
      return "Eso ya no está aquí. Quizá se borró desde otra pantalla.";
    case "limite":
      return "Demasiadas peticiones seguidas. Espere un momento y vuelva a intentar.";
    default:
      return crudo && crudo.length > 0
        ? crudo
        : "No pudimos cargar esta pantalla. Intente de nuevo en un momento.";
  }
}

export async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(ruta, {
      ...opciones,
      headers: { Accept: "application/json", ...(opciones.headers ?? {}) },
    });
  } catch {
    // Sin red, o el Worker no contesta.
    throw new Error("No hay conexión con el sistema. Revise su internet e intente otra vez.");
  }

  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    throw new Error(mensajeDeFallo(undefined, undefined));
  }

  const sobre = cuerpo as Sobre<T>;
  if (sobre?.ok === true) return (sobre.datos ?? (cuerpo as T)) as T;

  const codigo = sobre?.ok === false ? sobre.codigo : undefined;
  const mensaje = sobre?.ok === false ? sobre.mensaje : undefined;
  const error: Error & { codigo?: string; detalle?: string } = new Error(
    mensajeDeFallo(codigo, mensaje),
  );
  if (codigo !== undefined) error.codigo = codigo;
  if (mensaje !== undefined && mensaje !== "") error.detalle = mensaje;
  throw error;
}

/**
 * Carga algo al abrir la pantalla.
 *
 * Devuelve las tres fases explícitas —cargando, listo, error— y no un `datos`
 * que a veces es undefined: así la pantalla tiene que decidir qué enseña
 * mientras carga y qué enseña si falla, en vez de parpadear en blanco.
 */
export function useCarga<T>(ruta: string, dependencias: unknown[] = []): Estado<T> {
  const [estado, setEstado] = useState<Estado<T>>({ fase: "cargando" });

  useEffect(() => {
    let vivo = true;
    setEstado({ fase: "cargando" });
    pedir<T>(ruta)
      .then((datos) => {
        if (vivo) setEstado({ fase: "listo", datos });
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        const err = e as Error & { codigo?: string; detalle?: string };
        setEstado({
          fase: "error",
          mensaje: err.message,
          ...(err.codigo === undefined ? {} : { codigo: err.codigo }),
          ...(err.detalle === undefined ? {} : { detalle: err.detalle }),
        });
      });
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruta, ...dependencias]);

  return estado;
}

/** Centavos a lo que se lee. El dinero se muestra, nunca se calcula aquí. */
export function dinero(centavos: number): string {
  const signo = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  return `${signo}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Una fecha en hora de Panamá, que es la del negocio. */
export function fecha(ms: number): string {
  return new Intl.DateTimeFormat("es-PA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Panama",
  }).format(new Date(ms));
}
