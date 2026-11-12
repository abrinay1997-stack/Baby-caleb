import { describe, expect, it, vi } from 'vitest';
import {
  FUENTE,
  ID_DEL_SCRIPT,
  META_DEL_PIXEL,
  activarPixel,
  esIdDePixel,
  idDelPixelDe,
  pixelYaCargado,
  type DocumentoDelPixel,
  type EntornoDelPixel,
  type ScriptDelPixel,
  type VentanaDelPixel,
} from '../src/consentimiento/pixel';
import type { Decision } from '../src/consentimiento/consentimiento';

/**
 * LA PRUEBA QUE IMPORTA: sin consentimiento no se inyecta el píxel.
 *
 * El píxel de Meta es un rastreador de un tercero. En Panamá rige la Ley 81 de
 * 2019 de protección de datos personales, y la lectura que aplica esta web es
 * la conservadora: eso no se carga antes de que la persona lo acepte. Esa
 * frase, que en un documento es una intención, aquí la comprueba una máquina.
 *
 * ## Por qué se prueba con un navegador de juguete
 *
 * Las pruebas de la web corren en Node, donde no existe `document`. Por eso
 * `activarPixel` recibe el entorno por parámetro: la prueba le pasa un
 * documento falso que APUNTA todo lo que se le pide crear y colgar, y después
 * mira la lista. Es la MISMA función que llama el banner —no una copia ni una
 * capa de abajo—, que es lo que pide la trampa §6 de `docs/TRAMPAS.md`.
 *
 * Lo que esto NO cubre, y se dice en vez de disimularlo: que
 * `BannerConsentimiento.tsx` llame a `activarPixel` y no se salte la guarda
 * por su cuenta. Para eso haría falta un DOM de verdad en las pruebas, que
 * hoy este repositorio no tiene. La guarda está en UNA función y el banner la
 * llama en dos sitios, los dos con la decisión que acaba de leer o de
 * guardar.
 *
 * ## Validada por mutación
 *
 * Quitando las dos líneas de la guarda del consentimiento en
 * `src/consentimiento/pixel.ts`, los casos de «sin decisión» y «rechazado» se
 * ponen rojos. Está hecho y comprobado.
 */

/** El identificador real del píxel de Baby Caleb. Aquí solo es un número. */
const ID = '1339346164908302';

interface Falso extends EntornoDelPixel {
  /** Todo lo que se llegó a crear. Si tiene algo, se inyectó algo. */
  readonly creados: ScriptDelPixel[];
  /** Lo que de verdad se colgó del `<head>`. */
  readonly colgados: ScriptDelPixel[];
}

/**
 * Un navegador de juguete, con el identificador del píxel ya puesto.
 *
 * Trae el `<meta>` a propósito: así el único motivo posible para que no se
 * cargue nada es el consentimiento. Si el falso no tuviera identificador, la
 * prueba pasaría por el motivo equivocado y seguiría verde con la guarda del
 * consentimiento borrada — que es la trampa §1, un control que comprueba algo
 * que ya era cierto.
 */
function navegadorFalso(idEnLaPagina: string | null = ID): Falso {
  const creados: ScriptDelPixel[] = [];
  const colgados: ScriptDelPixel[] = [];
  const ventana: VentanaDelPixel = {};

  const documento: DocumentoDelPixel = {
    getElementById: (id) => colgados.find((s) => s.id === id) ?? null,
    querySelector: (selector) =>
      selector === `meta[name="${META_DEL_PIXEL}"]` && idEnLaPagina !== null
        ? { getAttribute: () => idEnLaPagina }
        : null,
    createElement: () => {
      const script: ScriptDelPixel = { id: '', async: false, src: '' };
      creados.push(script);
      return script;
    },
    head: { appendChild: (nodo) => colgados.push(nodo) },
  };

  return { ventana, documento, creados, colgados };
}

describe('sin consentimiento NO se inyecta el script del píxel', () => {
  // `null` es «todavía no ha elegido»: el caso de quien entra por primera vez
  // y todavía está leyendo el banner.
  for (const decision of [null, 'rechazado'] as (Decision | null)[]) {
    const comoSeLlama = decision === null ? 'sin decisión' : 'con un «no»';

    it(`${comoSeLlama}: no se crea ni se cuelga ningún <script>`, () => {
      const falso = navegadorFalso();

      const r = activarPixel(decision, falso);

      expect(r.cargado).toBe(false);
      expect(r.motivo).toBe(decision === null ? 'sin_decision' : 'rechazado');
      // Las dos listas, no solo la de colgados: crear el elemento con el `src`
      // puesto y no colgarlo ya sería medio camino hecho, y el día que alguien
      // mueva el `appendChild` dentro de la guarda esto lo caza.
      expect(falso.creados, 'se creó un <script> sin permiso').toEqual([]);
      expect(falso.colgados, 'se colgó un <script> sin permiso').toEqual([]);
    });

    it(`${comoSeLlama}: tampoco se prepara \`fbq\` en la ventana`, () => {
      const falso = navegadorFalso();
      activarPixel(decision, falso);
      // `fbq` es la cola donde Meta apunta las llamadas. Dejarla puesta sin
      // permiso no manda nada hoy, pero convierte «cargar el píxel» en una
      // línea de otro archivo — y eso es la mitad del rastreador instalado.
      expect(falso.ventana.fbq).toBeUndefined();
      expect(falso.ventana._fbq).toBeUndefined();
    });
  }

  it('y no hay ningún camino que cargue nada sin un «aceptado»', () => {
    // Fuerza bruta sobre las tres decisiones posibles por las dos situaciones
    // del interruptor. Solo una casilla de las seis puede cargar.
    const cargaron: string[] = [];
    for (const decision of [null, 'rechazado', 'aceptado'] as (Decision | null)[]) {
      for (const enLaPagina of [null, ID]) {
        const falso = navegadorFalso(enLaPagina);
        if (activarPixel(decision, falso).cargado) {
          cargaron.push(`${String(decision)} + ${enLaPagina === null ? 'apagado' : 'encendido'}`);
        }
      }
    }
    expect(cargaron).toEqual(['aceptado + encendido']);
  });
});

describe('con un sí, y solo con el interruptor encendido, sí carga', () => {
  it('cuelga el script de Meta, una sola vez, con su identificador', () => {
    const falso = navegadorFalso();

    const r = activarPixel('aceptado', falso);

    expect(r).toEqual({ cargado: true, motivo: 'cargado' });
    expect(falso.colgados).toHaveLength(1);
    expect(falso.colgados[0]).toEqual({ id: ID_DEL_SCRIPT, async: true, src: FUENTE });

    // Volver a aceptar en la misma pestaña no cuelga un segundo script: dos
    // contarían la visita dos veces.
    const otra = activarPixel('aceptado', falso);
    expect(otra).toEqual({ cargado: false, motivo: 'ya_estaba' });
    expect(falso.colgados).toHaveLength(1);
  });

  it('el interruptor apagado manda por encima del sí', () => {
    // Es lo que permite desplegar todo este aparato sin encender el rastreo:
    // `META_PIXEL_ID` vacío en `wrangler.jsonc`, nadie medido.
    const falso = navegadorFalso(null);
    expect(activarPixel('aceptado', falso)).toEqual({ cargado: false, motivo: 'sin_id' });
    expect(falso.colgados).toEqual([]);
  });

  it('un identificador que no es un número tampoco carga, y lo deja dicho', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const falso = navegadorFalso('no-soy-un-numero');
      expect(activarPixel('aceptado', falso)).toEqual({
        cargado: false,
        motivo: 'id_invalido',
      });
      expect(falso.colgados).toEqual([]);
      expect(avisos).toHaveBeenCalled();
    } finally {
      avisos.mockRestore();
    }
  });
});

describe('el identificador del píxel se mira antes de usarlo', () => {
  it('acepta un número de 10 a 20 cifras y nada más', () => {
    expect(esIdDePixel(ID)).toBe(true);
    for (const malo of ['', '   ', '123', '1'.repeat(21), '12345678901a', '1234" onload="x']) {
      expect(esIdDePixel(malo), `aceptó «${malo}»`).toBe(false);
    }
  });

  it('una página sin la etiqueta no tiene identificador', () => {
    expect(idDelPixelDe(navegadorFalso(null).documento)).toBeNull();
    // Una etiqueta presente pero vacía cuenta igual que ausente: es como
    // queda si alguien escribe la variable de configuración en blanco.
    expect(idDelPixelDe(navegadorFalso('').documento)).toBeNull();
    expect(idDelPixelDe(navegadorFalso('   ').documento)).toBeNull();
  });
});

describe('retirar el permiso con el píxel ya cargado', () => {
  /**
   * `pixelYaCargado` es lo que distingue «nunca cargó» de «está corriendo y la
   * persona acaba de decir que no». El banner recarga la página en el segundo
   * caso, porque un `<script>` que ya corrió no se desejecuta quitando su
   * etiqueta y `fbq` se queda definido con su cola dentro: sin eso, el «no» no
   * empezaría a valer hasta la siguiente recarga y Meta seguiría recibiendo
   * durante el resto de la visita.
   */
  it('se sabe que está cargado solo después de cargarlo', () => {
    const falso = navegadorFalso();
    expect(pixelYaCargado(falso.documento)).toBe(false);

    activarPixel('aceptado', falso);
    expect(pixelYaCargado(falso.documento)).toBe(true);
  });

  it('y una página que lo rechazó desde el principio nunca lo tuvo', () => {
    // El contrapeso: si `pixelYaCargado` dijera `true` siempre, el banner
    // recargaría la página a quien dice «no» la primera vez, sin motivo.
    const falso = navegadorFalso();
    activarPixel('rechazado', falso);
    expect(pixelYaCargado(falso.documento)).toBe(false);
  });
});
