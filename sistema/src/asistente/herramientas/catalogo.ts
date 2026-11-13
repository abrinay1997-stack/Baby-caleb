import { z } from "zod";
import { libresSQL } from "../../db/inventario";
import { cuantosCombos, loQueFrena } from "../../dominio/combos";
import { formatear } from "../../dominio/dinero";
import { UMBRAL_POCAS, disponibilidad } from "../../dominio/existencias";
import { estadoEnLaTienda } from "../../tienda/fichas";
import { definir } from "../registro";

/**
 * Lo que se le puede CONTESTAR A UNA CLIENTA de un artículo.
 *
 * Las herramientas de `inventario.ts` sirven para ir a la bodega: dan el número
 * exacto por bodega, y están bien así porque quien pregunta es del equipo. Estas
 * dos sirven para contestar un WhatsApp, y por eso están partidas: lo que el
 * asistente tiene en la mano cuando redacta una respuesta para una clienta es la
 * ETIQUETA («disponible / quedan pocas / agotado»), nunca la cantidad. Si nunca
 * tiene la cifra, no la puede soltar por error — es la misma razón por la que el
 * catálogo público tampoco la lleva (03-contratos §3, regla 3).
 *
 * Lo que había antes y no servía para esto:
 *
 *  - `ver_stock` exige el CÓDIGO. Una clienta no escribe «BC-001-03», escribe
 *    «¿tienen talla M?». Sin una búsqueda por palabras no había forma de pasar
 *    de lo que ella dice a lo que la base sabe, y un modelo sin forma de
 *    averiguar un código se lo inventa.
 *  - NINGUNA herramienta devolvía el PRECIO. «¿Cuánto cuesta?» es la pregunta
 *    más frecuente que existe y el asistente no la podía contestar con un dato:
 *    solo inventándolo, que es justo lo que 06-asistente §3 punto 7 prohíbe.
 *  - El RANGO DE PESO («¿hasta qué peso sirve la L?») está en `variantes` y no
 *    salía por ningún sitio.
 *  - De un COMBO, `ver_stock` contestaba una lista vacía, porque un combo no
 *    tiene fila en `existencias`. El modelo leía eso como «no hay».
 *
 * El costo no sale por aquí ni por accidente: no está en el SELECT. Vive en
 * `valor_inventario` y tiene su propio permiso (`costo_y_margen`).
 */

const codigoDe = z
  .string()
  .min(1)
  .max(40)
  .describe("El código del artículo, como NAT-M o DANY-AW600.");

/**
 * El peso en palabras.
 *
 * `peso_max_lb` en NULL significa dos cosas distintas en la misma columna: en
 * NAT-XXL es «+55 lbs», o sea sin tope anotado; en las toallitas es que el peso
 * no aplica. Desde aquí no se pueden distinguir, así que no se elige: se dice lo
 * que se sabe y se calla lo que no.
 *
 * Lo que NO se hace es devolver un 0 ni un null a secas y confiar en que el
 * modelo lo lea bien. «hasta 0 lb» es una frase que un modelo escribe sin
 * pestañear, y con el peso de un bebé encima eso es un consejo peligroso.
 */
export function comoSeLeeElPeso(desde: number | null, hasta: number | null): string {
  if (desde !== null && hasta !== null) return `de ${desde} a ${hasta} lb`;
  if (desde !== null) return `desde ${desde} lb, sin tope anotado`;
  if (hasta !== null) return `hasta ${hasta} lb`;
  return "no está anotado el peso de este artículo";
}

interface FilaArticulo {
  codigo: string;
  nombre: string;
  producto: string;
  talla: string | null;
  peso_min_lb: number | null;
  peso_max_lb: number | null;
  unidades_por_caja: number;
  precio_cents: number;
  es_combo: number;
  publicado: number;
  activo: number;
  siguiente_codigo: string | null;
  libres: number | null;
}

/**
 * `v.talla` se compara EXACTA y el resto por parecido.
 *
 * Con `LIKE '%m%'` sobre la talla, quien pregunta por la M recibe también la
 * «Unitalla», y una talla equivocada en un pañal es una caja devuelta. Las
 * tallas son dos o tres letras: o es la que se pidió, o no es.
 */
const CONSULTA = `
  SELECT v.codigo, v.nombre, p.nombre AS producto, v.talla,
         v.peso_min_lb, v.peso_max_lb, v.unidades_por_caja, v.precio_cents,
         v.es_combo, v.publicado, v.activo, v.siguiente_codigo,
         ${libresSQL("v")} AS libres
  FROM variantes v
  JOIN productos p ON p.id = v.producto_id`;

export const buscarArticulo = definir({
  nombre: "buscar_articulo",
  descripcion:
    "Busca artículos por palabras: nombre, código o talla. Devuelve el precio, la talla, el rango de peso, cuántas unidades trae la caja y si hay (disponible / quedan pocas / agotado). Es lo que se usa para contestarle a una clienta. Ejemplo: buscar_articulo con texto «talla M» devuelve el pañal Nateen talla M con su precio y si hay.",
  parametros: z.object({
    texto: z
      .string()
      .min(1)
      .max(80)
      .describe("Lo que dijo la clienta: «talla M», «toallitas», «NAT-L», «fular»."),
    cuantos: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Cuántos artículos devolver como máximo."),
  }),
  nivel: "lectura",
  categoria: "catalogo",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    // `%` y `_` son los comodines de LIKE: sin quitarlos, quien escribe «%»
    // recibe el catálogo entero como si cada artículo fuera un acierto.
    const limpio = args.texto.replaceAll("%", "").replaceAll("_", "").trim();
    if (limpio === "") {
      return {
        articulos: [],
        cuantos: 0,
        aviso: "la búsqueda se quedó vacía al quitarle los comodines: pregunte con palabras",
      };
    }

    const { results } = await ctx.db
      .prepare(
        `${CONSULTA}
         WHERE v.nombre LIKE ?1 COLLATE NOCASE
            OR v.codigo LIKE ?1 COLLATE NOCASE
            OR p.nombre LIKE ?1 COLLATE NOCASE
            OR v.talla = ?2 COLLATE NOCASE
         ORDER BY
           -- Lo que ES lo buscado va antes que lo que solo lo contiene.
           CASE WHEN v.codigo = ?2 COLLATE NOCASE THEN 0
                WHEN v.talla = ?2 COLLATE NOCASE THEN 1
                WHEN v.codigo LIKE ?3 COLLATE NOCASE THEN 2
                ELSE 3 END,
           p.orden, p.nombre, v.talla, v.codigo
         LIMIT ?4`,
      )
      .bind(`%${limpio}%`, limpio, `${limpio}%`, args.cuantos)
      .all<FilaArticulo>();

    return {
      articulos: results.map((f) => ({
        codigo: f.codigo,
        nombre: f.nombre,
        producto: f.producto,
        talla: f.talla,
        precioCents: f.precio_cents,
        // El precio también en palabras: el modelo tiene que escribir «$50.00»
        // en un WhatsApp, y dividir 5000 entre 100 es una cuenta que a veces
        // sale «$500.00». La hace `formatear`, que es la misma del panel.
        precio: formatear(f.precio_cents),
        unidadesPorCaja: f.unidades_por_caja,
        peso: comoSeLeeElPeso(f.peso_min_lb, f.peso_max_lb),
        pesoDesdeLb: f.peso_min_lb,
        pesoHastaLb: f.peso_max_lb,
        // La ETIQUETA, no el número. Lo que no se tiene no se suelta.
        hay: disponibilidad(f.libres ?? 0, UMBRAL_POCAS),
        esCombo: f.es_combo === 1,
        // Las dos cosas que impiden venderlo aunque haya existencias.
        seVendeEnLaWeb: f.publicado === 1,
        activo: f.activo === 1,
        // Qué ofrecerle cuando al bebé se le queda chica la que compra. NULL es
        // «no hay siguiente anotada», no «no hay otra talla».
        laSiguienteTalla: f.siguiente_codigo,
      })),
      cuantos: results.length,
      aviso:
        results.length === 0
          ? `no hay ningún artículo que case con «${args.texto}». No lo describa de memoria: pregunte de otra forma o revise el catálogo.`
          : null,
    };
  },
});

export const verCombo = definir({
  nombre: "ver_combo",
  descripcion:
    "Cuántas unidades de un combo se pueden armar hoy y qué componente lo frena. Un combo no tiene existencias propias: caben tantos como permita el componente que menos alcance. Ejemplo: ver_combo con codigo «CO-CANASTILLA» dice cuántas canastillas se pueden armar y que lo que falta son las toallitas.",
  parametros: z.object({ codigo: codigoDe }),
  nivel: "lectura",
  categoria: "catalogo",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    const v = await ctx.db
      .prepare("SELECT codigo, nombre, es_combo, precio_cents FROM variantes WHERE codigo = ?")
      .bind(args.codigo)
      .first<{ codigo: string; nombre: string; es_combo: number; precio_cents: number }>();

    if (v === null) {
      return {
        codigo: args.codigo,
        existe: false,
        esCombo: false,
        aviso: `no existe ningún artículo con el código «${args.codigo}»`,
      };
    }

    // Decirlo y no fallar: un modelo que se equivoca de herramienta tiene que
    // poder corregirse en el mismo turno, no quedarse sin respuesta.
    if (v.es_combo !== 1) {
      return {
        codigo: v.codigo,
        nombre: v.nombre,
        existe: true,
        esCombo: false,
        aviso: `«${v.codigo}» no es un combo: es un artículo normal. Pregunte con ver_stock o buscar_articulo.`,
      };
    }

    const { results } = await ctx.db
      .prepare(
        `SELECT cc.codigo, v.nombre, cc.cantidad,
                (SELECT SUM(e.fisico - e.reservado) FROM existencias e WHERE e.codigo = cc.codigo) AS libres
         FROM combo_componentes cc
         JOIN variantes v ON v.codigo = cc.codigo
         WHERE cc.combo_codigo = ?
         ORDER BY cc.codigo`,
      )
      .bind(args.codigo)
      .all<{ codigo: string; nombre: string; cantidad: number; libres: number | null }>();

    // `libres` en NULL es «este componente no está dado de alta en ninguna
    // bodega»: no se sabe cuánto hay. Se trata aparte y no como un cero, porque
    // «no se pueden armar porque falta mercancía» y «no se pueden armar porque
    // un componente no está dado de alta» se arreglan de maneras distintas, y
    // quien lea la respuesta tiene que saber cuál de las dos es.
    const sinDarDeAlta = results.filter((c) => c.libres === null).map((c) => c.codigo);

    const componentes = results.map((c) => ({
      codigo: c.codigo,
      cantidad: c.cantidad,
      libres: c.libres ?? 0,
    }));

    const sePuedenArmar = sinDarDeAlta.length > 0 ? 0 : cuantosCombos(componentes);

    return {
      codigo: v.codigo,
      nombre: v.nombre,
      existe: true,
      esCombo: true,
      precioCents: v.precio_cents,
      precio: formatear(v.precio_cents),
      // La cuenta la hace `cuantosCombos`, que es la regla con sus pruebas, y
      // la etiqueta sale de la misma función que el catálogo: así el asistente
      // y el bot no pueden decir cosas distintas del mismo combo.
      sePuedenArmar,
      hay: disponibilidad(sePuedenArmar, UMBRAL_POCAS),
      componentes: results.map((c) => ({
        codigo: c.codigo,
        nombre: c.nombre,
        porCombo: c.cantidad,
        libres: c.libres,
        // Sin esto hay que mirar `libres` y dividir, y es donde un modelo se
        // equivoca: 7 libres con 2 por combo son 3 combos, no 3.5.
        alcanzaPara: c.libres === null ? null : Math.floor(c.libres / c.cantidad),
      })),
      loQueFrena: sinDarDeAlta.length > 0 ? sinDarDeAlta : loQueFrena(componentes),
      sinDarDeAlta,
      aviso:
        results.length === 0
          ? `«${v.codigo}» está marcado como combo pero no tiene receta: no se puede armar ninguno. Hay que ponerle sus componentes.`
          : sinDarDeAlta.length > 0
            ? `no se sabe cuánto hay de ${sinDarDeAlta.join(", ")}: no está dado de alta en ninguna bodega. Mientras tanto no se puede prometer ningún combo.`
            : null,
    };
  },
});

export const verEnLaTienda = definir({
  nombre: "ver_en_la_tienda",
  descripcion:
    "Dice qué artículos se están enseñando AHORA en babycaleb.com y, de los que no, por qué no. Contesta la pregunta «publiqué un producto y no aparece en la web». Sin código, lista los publicados que la tienda no está enseñando. Ejemplo: ver_en_la_tienda con codigo «NAT-M» dice si una clienta la ve en la tienda.",
  parametros: z.object({
    codigo: codigoDe
      .optional()
      .describe("Opcional. Sin él, salen todos los publicados que la tienda no enseña."),
  }),
  nivel: "lectura",
  categoria: "catalogo",
  roles: ["duena", "asistente", "contadora"],

  async ejecutar(ctx, args) {
    if (args.codigo !== undefined) {
      const v = await ctx.db
        .prepare("SELECT codigo, nombre, publicado, activo FROM variantes WHERE codigo = ?")
        .bind(args.codigo)
        .first<{ codigo: string; nombre: string; publicado: number; activo: number }>();

      if (v === null) {
        return {
          codigo: args.codigo,
          existe: false,
          aviso: "no existe ningún artículo con ese código",
        };
      }
      const estado = estadoEnLaTienda(v);
      return {
        codigo: v.codigo,
        nombre: v.nombre,
        existe: true,
        saleEnLaTienda: estado.sale,
        porQueNo: estado.motivo,
      };
    }

    const { results } = await ctx.db
      .prepare(
        `SELECT codigo, nombre, publicado, activo FROM variantes
         WHERE activo = 1 ORDER BY codigo`,
      )
      .all<{ codigo: string; nombre: string; publicado: number; activo: number }>();

    const fuera = results
      .map((v) => ({ v, estado: estadoEnLaTienda(v) }))
      .filter((x) => !x.estado.sale)
      .map((x) => ({ codigo: x.v.codigo, nombre: x.v.nombre, porQueNo: x.estado.motivo }));

    return {
      enLaTienda: results.length - fuera.length,
      fueraDeLaTienda: fuera.length,
      cuales: fuera,
      aviso:
        fuera.length === 0
          ? "todo lo publicado se está enseñando en la tienda"
          : "estos artículos no los ve una clienta entrando a la tienda",
    };
  },
});

export const HERRAMIENTAS_DE_CATALOGO = [buscarArticulo, verCombo, verEnLaTienda] as const;
