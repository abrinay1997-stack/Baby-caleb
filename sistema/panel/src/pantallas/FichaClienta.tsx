import { useState } from "react";
import { dinero, fecha, pedir, useCarga } from "../api";
import { Hoja } from "../armazon/Hoja";
import { Carga, Pastilla } from "../componentes";
import { ISO_DE_PROVINCIA, PAIS_PANAMA, PROVINCIAS } from "../../../src/dominio/provincias";

/**
 * La ficha de una clienta, abierta desde la lista.
 *
 * ESTA HOJA EXISTE POR DOS COSAS QUE TODAVÍA NO SE HACEN
 *
 * Cobrar con tarjeta y emitir una factura. Para lo primero, la pasarela exige
 * el apellido SEPARADO del nombre y la dirección con ciudad, provincia en ISO,
 * código postal y país; para lo segundo hace falta la cédula o el RUC, que la
 * pasarela no devuelve nunca —ese campo no existe en su API— así que o se
 * escribe aquí o no existe el día que haya que facturar.
 *
 * Por eso lo primero que se ve no son los campos: es QUÉ FALTA. Un formulario
 * con doce casillas vacías no dice cuáles importan; una línea que dice «para
 * cobrar con tarjeta falta el apellido y el código postal» sí.
 *
 * UN CAMPO VACÍO NO ES UN ERROR
 *
 * Vacío significa «todavía no se lo hemos preguntado». Se guarda en blanco, se
 * vuelve a ver en la lista de lo que falta, y ya está. Rellenarlo a ojo para
 * que el formulario se vea completo sería peor que dejarlo: un código postal
 * inventado pasa el control y rebota en el cobro.
 */

export interface ClientaDeFicha {
  id: string;
  nombre: string | null;
  apellido: string | null;
  celular_e164: string | null;
  correo: string | null;
  identificacion: string | null;
  identificacion_tipo: string | null;
  notas: string | null;
  creado_en: number;
  actualizado_en: number;
  fusionado_en_id: string | null;
  anonimizado_en: number | null;
}

export interface DireccionDeFicha {
  id: string;
  zona: string | null;
  texto: string;
  referencia: string | null;
  ciudad: string | null;
  provincia_iso: string | null;
  codigo_postal: string | null;
  pais: string | null;
  activa: number;
}

export interface PedidoDeFicha {
  id: string;
  numero: string;
  estado: string;
  estado_pago: string;
  creado_en: number;
  lineas: number;
  total_cents: number | null;
  saldo_cents: number | null;
}

export interface Ficha {
  clienta: ClientaDeFicha;
  direcciones: DireccionDeFicha[];
  pedidos: PedidoDeFicha[];
  falta: { paraTarjeta: string[]; paraFactura: string[] };
}

const NOMBRE_ESTADO: Record<string, string> = {
  por_abonar: "Por abonar",
  agendado: "Agendado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  devuelto: "Devuelto",
};

// 16 px en los campos es contrato (§7b): por debajo, el teléfono hace zoom al
// tocar y la persona termina peleando con el viewport en vez de escribiendo.
const ENTRADA =
  "tactil w-full rounded-[12px] border border-line bg-bg px-3 py-2.5 " +
  "focus-visible:outline-accent-edge focus-visible:outline-2";

const BOTON =
  "tactil flex-1 rounded-[14px] px-4 py-3 font-bold focus-visible:outline-accent-edge focus-visible:outline-2";

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[14px] font-bold">{etiqueta}</span>
      {children}
      {ayuda === undefined ? null : (
        <span className="mt-1 block text-[12px] text-muted">{ayuda}</span>
      )}
    </label>
  );
}

/**
 * «6000-0001», que es como se lee y se teclea un celular panameño.
 *
 * La base lo guarda como `50760000001` porque es lo que entiende una pasarela,
 * pero eso no se le enseña a nadie: el campo dice «escríbalo como 6000-0001» y
 * luego traía once dígitos pegados. El servidor normaliza las dos formas a la
 * misma fila, así que lo que vuelve es idéntico.
 */
export function celularLegible(e164: string | null): string {
  if (e164 === null) return "Sin celular";
  const local = e164.startsWith("507") ? e164.slice(3) : e164;
  return local.length === 8 ? `${local.slice(0, 4)}-${local.slice(4)}` : e164;
}

/** «el apellido y el código postal» — una frase, no una lista de viñetas. */
function enFrase(trozos: string[]): string {
  if (trozos.length === 1) return trozos[0]!;
  return `${trozos.slice(0, -1).join(", ")} y ${trozos[trozos.length - 1]}`;
}

/**
 * Lo que falta, para cada cosa.
 *
 * La lista la calcula el SERVIDOR: quien sabe qué exige la pasarela es el
 * sistema, no la pantalla. Aquí solo se pinta, y se pinta en ámbar y no en
 * rojo: no está roto, está incompleto, y son dos cosas distintas.
 */
function Falta({ para, lista }: { para: string; lista: string[] }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="m-0 text-[13px] font-bold">{para}</p>
      {lista.length === 0 ? (
        <Pastilla tono="bien">Ya está todo</Pastilla>
      ) : (
        <p className="m-0 text-muted">Falta {enFrase(lista)}.</p>
      )}
    </div>
  );
}

export function FichaClienta({
  clienteId,
  alCerrar,
  alGuardar,
  puedeTocar,
}: {
  clienteId: string;
  alCerrar: () => void;
  /** Se llama cuando algo cambió de verdad, para que la lista se recargue. */
  alGuardar: () => void;
  puedeTocar: boolean;
}) {
  const [recarga, setRecarga] = useState(0);
  const estado = useCarga<Ficha>(`/api/clientes/${clienteId}`, [recarga]);

  const [cargado, setCargado] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [celular, setCelular] = useState("");
  const [correo, setCorreo] = useState("");
  const [identificacion, setIdentificacion] = useState("");
  const [tipo, setTipo] = useState("");
  const [notas, setNotas] = useState("");
  const [direccionId, setDireccionId] = useState("");
  const [ciudad, setCiudad] = useState("");
  const [provincia, setProvincia] = useState("");
  const [postal, setPostal] = useState("");
  const [pais, setPais] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const ficha = estado.fase === "listo" ? estado.datos : null;

  // Los campos se llenan cuando llega la ficha, no en cada render: si no, cada
  // tecla se perdería al volver a pintar. Se recuerda CON QUÉ se llenaron para
  // que un guardado —que recarga— vuelva a traer lo que quedó en la base.
  const sello = ficha === null ? null : `${ficha.clienta.id}:${ficha.clienta.actualizado_en}:${recarga}`;
  if (ficha !== null && sello !== null && cargado !== sello) {
    setCargado(sello);
    setNombre(ficha.clienta.nombre ?? "");
    setApellido(ficha.clienta.apellido ?? "");
    setCelular(ficha.clienta.celular_e164 === null ? "" : celularLegible(ficha.clienta.celular_e164));
    setCorreo(ficha.clienta.correo ?? "");
    setIdentificacion(ficha.clienta.identificacion ?? "");
    setTipo(ficha.clienta.identificacion_tipo ?? "");
    setNotas(ficha.clienta.notas ?? "");
    const principal = ficha.direcciones.find((d) => d.activa === 1) ?? ficha.direcciones[0] ?? null;
    setDireccionId(principal?.id ?? "");
    setCiudad(principal?.ciudad ?? "");
    setProvincia(principal?.provincia_iso ?? "");
    setPostal(principal?.codigo_postal ?? "");
    setPais(principal?.pais ?? "");
    setError(null);
  }

  /** Cambiar de dirección no pierde lo escrito de la otra: se recarga la hoja. */
  function elegirDireccion(id: string) {
    const d = ficha?.direcciones.find((x) => x.id === id) ?? null;
    setDireccionId(id);
    setCiudad(d?.ciudad ?? "");
    setProvincia(d?.provincia_iso ?? "");
    setPostal(d?.codigo_postal ?? "");
    setPais(d?.pais ?? "");
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await pedir(`/api/clientes/${clienteId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nombre,
          apellido,
          // El celular vacío NO se manda: hay fichas que nacieron de un pago en
          // la web sin teléfono, y mandarlo vacío las dejaría sin poder
          // guardar nada —el servidor no acepta un celular en blanco, porque
          // es la llave contra los duplicados— justo a las que más falta les
          // hace completar.
          ...(celular.trim() === "" ? {} : { celular }),
          correo,
          identificacion,
          identificacionTipo: tipo,
          notas,
          // Sin dirección guardada no hay nada que facturar todavía: se manda
          // solo cuando hay una, y nunca se inventa una fila nueva desde aquí.
          ...(direccionId === ""
            ? {}
            : {
                direccion: {
                  id: direccionId,
                  ciudad,
                  provinciaIso: provincia,
                  codigoPostal: postal,
                  pais,
                },
              }),
        }),
      });
      alGuardar();
      // Se recarga en vez de cerrar: lo que acaba de cambiar es «qué falta», y
      // esa es la respuesta que la persona vino a buscar.
      setRecarga((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  // Un código guardado que no esté en la lista no se pierde de vista: se añade
  // como opción. Si Tilopay acepta uno que aquí no está, hay que verlo escrito,
  // no descubrir que la pantalla lo borró al guardar.
  const codigos = PROVINCIAS.map((p) => [ISO_DE_PROVINCIA[p], p] as const);
  const opcionesProvincia =
    provincia !== "" && !codigos.some(([iso]) => iso === provincia)
      ? [...codigos, [provincia, provincia] as const]
      : codigos;

  const sinTocar = ficha !== null && (ficha.clienta.anonimizado_en !== null || ficha.clienta.fusionado_en_id !== null);
  const editable = puedeTocar && !sinTocar;

  return (
    <Hoja
      abierta
      titulo={ficha?.clienta.nombre ?? "Ficha de la clienta"}
      alCerrar={alCerrar}
      pie={
        <>
          <button type="button" onClick={alCerrar} className={`${BOTON} border border-line`}>
            Cerrar
          </button>
          {editable ? (
            <button
              type="button"
              onClick={guardar}
              disabled={guardando}
              className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          ) : null}
        </>
      }
    >
      <Carga estado={estado} que="la ficha">
        {(d) => (
          <>
            {error === null ? null : (
              <p
                role="alert"
                className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3 font-bold"
              >
                {error}
              </p>
            )}

            {d.clienta.fusionado_en_id === null ? null : (
              <p className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3">
                Esta ficha se unió con otra. Lo suyo está en la que quedó viva; esta se deja
                solamente para que los pedidos viejos sigan teniendo a quién apuntar.
              </p>
            )}
            {d.clienta.anonimizado_en === null ? null : (
              <p className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3">
                Los datos de esta persona se borraron a petición suya. No se vuelven a escribir.
              </p>
            )}

            <section className="mb-4 rounded-[12px] border border-line bg-bg p-3">
              <Falta para="Para cobrarle con tarjeta" lista={d.falta.paraTarjeta} />
              <Falta para="Para hacerle una factura" lista={d.falta.paraFactura} />
            </section>

            <Campo etiqueta="Nombre">
              <input
                className={ENTRADA}
                value={nombre}
                disabled={!editable}
                onChange={(e) => setNombre(e.target.value)}
              />
            </Campo>

            <Campo
              etiqueta="Apellido"
              ayuda="Aparte del nombre, porque el cobro con tarjeta los pide por separado."
            >
              <input
                className={ENTRADA}
                value={apellido}
                disabled={!editable}
                onChange={(e) => setApellido(e.target.value)}
              />
            </Campo>

            <Campo
              etiqueta="Celular"
              ayuda="Es por donde se la encuentra. Escríbalo como 6000-0001. Un celular guardado no se borra desde aquí: se corrige escribiendo el nuevo."
            >
              <input
                className={ENTRADA}
                inputMode="tel"
                value={celular}
                disabled={!editable}
                onChange={(e) => setCelular(e.target.value)}
              />
            </Campo>

            <Campo etiqueta="Correo" ayuda="A este correo le llega el recibo del cobro con tarjeta.">
              <input
                className={ENTRADA}
                type="email"
                value={correo}
                disabled={!editable}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="nombre@correo.com"
              />
            </Campo>

            <Campo
              etiqueta="Cédula o RUC"
              ayuda="Para la factura. Escríbalo como lo trae el documento; aquí no se corrige nada."
            >
              <div className="flex flex-wrap gap-2">
                <select
                  className={`${ENTRADA} basis-[9rem] grow`}
                  value={tipo}
                  disabled={!editable}
                  onChange={(e) => setTipo(e.target.value)}
                  aria-label="Qué es ese número"
                >
                  <option value="">Todavía no</option>
                  <option value="cedula">Cédula</option>
                  <option value="ruc">RUC</option>
                </select>
                <input
                  className={`${ENTRADA} basis-[12rem] grow`}
                  value={identificacion}
                  disabled={!editable}
                  onChange={(e) => setIdentificacion(e.target.value)}
                  aria-label="El número"
                />
              </div>
            </Campo>

            <h3 className="mb-1 mt-5 text-[15px] font-bold">Dirección para la factura</h3>
            {d.direcciones.length === 0 ? (
              <p className="mt-0 mb-4 text-muted">
                Todavía no tiene ninguna dirección guardada. Se guarda la primera vez que se le
                toma un pedido con envío; hasta entonces no se le puede cobrar con tarjeta.
              </p>
            ) : (
              <>
                <p className="mt-0 mb-3 text-muted">
                  La calle y las señas no se tocan aquí: son las que lee el motorizado para
                  llegar. Esto es lo que pide la pasarela además de eso.
                </p>

                {d.direcciones.length > 1 ? (
                  <Campo etiqueta="Cuál dirección">
                    <select
                      className={ENTRADA}
                      value={direccionId}
                      disabled={!editable}
                      onChange={(e) => elegirDireccion(e.target.value)}
                    >
                      {d.direcciones.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.texto}
                          {x.activa === 1 ? "" : " (en desuso)"}
                        </option>
                      ))}
                    </select>
                  </Campo>
                ) : (
                  <p className="mt-0 mb-4 font-bold">{d.direcciones[0]?.texto}</p>
                )}

                <Campo etiqueta="Ciudad o corregimiento">
                  <input
                    className={ENTRADA}
                    value={ciudad}
                    disabled={!editable}
                    onChange={(e) => setCiudad(e.target.value)}
                  />
                </Campo>

                <Campo etiqueta="Provincia">
                  <select
                    className={ENTRADA}
                    value={provincia}
                    disabled={!editable}
                    onChange={(e) => setProvincia(e.target.value)}
                  >
                    <option value="">Todavía no</option>
                    {opcionesProvincia.map(([iso, nombreProvincia]) => (
                      <option key={iso} value={iso}>
                        {nombreProvincia}
                      </option>
                    ))}
                  </select>
                </Campo>

                <Campo
                  etiqueta="Código postal"
                  ayuda="En Panamá no hace falta para entregar, pero la pasarela lo pide igual."
                >
                  <input
                    className={ENTRADA}
                    inputMode="numeric"
                    value={postal}
                    disabled={!editable}
                    onChange={(e) => setPostal(e.target.value)}
                  />
                </Campo>

                <Campo etiqueta="País">
                  <select
                    className={ENTRADA}
                    value={pais}
                    disabled={!editable}
                    onChange={(e) => setPais(e.target.value)}
                  >
                    <option value="">Todavía no</option>
                    <option value={PAIS_PANAMA}>Panamá</option>
                    {/* Un país guardado que no sea Panamá no se pierde de
                        vista: se añade como opción en vez de borrarlo al
                        guardar sin que nadie lo vea. */}
                    {pais !== "" && pais !== PAIS_PANAMA ? (
                      <option value={pais}>{pais}</option>
                    ) : null}
                  </select>
                </Campo>
              </>
            )}

            <Campo etiqueta="Notas" ayuda="Lo que haga falta recordar de ella. No sale de aquí.">
              <textarea
                className={ENTRADA}
                rows={2}
                value={notas}
                disabled={!editable}
                onChange={(e) => setNotas(e.target.value)}
              />
            </Campo>

            <h3 className="mb-1 mt-5 text-[15px] font-bold">Sus pedidos</h3>
            {d.pedidos.length === 0 ? (
              <p className="m-0 text-muted">Todavía no le hemos vendido nada.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {d.pedidos.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-2 last:border-0"
                  >
                    <span>
                      <span className="block font-bold">{p.numero}</span>
                      <span className="block text-[12px] text-muted">
                        {fecha(p.creado_en)} · {NOMBRE_ESTADO[p.estado] ?? p.estado}
                      </span>
                    </span>
                    {/* Nulo y cero no son lo mismo: nulo es «usted no ve el
                        dinero», cero es «no debe nada». */}
                    <span className="shrink-0 font-bold">
                      {p.total_cents === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        dinero(p.total_cents)
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Carga>
    </Hoja>
  );
}
