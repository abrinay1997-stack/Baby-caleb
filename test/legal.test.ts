import { describe, expect, it } from 'vitest';
import {
  DOCUMENTOS,
  PRIVACIDAD,
  TERMINOS,
  pendientesDe,
  type DocumentoLegal,
} from '../src/data/legal';
import { RUTAS } from '../src/seo/rutas';

/**
 * Las páginas legales, vigiladas desde el repositorio.
 *
 * No comprueban que el texto esté bien escrito —eso lo dirá un abogado— sino
 * las tres cosas que, si se rompen, nadie nota hasta que es tarde:
 *
 *  1. Que ningún hueco se quede sin dueño. Un `PENDIENTE` sin nombre de quién
 *     lo tiene que llenar no lo llena nadie: se queda ahí de adorno y el
 *     documento se publica cojo.
 *  2. Que no entre un precio. El precio vive en la D1 del sistema y nada más
 *     (`CLAUDE.md` del repositorio). Un monto escrito en una página legal es
 *     exactamente la clase de número que nadie se acuerda de actualizar, y
 *     encima es el que una clienta usaría para reclamar.
 *  3. Que no desaparezca la declaración de inteligencia artificial. Es una
 *     decisión expresa del dueño del proyecto —«estamos conscientes que su
 *     modelo se entrena con nuestra conversación»— y es la razón de ser de
 *     esta página. Si alguien «limpia» ese párrafo, esto se cae.
 */

const textoDe = (doc: DocumentoLegal): string =>
  doc.secciones
    .flatMap((s) => [
      s.titulo,
      ...s.bloques.flatMap((b) => {
        switch (b.tipo) {
          case 'p':
          case 'nota':
            return [b.texto];
          case 'lista':
            return b.puntos;
          case 'pendiente':
            return [b.que, b.quien];
        }
      }),
    ])
    .join('\n');

describe('ningún hueco se queda sin dueño', () => {
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta}: cada PENDIENTE dice qué falta y quién lo tiene que dar`, () => {
      const cojos = pendientesDe(doc)
        .filter((p) => p.que.trim().length < 20 || p.quien.trim().length < 5)
        .map((p) => p.que.slice(0, 60));
      expect(cojos, `pendientes sin explicar o sin dueño: ${cojos.join(' · ')}`).toEqual([]);
    });

    it(`${doc.ruta}: hay huecos declarados (si no, es que alguien los rellenó a ojo)`, () => {
      // Esta prueba se cae el día que un abogado y la dueña llenen TODO. Ese
      // día se borra a mano, junto con el aviso de borrador. Mientras haya
      // datos sin confirmar, un documento sin un solo PENDIENTE significa que
      // alguien escribió algo plausible en su lugar.
      expect(pendientesDe(doc).length).toBeGreaterThan(0);
    });
  }
});

describe('ningún precio en una página legal', () => {
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta}: ni un monto en dólares`, () => {
      const montos = textoDe(doc).match(/\$\s?\d/g) ?? [];
      expect(montos, `montos encontrados: ${montos.join(', ')}`).toEqual([]);
    });
  }
});

describe('la declaración de inteligencia artificial está y se entiende', () => {
  const ia = PRIVACIDAD.secciones.find((s) => s.id === 'inteligencia-artificial');

  it('la política de privacidad tiene su sección', () => {
    expect(ia, 'falta la sección `inteligencia-artificial` en la política de privacidad').toBeDefined();
  });

  it('dice que el modelo se entrena con las conversaciones', () => {
    const texto = textoDe(PRIVACIDAD).toLowerCase();
    expect(texto).toContain('entrenar el modelo');
    expect(texto).toContain('inteligencia artificial');
  });

  it('los términos también avisan de que el chat es un modelo, no una persona', () => {
    const texto = textoDe(TERMINOS).toLowerCase();
    expect(texto).toContain('inteligencia artificial');
    expect(texto).toContain('no una persona');
  });
});

describe('mientras no lo revise un abogado, el documento lo dice', () => {
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta}: lleva su aviso de borrador`, () => {
      if (doc.revisadoPorAbogado) return;
      // El aviso es lo único que separa un borrador técnico de un documento
      // que una clienta leerá como si fuera oficial.
      expect(doc.aviso.length).toBeGreaterThan(80);
      expect(doc.aviso.toLowerCase()).toContain('abogado');
      expect(doc.aviso.toUpperCase()).toContain('PENDIENTE');
    });
  }
});

describe('el índice de la página puede funcionar', () => {
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta}: los anclajes son únicos y válidos en una URL`, () => {
      const ids = doc.secciones.map((s) => s.id);
      expect(new Set(ids).size, `anclas repetidas en ${doc.ruta}`).toBe(ids.length);
      const raros = ids.filter((id) => !/^[a-z0-9-]+$/.test(id));
      expect(raros, `anclas con caracteres que una URL no respeta: ${raros.join(', ')}`).toEqual([]);
    });

    it(`${doc.ruta}: toda sección tiene título y contenido`, () => {
      const vacias = doc.secciones
        .filter((s) => s.titulo.trim() === '' || s.bloques.length === 0)
        .map((s) => s.id);
      expect(vacias, `secciones vacías: ${vacias.join(', ')}`).toEqual([]);
    });
  }
});

describe('las dos páginas declaran su <head>', () => {
  // Si una ruta legal no está en `seo/rutas.ts`, sale con el título de la
  // portada: el enlace que se pega en WhatsApp diría «Pañales y Wipes Nateen»
  // apuntando a la política de privacidad. Y además se queda fuera del
  // sitemap, que se arma con las claves de ese mismo objeto.
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta} tiene título y descripción propios`, () => {
      const meta = RUTAS[doc.ruta];
      expect(meta, `falta ${doc.ruta} en src/seo/rutas.ts`).toBeDefined();
      expect(meta?.title).toContain('Baby Caleb');
      expect((meta?.description ?? '').length).toBeGreaterThan(50);
    });
  }
});

describe('la fecha de actualización es una fecha', () => {
  for (const doc of DOCUMENTOS) {
    it(`${doc.ruta}: formato AAAA-MM-DD y no está en el futuro`, () => {
      expect(doc.actualizado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const d = new Date(`${doc.actualizado}T00:00:00Z`);
      expect(Number.isNaN(d.getTime())).toBe(false);
      // Un documento legal fechado en el futuro es un documento que todavía no
      // rige, y nadie lo escribe así a propósito.
      expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    });
  }
});
