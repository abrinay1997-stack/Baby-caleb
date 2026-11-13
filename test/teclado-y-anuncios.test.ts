import { describe, expect, it } from 'vitest';
import { soloCodigo } from './sin-comentarios';

/**
 * Las dos capas que se abren encima de la tienda: el menú del teléfono y el
 * chat. Lo que vigila esta prueba es lo que se midió roto el 2026-11-13 con un
 * navegador y el teclado, a 390 px — y lo que se midió arreglado después.
 *
 * ## Por qué se mira el código y no el navegador
 *
 * El comportamiento se comprueba de verdad en `npm run auditar:web`, que abre
 * las páginas. Esto es la otra mitad: que las piezas que lo hacen posible
 * sigan ahí. Un `useEffect` borrado en una refactorización no rompe ninguna
 * pantalla, no cambia ninguna captura y deja fuera de la tienda a quien
 * navega con teclado — que es justo la clase de fallo que no sale en ningún
 * informe (`docs/TRAMPAS.md` §12).
 *
 * ## Romper a propósito
 *
 * Quite `cerrarRef.current?.focus()` de `S01Nav.tsx`, o el `role="log"` del
 * `Chatbot.tsx`. Cada uno pone roja su propia casilla — y los dos lo hicieron
 * al validar esto.
 */

describe('el menú del teléfono se puede usar con teclado', () => {
  const nav = soloCodigo('src/blocks/S01Nav.tsx');

  it('el foco entra al abrirlo', () => {
    // Se quedaba en «Abrir menú», que queda DEBAJO de la capa recién abierta:
    // WCAG 2.4.11 (*Focus Not Obscured*), que es AA y entró con la 2.2.
    expect(nav).toMatch(/cerrarRef\.current\?\.focus\(\)/);
  });

  it('Escape lo cierra', () => {
    expect(nav).toMatch(/['"]Escape['"]/);
    expect(nav).toMatch(/setMobileMenuOpen\(false\)/);
  });

  it('el foco no se escapa a la página de detrás', () => {
    // Con `aria-modal="true"` el lector de pantalla dice que el resto de la
    // página no existe. Tabulando se llegaba igual, a enlaces que no se ven.
    expect(nav, 'falta la vuelta del foco (Tab y Shift+Tab) dentro del menú').toMatch(/shiftKey/);
    expect(nav).toMatch(/menuRef/);
  });

  it('y vuelve al botón que lo abrió', () => {
    expect(nav).toMatch(/botonMenuRef\.current\?\.focus\(\)/);
  });
});

describe('el chat se puede usar con teclado y se oye', () => {
  const chat = soloCodigo('src/components/Chatbot.tsx');

  it('una respuesta nueva se anuncia', () => {
    // NO HABÍA NI UNA REGIÓN `aria-live` EN TODA LA PÁGINA. Para quien no ve
    // la pantalla, preguntar y que contesten sonaba igual que preguntar y que
    // no conteste nadie. WCAG 4.1.3 (*Status Messages*), AA.
    expect(chat, 'falta el role="log" de la conversación').toMatch(/role="log"/);
    expect(chat, 'falta aria-live en la conversación').toMatch(/aria-live="polite"/);
  });

  it('se sabe quién habla en cada burbuja', () => {
    // En la pantalla lo dicen el lado y el color, que es exactamente lo que un
    // lector de pantalla no transmite.
    expect(chat).toMatch(/Asistente:/);
  });

  it('el foco entra al abrirlo y vuelve al globo al cerrarlo', () => {
    expect(chat).toMatch(/campoRef\.current\?\.focus\(\)/);
    expect(chat).toMatch(/globoRef\.current\?\.focus\(\)/);
  });

  it('Escape lo cierra', () => {
    expect(chat).toMatch(/['"]Escape['"]/);
  });

  it('el campo de escribir no hace que iOS dé el zoom', () => {
    // Con menos de 16 px, iOS amplía al enfocar y la pantalla se descoloca
    // sola justo cuando alguien empieza a escribir. Tenía 12 (`text-xs`).
    // §7b de `docs/design-system.md`.
    const campo = /<input[\s\S]*?\/>/.exec(chat)?.[0] ?? '';
    expect(campo, 'no se encontró el <input> del chat').not.toBe('');
    expect(
      /text-(xs|sm)\b/.test(campo),
      'El campo del chat volvió a un tamaño por debajo de 16 px: iOS hará zoom al enfocar.',
    ).toBe(false);
    expect(campo, 'el campo necesita text-base (16 px)').toMatch(/text-base/);
  });

  it('y tiene etiqueta, que un placeholder no lo es', () => {
    // El `placeholder` desaparece en cuanto se escribe la primera letra.
    expect(chat).toMatch(/htmlFor="chat-mensaje"/);
    expect(chat).toMatch(/id="chat-mensaje"/);
  });

  it('el número de WhatsApp sale de su único dueño', () => {
    // Estaba escrito a mano aquí —el séptimo sitio, justo el que
    // `data/contacto.ts` existe para evitar.
    expect(chat).toContain('WHATSAPP_URL');
    expect(
      /wa\.me\/\d/.test(chat),
      'Volvió a haber un celular escrito a mano en el chat. Use WHATSAPP_URL.',
    ).toBe(false);
  });
});

describe('el aviso de permisos no se come los toques de la página', () => {
  const banner = soloCodigo('src/components/BannerConsentimiento.tsx');

  it('solo la tarjeta recibe toques, no la franja entera', () => {
    // El envoltorio es `fixed inset-x-0 bottom-0` con relleno transparente, y
    // mientras estuvo abierto se tragaba TODOS los toques de esa franja. En el
    // teléfono el globo del chat era imposible de pulsar aunque se viera
    // entero: lo comprobó un navegador, que no pudo hacer clic.
    expect(banner, 'falta pointer-events-none en el envoltorio').toMatch(/pointer-events-none/);
    expect(banner, 'falta pointer-events-auto en la tarjeta').toMatch(/pointer-events-auto/);
  });
});
