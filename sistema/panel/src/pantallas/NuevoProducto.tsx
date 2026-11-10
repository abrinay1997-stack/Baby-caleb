import { useState } from "react";
import { pedir } from "../api";
import { Hoja } from "../armazon/Hoja";
import { aCentavos, aPuntosBasicos } from "../dinero";

/**
 * Dar de alta un producto con su primera presentación.
 *
 * Son DOS cosas en la base —un producto y una variante— y aquí es una sola
 * pantalla a propósito. Un producto sin ninguna variante no se puede vender ni
 * tiene precio: dejarlo crear a solas produce fichas vacías que nadie entiende
 * después, y la pregunta «¿y ahora dónde le pongo el precio?» no tiene buena
 * respuesta.
 *
 * Las demás tallas se añaden después, desde el producto ya creado.
 */

const FAMILIAS = [
  { valor: "panal", etiqueta: "Pañales" },
  { valor: "pants", etiqueta: "Pants" },
  { valor: "wipes", etiqueta: "Wipes" },
  { valor: "ropa", etiqueta: "Ropa" },
  { valor: "accesorio", etiqueta: "Accesorios" },
  { valor: "otro", etiqueta: "Otro" },
];

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

export function NuevoProducto({
  abierta,
  alCerrar,
  alCrear,
}: {
  abierta: boolean;
  alCerrar: () => void;
  alCrear: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [familia, setFamilia] = useState("panal");
  const [codigo, setCodigo] = useState("");
  const [talla, setTalla] = useState("");
  const [porCaja, setPorCaja] = useState("");
  const [precio, setPrecio] = useState("");
  const [itbms, setItbms] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  function limpiar() {
    setNombre("");
    setFamilia("panal");
    setCodigo("");
    setTalla("");
    setPorCaja("");
    setPrecio("");
    setItbms("");
    setError(null);
  }

  async function crear() {
    const centavos = aCentavos(precio);
    if (nombre.trim() === "") return setError("Póngale un nombre al producto.");
    if (centavos === null || centavos <= 0) {
      return setError("El precio no se entiende. Escríbalo como 12.50");
    }
    const caja = Number(porCaja);
    if (!Number.isSafeInteger(caja) || caja <= 0) {
      return setError("Las unidades por caja tienen que ser un número mayor que cero.");
    }
    const bp = itbms.trim() === "" ? null : aPuntosBasicos(itbms);
    if (itbms.trim() !== "" && bp === null) {
      return setError("El ITBMS no se entiende. Escríbalo como 7");
    }

    setGuardando(true);
    setError(null);
    try {
      // UNA llamada, no dos. En dos, si la segunda falla —un código repetido—
      // queda un producto sin presentaciones, y ese no se puede ver ni
      // arreglar desde aquí: la lista del catálogo sale de `variantes JOIN
      // productos`, así que lo que no tiene variantes no aparece en ninguna
      // parte. El servidor lo hace en un batch, que es una transacción.
      await pedir("/api/catalogo/altas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          familia,
          nombre: nombre.trim(),
          slug: "",
          codigo: codigo.trim().toUpperCase(),
          talla: talla.trim() === "" ? null : talla.trim(),
          unidadesPorCaja: caja,
          precioCents: centavos,
          tasaItbmsBp: bp,
        }),
      });

      alCrear();
      limpiar();
      alCerrar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Hoja
      abierta={abierta}
      titulo="Producto nuevo"
      alCerrar={() => {
        limpiar();
        alCerrar();
      }}
      pie={
        <>
          <button
            type="button"
            onClick={() => {
              limpiar();
              alCerrar();
            }}
            className={`${BOTON} border border-line`}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={crear}
            disabled={guardando}
            className={`${BOTON} bg-accent text-accent-fg disabled:opacity-50`}
          >
            {guardando ? "Creando…" : "Crear"}
          </button>
        </>
      }
    >
      {error === null ? null : (
        <p role="alert" className="mt-0 mb-4 rounded-[12px] border border-line bg-bg p-3 font-bold">
          {error}
        </p>
      )}

      <p className="mt-0 mb-4 text-muted">
        Se crea sin publicar. Revíselo y después decida si sale a la web.
      </p>

      <Campo etiqueta="Nombre del producto">
        <input
          className={ENTRADA}
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Pañal Nateen"
        />
      </Campo>

      <Campo etiqueta="Tipo">
        <select className={ENTRADA} value={familia} onChange={(e) => setFamilia(e.target.value)}>
          {FAMILIAS.map((f) => (
            <option key={f.valor} value={f.valor}>
              {f.etiqueta}
            </option>
          ))}
        </select>
      </Campo>

      <Campo
        etiqueta="Código"
        ayuda="En mayúsculas, sin espacios. Es lo que repite el bot y lo que queda escrito en cada pedido: NAT-M, BC-001-03."
      >
        <input
          className={ENTRADA}
          value={codigo}
          // Se pasa a mayúsculas al escribir y no al guardar: así se ve lo que
          // va a quedar guardado mientras se teclea, en vez de descubrirlo
          // después.
          onChange={(e) => setCodigo(e.target.value.toUpperCase())}
          placeholder="NAT-M"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
      </Campo>

      <Campo etiqueta="Talla" ayuda="Déjelo vacío si este producto no tiene tallas.">
        <input className={ENTRADA} value={talla} onChange={(e) => setTalla(e.target.value)} />
      </Campo>

      <Campo etiqueta="Unidades por caja">
        <input
          className={ENTRADA}
          inputMode="numeric"
          value={porCaja}
          onChange={(e) => setPorCaja(e.target.value)}
        />
      </Campo>

      <Campo etiqueta="Precio">
        <input
          className={ENTRADA}
          inputMode="decimal"
          value={precio}
          onChange={(e) => setPrecio(e.target.value)}
          placeholder="12.50"
        />
      </Campo>

      <Campo etiqueta="ITBMS" ayuda="En por ciento. Si todavía no lo sabe, déjelo vacío: vacío no es cero.">
        <input
          className={ENTRADA}
          inputMode="decimal"
          value={itbms}
          onChange={(e) => setItbms(e.target.value)}
          placeholder="7"
        />
      </Campo>
    </Hoja>
  );
}
