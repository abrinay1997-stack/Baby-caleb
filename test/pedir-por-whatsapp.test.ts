import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mensajeDePedido } from '../src/components/PedirPorWhatsapp';

/**
 * El mensaje de «Pedir por WhatsApp» lleva el código y el nombre. NUNCA el
 * precio.
 *
 * El razonamiento es del dueño y ya estaba escrito en `src/pages/Carrito.tsx`:
 * «un precio en ese mensaje es una promesa, y el precio lo pone el catálogo en
 * el momento de cerrar, no el navegador hace media hora». El carrito lo
 * respetaba desde el principio; la ficha de producto NO —su mensaje decía
 * «quiero pedir: Pañal Nateen Talla M ($50)»— y nadie lo vio, porque un precio
 * dentro de una plantilla de texto es sintácticamente perfecto.
 *
 * Por eso esto no comprueba solo la plantilla de hoy: también barre los
 * archivos que arman mensajes de WhatsApp, para que el precio no vuelva por
 * otro sitio.
 */

const UNA_VARIANTE = { codigo: 'NAT-M', nombre: 'Pañal Nateen Talla M de cierre' };

describe('el mensaje de un pedido por WhatsApp', () => {
  it('lleva el código y el nombre', () => {
    const m = mensajeDePedido(UNA_VARIANTE);
    // El código es lo que la dueña busca en el panel; el nombre es lo que la
    // clienta reconoce al releer su propio mensaje.
    expect(m).toContain('NAT-M');
    expect(m).toContain('Pañal Nateen Talla M de cierre');
  });

  it('NO lleva precio, ni en dólares ni en centavos', () => {
    for (const agotado of [false, true]) {
      const m = mensajeDePedido(UNA_VARIANTE, agotado);
      expect(m, `agotado=${agotado}`).not.toMatch(/\$\s?\d/);
      // Ni el número a secas: 5000 centavos escritos sin signo siguen siendo
      // una promesa de precio.
      expect(m, `agotado=${agotado}`).not.toMatch(/\b\d{3,}\b/);
    }
  });

  it('el de agotado pide aviso, no pedido', () => {
    // Si los dos dijeran lo mismo, una clienta pediría algo que no hay y lo
    // descubriría al final. El canal es el mismo; lo que se pide, no.
    expect(mensajeDePedido(UNA_VARIANTE, true)).toContain('avísenme');
    expect(mensajeDePedido(UNA_VARIANTE, false)).toContain('quiero pedir');
  });
});

/**
 * Y que no vuelva por otro sitio.
 *
 * `precioLegible` y `dolares` formatean el precio del catálogo, y los dos
 * tienen su sitio en una ficha de producto —el precio SE ENSEÑA, lo que no se
 * hace es prometerlo en un mensaje—. Lo que esto vigila es que ninguno de los
 * dos acabe dentro del texto de un enlace de WhatsApp.
 */
const RAIZ = new URL('..', import.meta.url).pathname;

function tsxDe(dir: string): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) salida.push(...tsxDe(rel));
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) salida.push(rel);
  }
  return salida;
}

describe('ningún precio dentro de un mensaje de WhatsApp', () => {
  it('ni en los bloques, ni en las páginas, ni en los componentes', () => {
    const sospechosos: string[] = [];
    const archivos = [
      ...tsxDe('src/blocks'),
      ...tsxDe('src/pages'),
      ...tsxDe('src/components'),
    ];

    for (const archivo of archivos) {
      const texto = readFileSync(join(RAIZ, archivo), 'utf8');
      // Una plantilla de mensaje es una cadena con `${...}` dentro que menciona
      // wa.me o un mensaje de pedido. Se busca el caso concreto: una llamada a
      // un formateador de precio dentro de la misma plantilla.
      for (const [i, linea] of texto.split('\n').entries()) {
        const limpia = linea.trim();
        if (limpia.startsWith('*') || limpia.startsWith('//')) continue;
        const esPlantillaDeMensaje = /mensaje|wa\.me|whatsappCon|\?text=/i.test(limpia);
        const llevaPrecio = /precioLegible|dolares\(|precioCents|precioDe\(|desdeDe\(/.test(limpia);
        if (esPlantillaDeMensaje && llevaPrecio) {
          sospechosos.push(`${archivo}:${i + 1}  ${limpia.slice(0, 90)}`);
        }
      }
    }

    expect(
      sospechosos,
      'Un precio dentro de un mensaje de WhatsApp es una promesa que el catálogo no hizo.\n' +
        'El mensaje lleva el código y el nombre; el precio lo pone el catálogo al cerrar.\n\n' +
        sospechosos.join('\n'),
    ).toEqual([]);
  });
});
