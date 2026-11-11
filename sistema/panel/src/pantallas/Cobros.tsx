import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { type Yo, dinero, fecha, pedir, useCarga } from "../api";
import { Carga, Pastilla, Tarjeta, Vacio } from "../componentes";

/**
 * Los cobros: la bandeja de comprobantes que esperan a una persona.
 *
 * La pantalla que le da sentido a la regla más dura del proyecto — **el
 * navegador no decide un pago**. La regla estaba cumplida en el servidor desde
 * F4.4 y no había dónde ejercerla: un comprobante entraba en «confirmando» y
 * se quedaba ahí para siempre, porque no existía ni pantalla ni ruta que
 * permitiera confirmarlo. Nadie decidía nada, que es la peor forma de cumplir
 * una regla que existe para que alguien decida.
 *
 * CÓMO SE ORDENA, Y POR QUÉ ASÍ
 *
 * Una lista, los más viejos primero. No es el orden bonito: es que un
 * comprobante sin mirar envejece, y la clienta que mandó el suyo hace tres
 * días es la que está escribiendo «¿ya les llegó?».
 *
 * CADA FICHA TRAE LA DECISIÓN ENTERA
 *
 * El monto, la captura, el pedido, lo que ya se cobró y lo que faltaría
 * después. Esto es deliberado y es lo que más cuesta: lo fácil es enseñar el
 * comprobante y un botón, y que quien confirme abra el pedido en otra pestaña
 * para saber si la cifra cuadra. En un teléfono eso no pasa — se confirma a
 * ojo. Así que las cifras vienen en la misma respuesta y se pintan juntas.
 *
 * Y la captura se VE, no se menciona. Si quien confirma no puede mirarla, su
 * clic no comprueba nada: solo traslada la firma.
 */

interface Comprobante {
  pagoId: string;
  pedidoId: string;
  numero: string;
  cliente: string | null;
  montoCents: number;
  metodo: string;
  tipo: string;
  comprobanteR2: string | null;
  creadoEn: number;
  totalCents: number;
  pagadoCents: number;
  estadoPedido: string;
}

const BOTON =
  "tactil rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2 disabled:opacity-60";
const PRINCIPAL = `${BOTON} bg-accent text-accent-fg`;
const SUAVE = `${BOTON} border border-line`;
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 text-[16px] text-fg " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

const NOMBRE_METODO: Record<string, string> = {
  yappy: "Yappy",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  nequi: "Nequi",
};

const NOMBRE_TIPO: Record<string, string> = {
  abono: "Abono",
  total: "Pago completo",
  saldo: "Saldo",
};

const NOMBRE_ESTADO: Record<string, string> = {
  por_abonar: "Por abonar",
  agendado: "Agendado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  devuelto: "Devuelto",
};

/**
 * Los métodos que todavía no tienen cuenta en el plan de cuentas.
 *
 * Se avisa EN LA FICHA, antes de confirmar, y no después: el pago se va a
 * cobrar igual —el dinero entró— pero no va a quedar asiento, y eso es algo
 * que quien confirma tiene derecho a saber antes de pulsar. Avisarlo después
 * sería contarle un problema que ya no puede evitar.
 */
const SIN_CUENTA = new Set(["nequi"]);

/** Cuántos días lleva esperando. Un comprobante sin mirar envejece. */
function esperando(creadoEn: number): { texto: string; viejo: boolean } {
  const horas = Math.floor((Date.now() - creadoEn) / 3_600_000);
  if (horas < 1) return { texto: "recién llegado", viejo: false };
  if (horas < 24) return { texto: `hace ${horas} h`, viejo: horas >= 12 };
  const dias = Math.floor(horas / 24);
  return { texto: `hace ${dias} ${dias === 1 ? "día" : "días"}`, viejo: true };
}

function Ficha({
  c,
  puede,
  alHecho,
}: {
  c: Comprobante;
  puede: boolean;
  alHecho: () => void;
}) {
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [verCaptura, setVerCaptura] = useState(false);

  const espera = esperando(c.creadoEn);
  const quedaDespues = c.totalCents - c.pagadoCents - c.montoCents;
  const sinCuenta = SIN_CUENTA.has(c.metodo);

  async function mandar(ruta: string, cuerpo: Record<string, unknown>) {
    setTrabajando(true);
    setError(null);
    try {
      await pedir(ruta, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      alHecho();
    } catch (e) {
      setError((e as Error).message);
      setTrabajando(false);
    }
  }

  return (
    <Tarjeta>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* El monto es lo primero y lo más grande: es la cifra que se está
            aprobando. `tabular-nums` para que no baile al actualizarse. */}
        <strong className="text-[24px] font-bold tabular-nums">{dinero(c.montoCents)}</strong>
        <span className="text-[13px] text-muted">
          {NOMBRE_TIPO[c.tipo] ?? c.tipo} por {NOMBRE_METODO[c.metodo] ?? c.metodo}
        </span>
      </div>

      <p className="m-0 mt-1 text-[15px]">
        {c.cliente ?? "Clienta sin nombre"} · pedido {c.numero}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pastilla tono={espera.viejo ? "aviso" : "neutro"}>{espera.texto}</Pastilla>
        <Pastilla tono="neutro">{NOMBRE_ESTADO[c.estadoPedido] ?? c.estadoPedido}</Pastilla>
        <span className="text-[12px] text-muted">{fecha(c.creadoEn)}</span>
      </div>

      {/* Las cifras del pedido, para decidir sin salir de aquí. */}
      <dl className="mt-3 grid gap-1 border-t border-line pt-3 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Total del pedido</dt>
          <dd className="m-0 tabular-nums">{dinero(c.totalCents)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Ya cobrado</dt>
          <dd className="m-0 tabular-nums">{dinero(c.pagadoCents)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">
            {quedaDespues > 0
              ? "Quedaría debiendo"
              : quedaDespues === 0
                ? "Quedaría"
                : "Se pasaría del total"}
          </dt>
          <dd className="m-0 font-bold tabular-nums">
            {quedaDespues === 0 ? "al día" : dinero(Math.abs(quedaDespues))}
          </dd>
        </div>
      </dl>

      {/* Pasarse del total no se puede confirmar: el servidor lo rechaza. Se
          dice aquí para que no se intente, no para sustituir esa defensa. */}
      {quedaDespues < 0 ? (
        <p className="m-0 mt-2 rounded-[10px] border border-line bg-bg px-3 py-2 text-[13px]">
          Entre lo cobrado y esto se pasa del total del pedido. Revise si la captura es de
          este pedido antes de confirmarla.
        </p>
      ) : null}

      {sinCuenta ? (
        <p className="m-0 mt-2 rounded-[10px] border border-line bg-bg px-3 py-2 text-[13px]">
          <strong>{NOMBRE_METODO[c.metodo] ?? c.metodo}</strong> todavía no tiene cuenta en
          la contabilidad. El cobro se registra y el pedido avanza, pero no va a quedar
          asiento: aparecerá en «todo el dinero que entró tiene su asiento» al cerrar el
          mes, para anotar a mano a dónde fue.
        </p>
      ) : null}

      {/* La captura. Se carga solo cuando se pide: en la bandeja puede haber
          veinte, y veinte imágenes de banco son varios megas de datos del
          teléfono de la dueña por una pantalla que quizá solo mira una. */}
      {c.comprobanteR2 === null ? (
        <p className="m-0 mt-3 text-[13px] text-muted">
          Sin captura. Quien lo anotó lo vio por otro medio; si no está seguro, pregunte
          antes de confirmar.
        </p>
      ) : verCaptura ? (
        <figure className="m-0 mt-3">
          <img
            src={`/api/cobros/${c.pagoId}/comprobante`}
            alt={`Captura del pago de ${c.cliente ?? "la clienta"} por ${dinero(c.montoCents)}`}
            className="block h-auto w-full rounded-[12px] border border-line"
          />
          <figcaption className="mt-1 text-[12px] text-muted">
            Compare el monto, la fecha y a quién se le pagó.
          </figcaption>
        </figure>
      ) : (
        <button type="button" className={`${SUAVE} mt-3 w-full`} onClick={() => setVerCaptura(true)}>
          Ver la captura
        </button>
      )}

      {error !== null ? (
        <p role="alert" className="m-0 mt-3 text-[13px] font-bold">
          {error}
        </p>
      ) : null}

      {puede ? (
        <div className="mt-3 grid gap-2">
          {rechazando ? (
            <>
              <label className="block">
                <span className="mb-1 block text-[13px] font-bold">Por qué se rechaza</span>
                <input
                  type="text"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="La captura es de otro pedido, el monto no cuadra…"
                  className={ENTRADA}
                />
              </label>
              {/* Un rechazo sin motivo no le sirve a nadie: mañana la clienta
                  insiste en que ya pagó y quien lo mire no sabrá por qué se
                  dijo que no. El servidor también lo exige. */}
              <button
                type="button"
                disabled={trabajando || motivo.trim() === ""}
                className={`${PRINCIPAL} w-full`}
                onClick={() => mandar(`/api/cobros/${c.pagoId}/rechazar`, { motivo })}
              >
                {trabajando ? "Rechazando…" : "Rechazar este comprobante"}
              </button>
              <button
                type="button"
                disabled={trabajando}
                className={`${SUAVE} w-full`}
                onClick={() => setRechazando(false)}
              >
                Mejor no
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={trabajando}
                className={`${PRINCIPAL} w-full`}
                onClick={() => mandar(`/api/cobros/${c.pagoId}/confirmar`, {})}
              >
                {trabajando ? "Confirmando…" : "Confirmar: el dinero entró"}
              </button>
              <button
                type="button"
                disabled={trabajando}
                className={`${SUAVE} w-full`}
                onClick={() => setRechazando(true)}
              >
                No cuadra
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="m-0 mt-3 text-[13px] text-muted">
          Solo quien lleva los cobros puede confirmar o rechazar.
        </p>
      )}
    </Tarjeta>
  );
}

export function Cobros() {
  // Del armazón, como el resto de las pantallas: así ninguna vuelve a pedir
  // `/api/yo` por su cuenta.
  const yo = useOutletContext<Yo>();
  // Se recarga la bandeja entera al confirmar en vez de quitar la ficha de la
  // lista: confirmar un pago mueve el pedido (puede agendarse) y las cifras de
  // los OTROS comprobantes del mismo pedido cambian. Quitar solo la ficha
  // dejaría a las demás diciendo lo de antes.
  const [vuelta, setVuelta] = useState(0);
  const datos = useCarga<{ comprobantes: Comprobante[]; hayMas: boolean }>("/api/cobros", [
    vuelta,
  ]);
  // El nivel lo calculó el SERVIDOR y viene en `/api/yo`. No se vuelve a
  // derivar del rol aquí: dos sitios calculando la misma matriz acaban
  // discrepando, y el que se equivoca del lado flojo es el que nadie revisa.
  const puede = yo.permisos["cobros"] === "editar";

  return (
    <div className="grid gap-4">
      <Tarjeta>
        <h2 className="m-0 text-[17px] font-bold">Comprobantes por confirmar</h2>
        <p className="m-0 mt-1 text-[13px] text-muted">
          Una captura que manda una clienta es algo que <strong>alguien tiene que mirar</strong>,
          no un pago. Hasta que se confirme, el pedido no se mueve y el dinero no entra en
          los libros.
        </p>
      </Tarjeta>

      <Carga estado={datos} que="los comprobantes">
        {(d) =>
          d.comprobantes.length === 0 ? (
            <Vacio
              titulo="No hay nada por confirmar"
              detalle="Cuando entre un comprobante —de la web, de WhatsApp o anotado aquí— va a aparecer en esta lista con su captura y las cifras del pedido."
            />
          ) : (
            <div className="grid gap-3">
              {d.comprobantes.map((c) => (
                <Ficha
                  key={c.pagoId}
                  c={c}
                  puede={puede}
                  alHecho={() => setVuelta((v) => v + 1)}
                />
              ))}
              {d.hayMas ? (
                <p className="m-0 text-[13px] text-muted">
                  Hay más de los que caben aquí. Confirme o rechace estos y aparecerán los
                  siguientes.
                </p>
              ) : null}
            </div>
          )
        }
      </Carga>
    </div>
  );
}
