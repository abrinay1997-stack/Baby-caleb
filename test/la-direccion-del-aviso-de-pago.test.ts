import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La dirección a la que Yappy manda el aviso de pago está escrita en TRES
 * sitios, y los tres tienen que decir lo mismo.
 *
 * ## Qué pasa si no
 *
 * Nada. No falla ninguna prueba, no se cae ninguna pantalla y el botón de pagar
 * funciona igual de bien: la clienta paga, el dinero entra en la cuenta de
 * Yappy y el pedido se queda sin confirmar para siempre. Es la peor forma de
 * romperse que hay en todo el repositorio, porque el único síntoma aparece
 * días después, en la cara de una clienta que ya pagó.
 *
 * Los tres sitios:
 *
 *  1. `sistema/src/rpc/web.ts` — la URL que se le DA a Yappy en cada cobro.
 *  2. `worker/index.ts` — la ruta que la web ATIENDE cuando Yappy llama.
 *  3. `worker/visibilidad.ts` — la ruta eximida de la redirección a canónico,
 *     para que también conteste por `www`, que es el dominio declarado.
 *
 * Es la trampa §8 en su forma más cara: la lista de configuración que alguien
 * tiene que acordarse de tocar. Por eso la vigila una máquina.
 *
 * ## Romper a propósito
 *
 * Cambie la ruta en cualquiera de los tres. Cada uno pone roja su casilla —
 * los tres lo hicieron al validar esto.
 *
 * Se leen como TEXTO porque `sistema/` tiene su propio tsconfig y sus tipos de
 * Workers: importarlo desde aquí rompe `npm run lint`.
 */

const RAIZ = resolve(import.meta.dirname, '..');
const leer = (r: string) => readFileSync(join(RAIZ, r), 'utf8');

/** La ruta, tal como la conoce Yappy. Si cambia, cambia en los tres. */
const RUTA = '/api/pago/yappy';

describe('la ruta del aviso de pago es la misma en los tres sitios', () => {
  it('la que se le da a Yappy en cada cobro', () => {
    const web = leer('sistema/src/rpc/web.ts');
    expect(web).toContain(`\${DOMINIO_DEL_AVISO}${RUTA}\``);
  });

  it('la que el Worker atiende', () => {
    const index = leer('worker/index.ts');
    expect(index).toContain(`url.pathname === "${RUTA}"`);
  });

  it('y la que no se redirige a canónico, para que www también conteste', () => {
    const visibilidad = leer('worker/visibilidad.ts');
    expect(visibilidad).toContain(`SIN_CANONICA = new Set(["${RUTA}"])`);
  });

  it('y no se confunde con la de ARRANCAR el pago, que es otra', () => {
    // `/api/pago/yappy/iniciar` la llama nuestra propia página; esta la llama
    // Yappy. Si la exención cubriera las dos, un POST por `www` dejaría de
    // redirigirse sin que nadie lo hubiera decidido.
    expect(leer('worker/index.ts')).toContain(`url.pathname === "${RUTA}/iniciar"`);
    expect(leer('worker/visibilidad.ts')).not.toContain(`"${RUTA}/iniciar"`);
  });
});

/**
 * Y las DOS cosas que se llaman «el dominio», que no son la misma.
 *
 * El **declarado** es el que la dueña puso en Yappy Comercial: se manda en
 * `urlDomain`, entra en la firma del aviso, y si no es exacto Yappy no valida
 * el comercio. Lleva `www`.
 *
 * La **dirección del aviso** se la damos nosotros en cada cobro y puede ser
 * cualquiera nuestra. Es el ápice, sin `www`, porque es la que se comprobó que
 * contesta 200 sin redirigir.
 *
 * Confundirlas fue justo el fallo que casi se despliega el 18-nov-2026: una
 * sola constante hacía de las dos cosas y valía `babycaleb.com`, que no es lo
 * declarado.
 */
describe('el dominio declarado y la dirección del aviso son dos cosas', () => {
  const avisos = leer('sistema/src/pagos/recibir-aviso.ts');
  const valor = (nombre: string): string => {
    const m = new RegExp(`${nombre} = "([^"]+)"`).exec(avisos);
    expect(m, `no se encontró ${nombre}`).not.toBeNull();
    return m?.[1] ?? '';
  };

  it('el declarado es la URL ENTERA que el dueño escribió en Yappy', () => {
    // Con `https://` y con la barra final. Lo que vale es lo que él escribió,
    // no lo que parezca más limpio: quitarle cualquiera de las dos cosas es
    // volver al «Illegal Arguments» del 18-nov-2026.
    expect(valor('DOMINIO_DECLARADO')).toBe('https://babycaleb.com/');
  });

  it('la dirección del aviso es un HOST pelado, sin esquema ni barra', () => {
    // Se le pega delante `https://` y detrás `/api/pago/yappy`. Si aquí
    // entrara una URL entera —como la de arriba— saldría
    // `https://https://babycaleb.com//api/pago/yappy`, y Yappy llamaría a una
    // dirección que no existe. Nadie se enteraría hasta el primer pago.
    const aviso = valor('DOMINIO_DEL_AVISO');
    expect(aviso).toBe('babycaleb.com');
    expect(aviso).not.toContain('://');
    expect(aviso).not.toContain('/');
  });

  it('y por eso los dos NO son el mismo valor', () => {
    expect(valor('DOMINIO_DECLARADO')).not.toBe(valor('DOMINIO_DEL_AVISO'));
  });

  it('y la lista de vuelta cubre las seis formas de escribir el sitio', () => {
    // Yappy no documenta si devuelve el dominio tal como se declaró o
    // normalizado. Averiguarlo a base de pagos perdidos sale caro, así que se
    // aceptan todas las maneras de escribir NUESTRO sitio — y solo las
    // nuestras: lo que autoriza de verdad sigue siendo la firma.
    const m = /NUESTROS_DOMINIOS = \[([\s\S]*?)\]/.exec(avisos);
    expect(m).not.toBeNull();
    const lista = m?.[1] ?? '';
    expect(lista).toContain('DOMINIO_DECLARADO');
    for (const forma of [
      '"https://babycaleb.com"',
      '"https://www.babycaleb.com"',
      '"https://www.babycaleb.com/"',
      '"babycaleb.com"',
      '"www.babycaleb.com"',
    ]) {
      expect(lista, `falta ${forma}`).toContain(forma);
    }
  });

  it('el declarado va PRIMERO: es el que se manda y el más probable', () => {
    const m = /NUESTROS_DOMINIOS = \[\s*([A-Z_]+)/.exec(avisos);
    expect(m?.[1]).toBe('DOMINIO_DECLARADO');
  });

  it('y el fallo de validación dice QUÉ dominio se mandó', () => {
    // «Illegal Arguments» a secas obligó a deducir cuál de los dos campos
    // estaba mal. Con el dominio delante, quien lo lee compara con su panel.
    const adaptador = leer('sistema/src/pagos/yappy.ts');
    expect(adaptador).toContain('Le mandamos el dominio «${cred.domain}»');
  });
});
