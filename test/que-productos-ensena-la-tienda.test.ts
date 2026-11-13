import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { laTiendaLoEnsena } from '../src/hooks/useCatalogo';
import type { Catalogo, VariantePublica } from '../src/hooks/useCatalogo';

/**
 * Qué productos puede enseñar la tienda, y quién lo decide.
 *
 * Durante meses lo decidió `content.json`, un archivo escrito a mano, mientras
 * el precio y la existencia salían de la D1. Dos dueños para la misma
 * pregunta, que es justo lo que `CLAUDE.md` prohíbe de primera.
 *
 * Lo que costaba: retirar un producto desde el panel lo quitaba del sistema y
 * **la tienda lo seguía ofreciendo**, con un «Consultar» donde iba el precio.
 * Una clienta tocaba «Pedir» sobre algo que ya no existe, y el bot le decía lo
 * contrario que la web.
 *
 * Lo encontró el dueño preguntando, cuatro días seguidos, por qué un producto
 * que SÍ estaba publicado en el sistema no salía en la tienda. La respuesta era
 * al revés de lo que parecía: la tienda nunca había mirado el sistema para
 * armar su lista.
 */

const variante = (codigo: string): VariantePublica => ({
  codigo,
  slug: codigo.toLowerCase(),
  nombre: codigo,
  talla: null,
  pesoMinLb: null,
  pesoMaxLb: null,
  unidadesPorCaja: 1,
  precioCents: 1000,
  disponibilidad: 'disponible',
});

const catalogoCon = (...codigos: string[]): Catalogo =>
  new Map(codigos.map((c) => [c, variante(c)]));

const LISTO = { cargando: false };

describe('qué productos puede enseñar la tienda', () => {
  it('lo retirado en el panel desaparece de la tienda', () => {
    const producto = { variants: [{ codigo: 'NAT-M' }] };
    expect(laTiendaLoEnsena(producto, catalogoCon('NAT-L'), LISTO)).toBe(false);
  });

  it('lo que el sistema publica se enseña', () => {
    const producto = { variants: [{ codigo: 'NAT-M' }] };
    expect(laTiendaLoEnsena(producto, catalogoCon('NAT-M'), LISTO)).toBe(true);
  });

  it('basta con que quede UNA presentación viva', () => {
    // Una caja agotada y retirada no se lleva por delante a la familia entera.
    const producto = { variants: [{ codigo: 'NAT-M' }, { codigo: 'NAT-L' }] };
    expect(laTiendaLoEnsena(producto, catalogoCon('NAT-L'), LISTO)).toBe(true);
  });

  it('`descatalogado` sigue mandando aunque el sistema lo publique', () => {
    // Es la forma de sacar algo de la tienda sin tocar la base.
    const producto = { descatalogado: true, variants: [{ codigo: 'NAT-M' }] };
    expect(laTiendaLoEnsena(producto, catalogoCon('NAT-M'), LISTO)).toBe(false);
  });

  it('un producto sin código no lo maneja el sistema, y se enseña', () => {
    // El fular, las toallitas sueltas: no tienen fila en el catálogo, así que
    // no hay nada que comprobar. Esconderlos sería inventarse una regla.
    expect(laTiendaLoEnsena({ variants: [{}] }, catalogoCon('NAT-M'), LISTO)).toBe(true);
    expect(laTiendaLoEnsena({}, catalogoCon('NAT-M'), LISTO)).toBe(true);
  });

  describe('falla abierta: una tienda vacía es peor que una de más', () => {
    it('mientras el catálogo no ha llegado, se enseña todo', () => {
      const producto = { variants: [{ codigo: 'NO-ESTA' }] };
      expect(laTiendaLoEnsena(producto, catalogoCon(), { cargando: true })).toBe(true);
    });

    it('si el catálogo llegó VACÍO, también', () => {
      // El sistema no contestó y ni siquiera hubo copia del build. Esconderlo
      // todo dejaría la tienda en blanco, que es una tienda cerrada.
      const producto = { variants: [{ codigo: 'NO-ESTA' }] };
      expect(laTiendaLoEnsena(producto, catalogoCon(), LISTO)).toBe(true);
    });
  });

  it('con el catálogo de hoy, los productos de content.json siguen saliendo', () => {
    // La comprobación que importa: este cambio NO puede vaciar la tienda de
    // la dueña. Se arma el catálogo con los códigos que `content.json` declara
    // y se exige que los cinco productos sigan en pie.
    const raiz = join(import.meta.dirname, '..');
    const contenido = JSON.parse(readFileSync(join(raiz, 'content.json'), 'utf8')) as {
      products: { name: string; descatalogado?: boolean; variants?: { codigo?: string }[] }[];
    };
    const codigos = contenido.products
      .flatMap((p) => p.variants ?? [])
      .map((v) => v.codigo)
      .filter((c): c is string => typeof c === 'string');
    expect(codigos.length).toBeGreaterThan(5);

    const catalogo = catalogoCon(...codigos);
    const escondidos = contenido.products
      .filter((p) => p.descatalogado !== true)
      .filter((p) => !laTiendaLoEnsena(p, catalogo, LISTO))
      .map((p) => p.name);
    expect(escondidos, `estos productos desaparecerían de la tienda: ${escondidos.join(', ')}`).toEqual([]);
  });
});
