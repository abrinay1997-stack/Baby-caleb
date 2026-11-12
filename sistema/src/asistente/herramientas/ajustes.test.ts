import { env as real } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { guardar } from "../../db/ajustes";
import { CLAVES } from "../../dominio/ajustes";
import { ejecutar } from "../ejecutar";
import { catalogo } from "../index";
import { revisar } from "../referencias";
import type { Contexto } from "../registro";
import { verHistorialDeAjuste } from "./ajustes";

/**
 * El historial de un ajuste, por fuera del panel.
 *
 * La pregunta que contesta es «¿quién bajó la comisión en marzo, y por qué?», y
 * hasta ahora solo tenía respuesta abriendo una pantalla. Lo que se vigila aquí:
 *
 *  - que la versión que MANDA sea la que manda, aunque haya una programada por
 *    encima: una lista ordenada se lee como «la de arriba es la que vale», y
 *    eso es falso cuando la de arriba empieza la semana que viene;
 *  - que una respuesta vacía venga explicada, porque «[]» a secas se contesta
 *    como «nunca se ha cambiado» y eso no es lo mismo que «ese ajuste no
 *    existe»;
 *  - y que el correo de quien lo cambió NO salga entero hacia el modelo.
 */

const ahora = () => Date.now();
const DIA = 24 * 60 * 60 * 1000;

const DUENA = "u-ajustes-duena";
const CORREO = "duena-ajustes@babycaleb.com";

const ctx = (): Contexto => ({
  db: real.DB,
  usuario: { id: DUENA, correo: CORREO, rol: "duena" },
  canal: "panel",
  conversacionId: null,
  ahora: ahora(),
});

beforeAll(async () => {
  await real.DB.prepare(
    "INSERT OR IGNORE INTO usuarios (id,correo,nombre,rol,activo,creado_en) VALUES (?,?,'Dueña ajustes','duena',1,?)",
  )
    .bind(DUENA, CORREO, ahora())
    .run();
});

/**
 * Guarda una versión por el MISMO camino que la ruta del panel.
 *
 * La clave entra como parámetro porque una versión PROGRAMADA bloquea las
 * siguientes de esa misma clave —no se puede colar un cambio por debajo de uno
 * futuro, o el futuro no llegaría a valer nunca—, así que la prueba que
 * programa una se queda con su clave para ella.
 */
async function guardarVersion(
  clave: string,
  valor: number,
  motivo: string,
  dentroDeDias = 0,
): Promise<void> {
  const r = await guardar(
    { db: real.DB, ahora: ahora(), actor: CORREO },
    {
      clave,
      valor,
      motivo,
      ...(dentroDeDias === 0 ? {} : { vigenteDesde: ahora() + dentroDeDias * DIA }),
    },
  );
  if (!r.ok) throw new Error(`no se pudo sembrar el ajuste: ${r.mensaje}`);
}

describe("ver_historial_de_ajuste", () => {
  it("sin decir cuál, no adivina ninguno", async () => {
    const r = await verHistorialDeAjuste.ejecutar(ctx(), {});

    expect(r.ajuste).toBeNull();
    expect(r.versiones).toEqual([]);
    expect(r.aviso).toContain("falta decir");
  });

  it("la lista de ajustes va en la DESCRIPCIÓN, nunca en el resultado", async () => {
    // Esto no es estilo. La guarda de D-20 compara lo que sale con los nombres
    // de clientas que hay en la base, y un nombre corto casa dentro de una
    // palabra larga: «Ana» vive dentro de «ventanas_entrega». Con la lista
    // dentro del resultado, tener una clienta llamada Ana tumbaba el resultado
    // ENTERO —lo encontró la prueba de D-20 de todas las herramientas— y la
    // herramienta dejaba de servir. En el esquema la lista llega igual de
    // completa y no pasa por la guarda.
    // El esquema es lo que de verdad viaja hacia el modelo, igual que lo arma
    // el registro.
    const esquema = JSON.stringify(z.toJSONSchema(verHistorialDeAjuste.parametros));
    expect(esquema).toContain("ventanas_entrega");

    const r = await verHistorialDeAjuste.ejecutar(ctx(), {});
    expect(JSON.stringify(r)).not.toContain("ventanas_entrega");
    expect(revisar(r, ["Ana"])).toEqual([]);

    // El contrapeso: con la lista dentro, la guarda SÍ se queja. Sin esto, la
    // comprobación de arriba podría pasar porque `revisar` no mira nada.
    expect(revisar({ aviso: `los que hay: ${CLAVES.join(", ")}` }, ["Ana"])).not.toEqual([]);
  });

  it("un nombre que no es un ajuste se explica, no se contesta con una lista vacía", async () => {
    const r = await verHistorialDeAjuste.ejecutar(ctx(), { ajuste: "comision_inventada" });

    expect(r.cuantas).toBe(0);
    // El texto es el de `db/ajustes.ts`: dos redacciones de la misma causa
    // acaban discrepando.
    expect(r.aviso).toContain("no es un ajuste de este sistema");
    expect(r.aviso).not.toMatch(/nunca se ha cambiado/);
  });

  it("un ajuste que nunca se ha cambiado lo dice, y no suena a que no exista", async () => {
    // `modelo_respaldo` está PENDIENTE y no tiene ni una versión: la respuesta
    // correcta es «vale el valor de fábrica», no «no hay nada».
    const r = await verHistorialDeAjuste.ejecutar(ctx(), { ajuste: "modelo_respaldo" });

    expect(r.versiones).toEqual([]);
    expect(r.aviso).toContain("valor de fábrica");
  });

  it("devuelve las versiones de la más nueva a la más vieja", async () => {
    await guardarVersion("stock_bajo", 5, "arrancamos con cinco cajas");
    await guardarVersion("stock_bajo", 8, "subimos el umbral");

    const r = await verHistorialDeAjuste.ejecutar(ctx(), { ajuste: "stock_bajo" });

    expect(r.cuantas).toBeGreaterThanOrEqual(2);
    const versiones = r.versiones.map((v) => v.version);
    expect(versiones).toEqual([...versiones].sort((a, b) => b - a));
    expect(r.versiones[0]?.valor).toBe(8);
    expect(r.versiones[0]?.motivo).toBe("subimos el umbral");
    expect(r.aviso).toBeNull();
  });

  it("la que MANDA no es la de arriba si hay una programada", async () => {
    // Sin separar «vigente» de «futura», el modelo contestaría que el umbral
    // ya es el de la semana que viene.
    await guardarVersion("stock_bajo", 9, "lo que vale hoy");
    await guardarVersion("stock_bajo", 20, "lo que valdrá en una semana", 7);

    const r = await verHistorialDeAjuste.ejecutar(ctx(), { ajuste: "stock_bajo" });

    expect(r.versiones[0]?.valor).toBe(20);
    expect(r.versiones[0]?.futura).toBe(true);
    expect(r.versiones[0]?.vigente).toBe(false);

    const vigentes = r.versiones.filter((v) => v.vigente);
    expect(vigentes.length).toBe(1);
    expect(vigentes[0]?.valor).toBe(9);
  });

  it("el correo de quien lo cambió NO sale entero (D-20)", async () => {
    // `ajustes.cambiado_por` guarda el correo de la sesión. La guarda de D-20
    // rechaza cualquier resultado con un correo dentro —no sabe si es de una
    // clienta o del equipo, y aflojarla para que distinga sería abrirle la
    // puerta a lo que protege—, así que el servidor de MCP tumbaría el
    // resultado ENTERO y esta herramienta no serviría para nada.
    // Otra clave: la de arriba se quedó con un cambio programado.
    await guardarVersion("abono_minimo_cents", 1500, "para mirar la firma");

    const r = await verHistorialDeAjuste.ejecutar(ctx(), { ajuste: "abono_minimo_cents" });

    expect(JSON.stringify(r)).not.toContain(CORREO);
    expect(r.versiones[0]?.cambiado_por).toBe("duena-ajustes");
    expect(revisar(r)).toEqual([]);

    // El contrapeso: sin esto, `revisar` podría estar devolviendo siempre la
    // lista vacía y la comprobación de arriba no vigilaría nada.
    expect(revisar({ versiones: [{ cambiado_por: CORREO }] })).not.toEqual([]);
  });

  it("se puede pedir por donde la van a pedir: el registro", async () => {
    // Una herramienta escrita y no registrada no existe (docs/TRAMPAS.md §12).
    // Esto la llama como la llaman el panel, Telegram y MCP.
    const r = await ejecutar({ db: real.DB, usuario: ctx().usuario, ahora: ahora() }, catalogo(), {
      nombre: "ver_historial_de_ajuste",
      argumentos: { ajuste: "stock_bajo" },
      canal: "mcp",
      conversacionId: null,
      conAdjuntos: false,
      textoExterno: false,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos.clase).toBe("hecha");
  });
});
