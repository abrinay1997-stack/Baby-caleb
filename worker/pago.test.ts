import { describe, expect, it } from "vitest";

import { avisoDeYappy, type SistemaDelAviso } from "./pago";

/**
 * La ruta del aviso de Yappy.
 *
 * Lo que se prueba aquí es SOLO el enrutado: que la cadena de consulta llegue
 * entera al sistema y que el código de respuesta sea el que hace que Yappy
 * reintente o no. La verificación de la firma se prueba donde vive, del lado
 * del sistema (`test/aviso-de-yappy.test.ts`), que es donde están la clave y
 * los datos.
 */

const sistemaQue = (
  r: Awaited<ReturnType<NonNullable<SistemaDelAviso["avisoDeYappy"]>>> | "revienta",
): SistemaDelAviso & { visto: string[] } => {
  const visto: string[] = [];
  return {
    visto,
    async avisoDeYappy(consulta: string) {
      visto.push(consulta);
      if (r === "revienta") throw new Error("el binding no contestó");
      return r;
    },
  };
};

const GET = (q: string) => new Request(`https://babycaleb.com/api/pago/yappy${q}`);

describe("la ruta del aviso", () => {
  /**
   * LA CADENA LLEGA ENTERA Y SIN TOCAR.
   *
   * El hash se calcula sobre valores exactos. Si esta ruta decodificara,
   * recortara o reordenara algo, la firma dejaría de cuadrar y NINGÚN pago se
   * podría verificar — con el agravante de que el síntoma sería «todos los
   * pagos fallan», que parece un problema de Yappy y no nuestro.
   */
  it("pasa la consulta tal cual al sistema", async () => {
    const s = sistemaQue({ ok: true, datos: { estado: "ejecutado", mensaje: "ok" } });
    const q = "?orderId=BC104X1&status=E&domain=babycaleb.com&hash=abc123";
    await avisoDeYappy(GET(q), s);
    expect(s.visto[0]).toBe(q);
  });

  it("un aviso aplicado contesta 200", async () => {
    const s = sistemaQue({ ok: true, datos: { estado: "ejecutado", mensaje: "ok" } });
    expect((await avisoDeYappy(GET("?orderId=A&status=E"), s)).status).toBe(200);
  });

  /**
   * Una firma inválida también contesta 200, y es a propósito: Yappy reintenta
   * lo que no recibe un 200, y un aviso falso no se vuelve verdadero por
   * reintentarlo. Lo único que se conseguiría es recibirlo cinco veces más.
   */
  it("una firma inválida contesta 200: reintentarlo no lo arregla", async () => {
    const s = sistemaQue({ ok: false, codigo: "no_autorizado", mensaje: "la firma no cuadra" });
    expect((await avisoDeYappy(GET("?orderId=A&status=E"), s)).status).toBe(200);
  });

  /**
   * Pero un fallo NUESTRO contesta 500, para que Yappy vuelva. Es la
   * diferencia entre «esto no era válido» y «no pude mirarlo»: en el segundo
   * caso el pago puede ser bueno y perderlo cuesta dinero.
   */
  it("un fallo nuestro contesta 500, para que Yappy vuelva", async () => {
    for (const codigo of ["interno", "pasarela_no_disponible"]) {
      const s = sistemaQue({ ok: false, codigo, mensaje: "la base no contestó" });
      expect((await avisoDeYappy(GET("?orderId=A"), s)).status, codigo).toBe(500);
    }
  });

  it("si el binding revienta, también 500", async () => {
    const s = sistemaQue("revienta");
    expect((await avisoDeYappy(GET("?orderId=A"), s)).status).toBe(500);
  });

  it("solo GET: un POST se rechaza y no llega al sistema", async () => {
    const s = sistemaQue({ ok: true, datos: { estado: "ejecutado", mensaje: "ok" } });
    const r = await avisoDeYappy(
      new Request("https://babycaleb.com/api/pago/yappy?orderId=A", { method: "POST" }),
      s,
    );
    expect(r.status).toBe(405);
    expect(s.visto.length).toBe(0);
  });

  /**
   * SIN SISTEMA AL OTRO LADO, 500 Y NO 200.
   *
   * Un 200 le diría a Yappy «recibido y aplicado» sobre un pago que nadie
   * miró: el cobro se perdería en silencio y la clienta tendría el dinero
   * fuera y el pedido sin pagar.
   */
  it("sin binding del sistema, 500 para que Yappy vuelva", async () => {
    expect((await avisoDeYappy(GET("?orderId=A"), undefined)).status).toBe(500);
    expect((await avisoDeYappy(GET("?orderId=A"), {})).status).toBe(500);
  });
});
