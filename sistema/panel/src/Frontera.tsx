import { Component, type ErrorInfo, type ReactNode } from "react";
import { Tarjeta } from "./componentes";

/**
 * La frontera de errores.
 *
 * React desmonta el árbol entero cuando un render tira una excepción, así que
 * sin esto un campo inesperado del API —un `null` donde se esperaba una lista—
 * deja la pantalla EN BLANCO. Y quien abre este panel es la dueña, desde el
 * teléfono, sin nadie a quien preguntarle: una pantalla en blanco es el peor
 * fallo posible porque no dice nada ni deja salir.
 *
 * Va por dentro del armazón, no por fuera: así la barra y el cajón siguen
 * vivos y se puede ir a otra pestaña. Se remonta con la ruta (`key`), que es
 * lo que hace que navegar arregle la pantalla rota.
 *
 * Esto no se descubrió pensando: se descubrió al abrir el panel en un
 * navegador de verdad con datos que no cuadraban, y era pantalla blanca.
 */

interface Props {
  children: ReactNode;
  /** Para contarle a soporte dónde pasó. */
  donde?: string;
}

interface Estado {
  error: Error | null;
}

export class Frontera extends Component<Props, Estado> {
  override state: Estado = { error: null };

  static getDerivedStateFromError(error: Error): Estado {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // A la consola, que es donde lo va a buscar quien repare. No se manda a
    // ningún servicio: un error puede llevar dentro datos de una clienta, y
    // esos no salen del navegador (07-seguridad §6).
    console.error("El panel se rompió", { donde: this.props.donde, error, info });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <Tarjeta className="max-w-xl border-accent-edge">
        <h2 className="m-0 text-[17px] font-bold">Esta pantalla se rompió</h2>
        <p className="mt-2 text-muted">
          No es algo que usted hiciera mal. El resto del panel sigue funcionando: use el menú
          para ir a otra pestaña.
        </p>
        <p className="m-0 mt-3">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="tactil rounded-lg bg-accent px-4 font-bold text-accent-fg"
          >
            Volver a intentar
          </button>
        </p>
        {/* El detalle técnico, al final y en pequeño: sirve para contárselo a
            Juan, no para que la dueña lo descifre. */}
        <p className="m-0 mt-4 text-[12px] text-muted">
          Detalle para soporte{this.props.donde ? ` (${this.props.donde})` : ""}: {error.message}
        </p>
      </Tarjeta>
    );
  }
}
