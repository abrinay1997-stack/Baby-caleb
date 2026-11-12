import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cuando la tienda enseña la copia del build, tiene que SABERLO.
 *
 * El Worker manda `desdeRespaldo` en cada respuesta «para que la pantalla
 * pueda avisar», y la pantalla no avisaba: nadie leía ese campo en todo el
 * repositorio. El detalle que lo hacía invisible es que la petición contesta
 * **200** en los dos casos —el Worker sirve la copia y devuelve una página
 * sana— así que el `catch` del hook no salta y el navegador toma la copia por
 * el catálogo de verdad, con toda confianza.
 *
 * Lo que se enseñaba ese día: los doce artículos en «agotado», los precios de
 * la fecha del despliegue y, porque el respaldo no trae el celular a
 * propósito, **sin botón de pedir por WhatsApp**. Una tienda muerta con cara
 * de tienda sana.
 *
 * El módulo guarda estado entre llamadas (la petición en vuelo se comparte
 * para no pedir el catálogo una vez por componente), así que cada caso lo
 * importa de nuevo con `resetModules`. Sin eso, el primero decidiría el
 * resultado de los demás.
 */
describe('la tienda sabe si está enseñando la copia del build', () => {
  const original = globalThis.fetch;

  const conRespuesta = (cuerpo: unknown, ok = true) => {
    globalThis.fetch = vi.fn(async () =>
      ({ ok, status: ok ? 200 : 500, json: async () => cuerpo }) as unknown as Response,
    ) as unknown as typeof fetch;
  };

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = original;
    vi.restoreAllMocks();
  });

  it('con el catálogo de verdad NO avisa de nada', async () => {
    conRespuesta({ variantes: [], whatsapp: { numero: '50760000000' }, desdeRespaldo: false });
    const m = await import('../src/hooks/useCatalogo');
    await m.pedirUnaVez();
    expect(m.catalogoEsCopiaVieja()).toBe(false);
  });

  it('con la copia del build, avisa — aunque la respuesta sea 200', async () => {
    // Este es el caso que nadie veía. El 200 es lo que lo escondía.
    conRespuesta({ variantes: [], desdeRespaldo: true });
    const m = await import('../src/hooks/useCatalogo');
    await m.pedirUnaVez();
    expect(m.catalogoEsCopiaVieja()).toBe(true);
  });

  it('y si la petición se cae del todo, también', async () => {
    // Aquí no hace falta mirar el campo: lo que queda es la copia y punto.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('sin red');
    }) as unknown as typeof fetch;
    const m = await import('../src/hooks/useCatalogo');
    await m.pedirUnaVez();
    expect(m.catalogoEsCopiaVieja()).toBe(true);
  });

  it('un campo que falta NO se interpreta como copia vieja', async () => {
    // Un Worker viejo que todavía no mande el campo no debe hacer que la
    // tienda se acuse a sí misma de estar desactualizada. Ante la duda, no se
    // asusta a nadie: el aviso tiene que significar algo cuando sale.
    conRespuesta({ variantes: [] });
    const m = await import('../src/hooks/useCatalogo');
    await m.pedirUnaVez();
    expect(m.catalogoEsCopiaVieja()).toBe(false);
  });
});
