import { describe, expect, it } from 'vitest';
import { soloCodigo, leerCrudo } from './sin-comentarios';
import {
  ESTAMOS_CONFIRMANDO,
  NO_SALIO_SIN_CODIGO,
  PORQUE_NO_SALIO,
  RUTA_DE_INICIO,
} from '../src/carrito/pago';
import {
  ELEMENTO_DE_YAPPY,
  SCRIPT_DE_YAPPY,
  TEMA_DE_YAPPY,
} from '../src/carrito/BotonDeYappy';

/**
 * Las cuatro reglas del paso de pago que una máquina puede comprobar.
 *
 * Están aquí porque las cuatro son de las que no dan ningún síntoma cuando se
 * rompen: el typecheck pasa, la pantalla se pinta, las capturas se ven bien, y
 * el fallo aparece semanas después en forma de mercancía entregada sin cobrar
 * o de un botón que nunca cargó.
 *
 * ## Romper a propósito (`docs/TRAMPAS.md` §6)
 *
 * Cada casilla se validó rompiendo lo que vigila, y cada una se puso roja:
 *
 *  · cambiar `bt-cdn.yappy.cloud` por el `bt-cdn.yappycloud.com` del ejemplo
 *    de Yappy → roja;
 *  · poner «¡Pagado!» en `ESTAMOS_CONFIRMANDO` → roja;
 *  · añadir `totalCents` al cuerpo de `cuerpoDeInicio` → roja;
 *  · quitar el `boton.isButtonLoading = false` del camino de fallo → roja.
 */

const PAGO = 'src/carrito/pago.ts';
const BOTON = 'src/carrito/BotonDeYappy.tsx';
const PANTALLA = 'src/carrito/PantallaDePago.tsx';
const RESULTADO = 'src/carrito/ResultadoDelPago.tsx';

describe('se leen de verdad los archivos que se vigilan', () => {
  // Sin esto, una ruta mal escrita leería vacío y TODAS las casillas de abajo
  // aprobarían sin comprobar nada: la trampa §1 del repositorio.
  it('los cuatro archivos del paso de pago existen y tienen contenido', () => {
    for (const archivo of [PAGO, BOTON, PANTALLA, RESULTADO]) {
      expect(leerCrudo(archivo).length, archivo).toBeGreaterThan(1000);
    }
    expect(soloCodigo(PANTALLA)).toContain('export default function PantallaDePago');
    expect(soloCodigo(RESULTADO)).toContain('export default function ResultadoDelPago');
  });

  /**
   * Y que `soloCodigo` no se haya llevado medio archivo por delante.
   *
   * No es paranoia: pasó al escribir estas pruebas. `soloCodigo` no es un
   * analizador de JavaScript —lo dice en su cabecera— y su regla de los
   * comentarios de JSX (`{` … `/*` … `*\/` … `}`) se tragó 14 de los 16 KB de
   * `BotonDeYappy.tsx`, porque el archivo tenía una `interface` que abría con
   * `{` y seguía con un docstring.
   *
   * La vez que pasó se vio porque las casillas se pusieron ROJAS sobre cosas
   * que sí estaban, y eso se arregla. Lo peligroso es al revés: una casilla
   * que busca una frase prohibida aprobaría porque la frase se la llevó el
   * recortador, no porque no esté. Así que se comprueba que el trozo FINAL de
   * cada archivo siga ahí.
   */
  it('y el recortador de comentarios no se come el final de ninguno', () => {
    for (const [archivo, final] of [
      [PAGO, 'esNumeroDePedido'],
      [BOTON, 'Volver a intentarlo'],
      [PANTALLA, 'Volver al carrito'],
      [RESULTADO, 'Si quieres agregar algo más'],
    ] as const) {
      expect(soloCodigo(archivo), `soloCodigo recortó de más en ${archivo}`).toContain(final);
    }
  });
});

describe('el host del script de Yappy es el que responde', () => {
  /**
   * La documentación de Yappy da DOS hosts en la misma página y el de su
   * ejemplo —`bt-cdn.yappycloud.com`— no responde. Con ése, `<btn-yappy>` se
   * queda sin definir, el navegador lo pinta como nada y no entra un pago.
   *
   * Es la trampa §2: no adivine la cadena de un tercero. Aquí no se adivina,
   * se fija.
   */
  it('es bt-cdn.yappy.cloud', () => {
    expect(SCRIPT_DE_YAPPY).toBe(
      'https://bt-cdn.yappy.cloud/v1/cdn/web-component-btn-yappy.js',
    );
  });

  it('y NO es el del ejemplo de la documentación, que no contesta', () => {
    expect(SCRIPT_DE_YAPPY).not.toContain('yappycloud.com');
    expect(soloCodigo(BOTON), 'el código nombra el host que no responde').not.toContain(
      'yappycloud.com',
    );
  });

  it('el script se carga SOLO en esta pantalla, no en el index.html', () => {
    // 545 KB de un tercero, más sus fuentes de Google, en las siete páginas
    // públicas, para una pantalla que ve una fracción de quien entra.
    expect(leerCrudo('index.html')).not.toContain('yappy');
    expect(soloCodigo(BOTON)).toContain("createElement('script')");
  });

  it('el elemento se crea con el nombre que define ese script', () => {
    expect(ELEMENTO_DE_YAPPY).toBe('btn-yappy');
  });
});

describe('el tema del botón de Yappy cumple el contraste', () => {
  /**
   * El texto del botón es de 16 px en negrita, que para la WCAG es texto
   * normal —grande empieza en 18.66 px en negrita—, así que pide 4.5:1.
   * Medidos los seis temas contra el CSS del propio componente, solo `dark`
   * pasa con margen: `blue` 2.40, `orange` 2.17, `sky` 4.29, y `light` y
   * `darkBlue` 4.5003, que es pasar por tres diezmilésimas.
   *
   * `npm run auditar:web` lo mide en el navegador y se pondría rojo. Esto lo
   * dice antes, con el motivo al lado, para que nadie «arregle» el tema
   * poniendo el azul de la marca de Yappy y descubra el fallo en CI.
   */
  it('es `dark`, el único que pasa 4.5:1 con margen', () => {
    expect(TEMA_DE_YAPPY).toBe('dark');
  });

  it('y ninguno de los que suspenden está escrito en el componente', () => {
    const codigo = soloCodigo(BOTON);
    for (const tema of ["theme', 'blue'", "theme', 'orange'", "theme', 'sky'"]) {
      expect(codigo).not.toContain(tema);
    }
  });
});

describe('el navegador no decide un pago', () => {
  /**
   * `eventSuccess` NO significa pagado. El componente lo emite para tres
   * estados internos (`COMPLETED`, `C`, `EXECUTED`) y hay estados —`REJECTED`
   * entre ellos— que no disparan ni éxito ni error.
   *
   * Quien marca un pedido como pagado es el aviso firmado que llega al
   * servidor por detrás. Si esta pantalla afirma el cobro, un día alguien
   * recibe mercancía sin haber pagado.
   */
  const PROHIBIDAS = [
    'pagado',
    'pago confirmado',
    'pedido confirmado',
    'gracias por tu compra',
    'tu pago se realizó',
    'listo, pagaste',
  ];

  it('el texto que se enseña después de eventSuccess no afirma el cobro', () => {
    const texto = ESTAMOS_CONFIRMANDO.toLowerCase();
    for (const frase of PROHIBIDAS) {
      expect(texto, `«${ESTAMOS_CONFIRMANDO}» afirma un cobro que el navegador no sabe`).not.toContain(
        frase,
      );
    }
    expect(texto).toContain('confirmando');
  });

  it('ni lo afirma la página de resultado', () => {
    // Se lee SIN comentarios: la cabecera de ese archivo explica por qué no
    // dice «¡Pagado!», o sea que lleva la palabra dentro. Mirar el archivo
    // crudo aprobaría con la pantalla rota (`docs/TRAMPAS.md` §6).
    const visible = soloCodigo(RESULTADO).toLowerCase();
    for (const frase of PROHIBIDAS) {
      expect(visible, `la página de resultado dice «${frase}»`).not.toContain(frase);
    }
  });

  it('tampoco lo afirma la pantalla de pago', () => {
    const visible = soloCodigo(PANTALLA).toLowerCase();
    for (const frase of PROHIBIDAS) {
      expect(visible, `la pantalla de pago dice «${frase}»`).not.toContain(frase);
    }
  });

  it('y ningún mensaje de «no salió» promete que el pedido se perdió', () => {
    // El pedido existe en el servidor aunque el cobro no salga: la dueña lo
    // ve. Decirle a la clienta que se perdió la haría pedirlo otra vez.
    for (const texto of [...Object.values(PORQUE_NO_SALIO), NO_SALIO_SIN_CODIGO]) {
      expect(texto.toLowerCase()).not.toContain('se perdió');
      expect(texto.toLowerCase()).not.toContain('se canceló tu pedido');
    }
  });
});

describe('el cuerpo que se manda no lleva ni un precio', () => {
  /**
   * El contrato lo dice y el servidor los ignora, pero el motivo de no
   * mandarlos es más duro: un total mandado desde aquí es un total editable
   * —el carrito vive en `localStorage`—, y mandar algo que el servidor tira
   * invita al siguiente a creer que sirve.
   */
  const CAMPOS_DE_DINERO = [
    'totalCents:',
    'subtotalCents:',
    'envioCents:',
    'precioCents:',
    'impuestoCents:',
  ];

  it('`cuerpoDeInicio` solo arma lo que el contrato pide', () => {
    // Se mira la función, no el archivo entero: `pago.ts` declara los tipos de
    // la RESPUESTA, que sí traen `totalCents` porque los calcula el servidor.
    const codigo = soloCodigo(PAGO);
    const desde = codigo.indexOf('export function cuerpoDeInicio');
    expect(desde, 'no encontré `cuerpoDeInicio` en pago.ts').toBeGreaterThan(-1);
    const cuerpo = codigo.slice(desde, codigo.indexOf('\n}', desde));

    for (const campo of CAMPOS_DE_DINERO) {
      expect(cuerpo, `el cuerpo del pedido lleva ${campo}`).not.toContain(campo);
    }
    for (const campo of ['nombre:', 'celular:', 'lineas:', 'idempotencia:']) {
      expect(cuerpo, `al cuerpo del pedido le falta ${campo}`).toContain(campo);
    }
  });

  it('la ruta es la del contrato', () => {
    expect(RUTA_DE_INICIO).toBe('/api/pago/yappy/iniciar');
  });
});

describe('el botón no se queda girando cuando el servidor dice no', () => {
  /**
   * `btnClicked()` del componente pone `isButtonLoading = true` y le añade al
   * botón `disable-btn` (`opacity:.4; pointer-events:none`). Esa clase se
   * quita en UN sitio: al terminar la suscripción a Firestore, que solo existe
   * si se llamó a `eventPayment`. O sea: si la llamada al servidor falla y
   * nadie hace nada, el botón se queda girando y apagado para siempre.
   */
  const codigo = soloCodigo(BOTON);

  it('se baja `isButtonLoading` a mano', () => {
    expect(codigo, 'falta bajar isButtonLoading en el camino de fallo').toMatch(
      /isButtonLoading\s*=\s*false/,
    );
  });

  it('y además se vuelve a crear el botón, porque la propiedad no quita la clase', () => {
    expect(codigo, 'falta rehacer el botón tras un fallo').toMatch(/rehacer\(\)/);
    expect(codigo).toMatch(/setGeneracion/);
  });

  it('`eventPayment` se llama dentro del manejador de `eventClick`', () => {
    const desde = codigo.indexOf("addEventListener('eventClick'");
    expect(desde, 'no hay escucha de eventClick').toBeGreaterThan(-1);
    const hasta = codigo.indexOf("addEventListener('eventSuccess'", desde);
    const dentro = codigo.slice(desde, hasta);
    expect(dentro, 'eventPayment no se llama al pulsar').toContain('eventPayment(');
    for (const campo of ['transactionId', 'documentName', 'token']) {
      expect(dentro, `eventPayment no recibe ${campo}`).toContain(campo);
    }
  });

  it('`isYappyOnline` se escucha y la pantalla explica el «false»', () => {
    expect(codigo).toContain("addEventListener('isYappyOnline'");
    const pantalla = soloCodigo(PANTALLA);
    expect(pantalla, 'nadie explica por qué el botón está muerto').toMatch(
      /yappyEnLinea === false/,
    );
    expect(pantalla).toContain('Yappy no está disponible');
  });

  it('un `eventError` ANTERIOR al primer pago no rehace el botón', () => {
    /**
     * Es el bucle que se vio en una captura: el componente emite `eventError`
     * cuando falla su propia comprobación de disponibilidad, que corre sola al
     * renderizar. Si eso rehace el botón, el botón nuevo vuelve a comprobar,
     * vuelve a fallar y vuelve a rehacerse — una rueda infinita contra la API
     * de Yappy, en la pantalla de una clienta. Y de paso la pantalla decía «el
     * pago no se completó» sin que nadie hubiera intentado pagar.
     */
    expect(codigo, 'falta la bandera que distingue un pago fallido de Yappy caído').toContain(
      'seMandoAPagar',
    );
    const desde = codigo.indexOf("addEventListener('eventError'");
    const hasta = codigo.indexOf("addEventListener('isYappyOnline'", desde);
    const dentro = codigo.slice(desde, hasta);
    expect(dentro, 'eventError rehace el botón sin mirar si hubo pago').toMatch(
      /if\s*\(!seMandoAPagar\.current\)/,
    );
    // Y la bandera se pone justo antes de mandar a pagar, no en otro sitio.
    expect(codigo).toMatch(/seMandoAPagar\.current = true;\s*\n\s*boton\.eventPayment\(/);
    // Y se baja con cada botón nuevo: si no, el segundo heredaría el «sí» del
    // primero y volvería el bucle por otra puerta.
    expect(codigo).toMatch(/seMandoAPagar\.current = false;/);
  });

  it('`eventError` aguanta un código que no esté en la lista', () => {
    // El componente emite por `eventError` también el error de su propia
    // comprobación de disponibilidad, que no es ninguno de los cinco códigos.
    expect(NO_SALIO_SIN_CODIGO.length).toBeGreaterThan(20);
    for (const codigoDeYappy of [
      'EXPIRED',
      'FAILED',
      'DENIED',
      'DUPLICATED_TRANSACTION',
      'CANCELLED',
    ]) {
      expect(PORQUE_NO_SALIO[codigoDeYappy], codigoDeYappy).toBeTypeOf('string');
    }
  });
});

describe('el mensaje del servidor se enseña tal cual', () => {
  it('la pantalla pinta el mensaje sin tocarlo', () => {
    const pantalla = soloCodigo(PANTALLA);
    expect(pantalla).toContain('{queDijoElServidor}');
    // Si alguien lo pasa por un diccionario de frases propias, el mensaje que
    // el servidor redactó para la clienta deja de llegarle.
    expect(pantalla).not.toMatch(/queDijoElServidor\s*\]/);
  });
});
