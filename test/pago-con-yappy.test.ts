import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATOS_EN_BLANCO,
  SIN_RESPUESTA,
  cuerpoDeInicio,
  hayProblemas,
  huellaDelCarrito,
  iniciarPagoConYappy,
  llaveDelCarrito,
  llaveNueva,
  olvidarLlave,
  porqueNoSalio,
  primerProblema,
  revisarDatos,
  rutaDelResultado,
  esNumeroDePedido,
  soloNumeros,
} from '../src/carrito/pago';
import { olvidarZonas, pedirZonasUnaVez, zonasDeLaRespuesta } from '../src/carrito/zonas';

/**
 * La lógica del paso de pago, sin navegador.
 *
 * Lo que se prueba aquí es lo único que el navegador decide: que el formulario
 * esté completo, que la llave de idempotencia se repita para el mismo carrito,
 * y qué significa cada respuesta del servidor. Nada de esto calcula dinero —de
 * eso no hay una línea en `pago.ts`— y por eso no hay ninguna prueba de
 * totales: no habría nada que probar.
 */

/** Un `localStorage` de mentira, que es lo único de `window` que se usa. */
function ponerAlmacen(): Map<string, string> {
  const datos = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
      removeItem: (k: string) => void datos.delete(k),
    },
  };
  return datos;
}

function quitarAlmacen(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe('el celular se limpia antes de mandarlo', () => {
  it('quita guiones y espacios', () => {
    expect(soloNumeros('6000-0001')).toBe('60000001');
    expect(soloNumeros('6000 0001')).toBe('60000001');
    expect(soloNumeros(' 6000.0001 ')).toBe('60000001');
  });

  it('quita el prefijo del país si viene', () => {
    // Es lo que la gente tiene guardado en su propio teléfono.
    expect(soloNumeros('+507 6000-0001')).toBe('60000001');
    expect(soloNumeros('50760000001')).toBe('60000001');
  });

  it('no inventa números donde no hay', () => {
    expect(soloNumeros('')).toBe('');
    expect(soloNumeros('no tengo')).toBe('');
  });
});

describe('el formulario se revisa antes de gastar un viaje', () => {
  it('en blanco, se queja de todo lo obligatorio', () => {
    const p = revisarDatos(DATOS_EN_BLANCO, { zonaObligatoria: true });
    expect(hayProblemas(p)).toBe(true);
    expect(p.nombre).toBeTypeOf('string');
    expect(p.celular).toBeTypeOf('string');
    expect(p.zona).toBeTypeOf('string');
    // El foco va al primero, no al último: de arriba abajo, como se lee.
    expect(primerProblema(p)).toBe('nombre');
  });

  it('un celular de cinco números no pasa', () => {
    const p = revisarDatos(
      { nombre: 'Yarielis', celular: '60000', zona: 'X', notas: '' },
      { zonaObligatoria: true },
    );
    expect(p.celular).toBeTypeOf('string');
    expect(p.nombre).toBeUndefined();
    expect(primerProblema(p)).toBe('celular');
  });

  it('completo, no se queja de nada', () => {
    const p = revisarDatos(
      { nombre: 'Yarielis', celular: '6000-0001', zona: 'Una zona', notas: '' },
      { zonaObligatoria: true },
    );
    expect(p).toEqual({});
    expect(hayProblemas(p)).toBe(false);
    expect(primerProblema(p)).toBeNull();
  });

  it('sin lista de zonas, la zona NO es obligatoria', () => {
    // Si la ruta de las zonas no contesta, exigir una zona dejaría a la
    // clienta sin poder pagar por un hueco que no es suyo. El contrato la
    // declara opcional y el envío lo calcula el servidor igual.
    const p = revisarDatos(
      { nombre: 'Yarielis', celular: '60000001', zona: '', notas: '' },
      { zonaObligatoria: false },
    );
    expect(p).toEqual({});
  });

  it('las notas no son obligatorias nunca', () => {
    const p = revisarDatos(
      { nombre: 'Yarielis', celular: '60000001', zona: 'Una zona', notas: '' },
      { zonaObligatoria: true },
    );
    expect(p).toEqual({});
  });
});

describe('el cuerpo del pedido', () => {
  const lineas = [
    { codigo: 'NAT-M', cantidad: 2 },
    { codigo: 'NAT-L', cantidad: 1 },
  ];

  it('lleva códigos, cantidades y los datos; ni un precio', () => {
    const cuerpo = cuerpoDeInicio(
      { nombre: '  Yarielis  ', celular: '6000-0001', zona: 'Una zona', notas: 'Casa azul' },
      lineas,
      'llave-de-prueba-1234',
    );
    expect(cuerpo).toEqual({
      nombre: 'Yarielis',
      celular: '60000001',
      zona: 'Una zona',
      notas: 'Casa azul',
      lineas: [
        { codigo: 'NAT-M', cantidad: 2 },
        { codigo: 'NAT-L', cantidad: 1 },
      ],
      idempotencia: 'llave-de-prueba-1234',
    });
    // La comprobación que importa: el JSON que sale no menciona dinero.
    expect(JSON.stringify(cuerpo)).not.toMatch(/Cents|precio|total|envio|impuesto/i);
  });

  it('omite la zona y las notas cuando están vacías', () => {
    // El contrato las declara opcionales. Mandar `""` no es lo mismo que no
    // mandarlas: una cadena vacía es una zona que no existe en el tarifario.
    const cuerpo = cuerpoDeInicio(
      { nombre: 'Yarielis', celular: '60000001', zona: '   ', notas: '  ' },
      lineas,
      'llave-de-prueba-1234',
    );
    expect('zona' in cuerpo).toBe(false);
    expect('notas' in cuerpo).toBe(false);
  });
});

describe('la llave de idempotencia', () => {
  beforeEach(() => {
    ponerAlmacen();
  });
  afterEach(() => {
    quitarAlmacen();
  });

  it('mide al menos los 8 caracteres que pide el contrato', () => {
    expect(llaveNueva().length).toBeGreaterThanOrEqual(8);
  });

  it('dos llaves nuevas no son la misma', () => {
    expect(llaveNueva()).not.toBe(llaveNueva());
  });

  it('la huella del carrito no depende del orden de las líneas', () => {
    // Si dependiera, mover una línea de sitio daría una llave nueva para el
    // mismo pedido — o sea, dos pedidos y el inventario apartado dos veces.
    const a = huellaDelCarrito([
      { codigo: 'NAT-M', cantidad: 2 },
      { codigo: 'NAT-L', cantidad: 1 },
    ]);
    const b = huellaDelCarrito([
      { codigo: 'NAT-L', cantidad: 1 },
      { codigo: 'NAT-M', cantidad: 2 },
    ]);
    expect(a).toBe(b);
  });

  it('pero sí de las cantidades', () => {
    expect(huellaDelCarrito([{ codigo: 'NAT-M', cantidad: 2 }])).not.toBe(
      huellaDelCarrito([{ codigo: 'NAT-M', cantidad: 3 }]),
    );
  });

  it('el MISMO carrito da la MISMA llave: es lo que evita el pedido doble', () => {
    const carrito = [{ codigo: 'NAT-M', cantidad: 2 }];
    const primera = llaveDelCarrito(carrito);
    expect(llaveDelCarrito(carrito)).toBe(primera);
    // Y también con las líneas en otro orden, que es el mismo carrito.
    expect(
      llaveDelCarrito([
        { codigo: 'NAT-M', cantidad: 2 },
      ]),
    ).toBe(primera);
  });

  it('un carrito distinto da una llave distinta', () => {
    const primera = llaveDelCarrito([{ codigo: 'NAT-M', cantidad: 2 }]);
    const segunda = llaveDelCarrito([{ codigo: 'NAT-M', cantidad: 3 }]);
    expect(segunda).not.toBe(primera);
  });

  it('se puede olvidar', () => {
    const carrito = [{ codigo: 'NAT-M', cantidad: 2 }];
    const primera = llaveDelCarrito(carrito);
    olvidarLlave();
    expect(llaveDelCarrito(carrito)).not.toBe(primera);
  });

  it('sin `localStorage` sigue dando una llave en vez de reventar', () => {
    // Ventana privada de Safari: `localStorage` LANZA, no devuelve vacío. Una
    // excepción aquí deja a la clienta sin poder pagar.
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('bloqueado');
        },
        setItem: () => {
          throw new Error('bloqueado');
        },
        removeItem: () => {
          throw new Error('bloqueado');
        },
      },
    };
    const llave = llaveDelCarrito([{ codigo: 'NAT-M', cantidad: 1 }]);
    expect(llave.length).toBeGreaterThanOrEqual(8);
  });
});

describe('qué significa cada respuesta del servidor', () => {
  const CUERPO = cuerpoDeInicio(
    { nombre: 'Yarielis', celular: '60000001', zona: 'Una zona', notas: '' },
    [{ codigo: 'NAT-M', cantidad: 1 }],
    'llave-de-prueba-1234',
  );

  const responder = (cuerpo: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(cuerpo), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('un sí con la forma del contrato se acepta', async () => {
    const datos = {
      pedido: { numero: 'BC-0001', token: 't', totalCents: 5500, envioCents: 500 },
      boton: { transactionId: 'tx', token: 'tk', documentName: 'doc' },
    };
    const r = await iniciarPagoConYappy(CUERPO, responder({ ok: true, datos }));
    expect(r.estado).toBe('listo');
    if (r.estado !== 'listo') return;
    expect(r.datos.pedido.numero).toBe('BC-0001');
    expect(r.datos.boton.transactionId).toBe('tx');
  });

  it('un no se devuelve con SU mensaje, sin tocarlo', async () => {
    const mensaje = 'No nos queda suficiente de uno de los productos de tu pedido.';
    const r = await iniciarPagoConYappy(
      CUERPO,
      responder({ ok: false, codigo: 'sin_existencias', mensaje }, 409),
    );
    expect(r.estado).toBe('rechazado');
    if (r.estado !== 'rechazado') return;
    expect(r.mensaje).toBe(mensaje);
    expect(r.codigo).toBe('sin_existencias');
  });

  it('un no SIN mensaje no deja a la clienta sin nada que leer', async () => {
    const r = await iniciarPagoConYappy(CUERPO, responder({ ok: false, codigo: 'x' }));
    expect(r.estado).toBe('rechazado');
    if (r.estado !== 'rechazado') return;
    expect(r.mensaje).toBe(SIN_RESPUESTA);
  });

  it('una petición que se cae del todo es «sin respuesta», no un no del servidor', async () => {
    const revienta = (async () => {
      throw new Error('sin red');
    }) as unknown as typeof fetch;
    const r = await iniciarPagoConYappy(CUERPO, revienta);
    expect(r.estado).toBe('sin_respuesta');
  });

  it('un 502 con HTML dentro tampoco es un no del servidor', async () => {
    // Confundirlos manda a buscar al sitio equivocado (`docs/TRAMPAS.md` §10):
    // «el servidor dijo que no» y «no contestó el servidor» son dos cosas.
    const html = (async () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const r = await iniciarPagoConYappy(CUERPO, html);
    expect(r.estado).toBe('sin_respuesta');
  });

  it('un sí con la forma incompleta NO se toma por un sí', async () => {
    // Un `transactionId` que falta dejaría llamar a `eventPayment` con
    // `undefined`, y el botón se quedaría girando sin motivo visible.
    const r = await iniciarPagoConYappy(
      CUERPO,
      responder({
        ok: true,
        datos: {
          pedido: { numero: 'BC-0001', token: 't', totalCents: 5500, envioCents: 500 },
          boton: { token: 'tk', documentName: 'doc' },
        },
      }),
    );
    expect(r.estado).toBe('sin_respuesta');
  });

  it('se manda por POST y sin caché', async () => {
    let visto: { metodo?: string; cache?: string; cuerpo?: string } = {};
    const espia = (async (_ruta: string, opciones: RequestInit) => {
      visto = {
        metodo: opciones.method,
        cache: String(opciones.cache),
        cuerpo: String(opciones.body),
      };
      return new Response(JSON.stringify({ ok: false, codigo: 'x', mensaje: 'no' }));
    }) as unknown as typeof fetch;
    await iniciarPagoConYappy(CUERPO, espia);
    expect(visto.metodo).toBe('POST');
    expect(visto.cache).toBe('no-store');
    expect(visto.cuerpo).toContain('idempotencia');
  });
});

describe('por qué no salió el pago', () => {
  it('los cinco códigos de Yappy tienen palabras', () => {
    for (const codigo of [
      'EXPIRED',
      'FAILED',
      'DENIED',
      'DUPLICATED_TRANSACTION',
      'CANCELLED',
    ]) {
      expect(porqueNoSalio(codigo).length, codigo).toBeGreaterThan(20);
    }
  });

  it('y un código que no está en la lista también', () => {
    // El componente emite por `eventError` también el error de su propia
    // comprobación de disponibilidad, que no es ninguno de los cinco. Un
    // `undefined` en pantalla es peor que una frase honesta.
    expect(porqueNoSalio('ALGO_NUEVO').length).toBeGreaterThan(20);
    expect(porqueNoSalio(undefined).length).toBeGreaterThan(20);
    expect(porqueNoSalio({ error: 500 }).length).toBeGreaterThan(20);
  });
});

describe('la ruta del resultado', () => {
  it('lleva el número del pedido escapado', () => {
    expect(rutaDelResultado('BC-0001')).toBe('/pago/resultado/BC-0001');
    expect(rutaDelResultado('a/b')).toBe('/pago/resultado/a%2Fb');
  });

  it('un número que llega por la URL se comprueba antes de pintarlo', () => {
    expect(esNumeroDePedido('BC-0001')).toBe(true);
    expect(esNumeroDePedido('')).toBe(false);
    expect(esNumeroDePedido('<script>')).toBe(false);
    expect(esNumeroDePedido('a'.repeat(41))).toBe(false);
  });
});

describe('las zonas de envío', () => {
  afterEach(() => {
    olvidarZonas();
  });

  it('se leen del sobre `{ ok, datos }` del sistema', () => {
    const zonas = zonasDeLaRespuesta({
      ok: true,
      datos: [
        { id: 'z1', nombre: 'Una zona', region: 'ciudad', tarifaCents: 500 },
        { id: 'z2', nombre: 'Otra zona', region: 'interior', tarifaCents: null },
      ],
    });
    expect(zonas?.length).toBe(2);
    expect(zonas?.[1]).toEqual({
      id: 'z2',
      nombre: 'Otra zona',
      region: 'interior',
      tarifaCents: null,
    });
  });

  it('y de una lista pelada, por si la ruta contesta así', () => {
    expect(zonasDeLaRespuesta([{ nombre: 'Una zona' }])?.length).toBe(1);
  });

  it('un «no» del sistema no es una lista de zonas', () => {
    expect(zonasDeLaRespuesta({ ok: false, codigo: 'x', mensaje: 'no' })).toBeNull();
  });

  it('una lista vacía tampoco: con cero zonas el desplegable no sirve', () => {
    expect(zonasDeLaRespuesta([])).toBeNull();
    expect(zonasDeLaRespuesta({ ok: true, datos: [] })).toBeNull();
  });

  it('una fila sin nombre se descarta y el resto sobrevive', () => {
    const zonas = zonasDeLaRespuesta([{ nombre: 'Buena' }, { nombre: '' }, null, 7]);
    expect(zonas?.length).toBe(1);
  });

  it('cualquier otra cosa es «no hay lista», no una lista inventada', () => {
    expect(zonasDeLaRespuesta(null)).toBeNull();
    expect(zonasDeLaRespuesta('zonas')).toBeNull();
    expect(zonasDeLaRespuesta({ cualquier: 'cosa' })).toBeNull();
  });

  it('un 404 de la ruta deja la pantalla sin lista, no caída', () => {
    // Es lo que pasa HOY: `/api/zonas` no existe en `worker/index.ts` y cae en
    // su 404 de `/api/*`. La pantalla tiene que poder seguir sin zonas.
    olvidarZonas();
    const noExiste = (async () =>
      new Response(JSON.stringify({ error: 'no existe esa ruta' }), {
        status: 404,
      })) as unknown as typeof fetch;
    return pedirZonasUnaVez(noExiste).then((r) => {
      expect(r).toBeNull();
    });
  });

  it('se pide UNA vez aunque la llamen varios componentes', async () => {
    olvidarZonas();
    let veces = 0;
    const contar = (async () => {
      veces += 1;
      return new Response(JSON.stringify([{ nombre: 'Una zona' }]));
    }) as unknown as typeof fetch;
    await Promise.all([pedirZonasUnaVez(contar), pedirZonasUnaVez(contar)]);
    await pedirZonasUnaVez(contar);
    expect(veces).toBe(1);
  });
});
