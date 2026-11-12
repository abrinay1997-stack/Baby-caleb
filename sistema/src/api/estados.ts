/**
 * Del código del contrato al estado HTTP.
 *
 * Vive aparte de `panel.ts` porque lo usan las dos familias de rutas —las
 * del panel y las del asistente— y tenerlo en una e importarlo desde la otra
 * haría un ciclo entre los dos archivos.
 */

/**
 * El código del contrato decide el HTTP, no al revés.
 *
 * Los doce códigos son contrato con el CRM y quien llama actúa según el código,
 * no según el número. Esto existe para que el navegador y los intermedios
 * (cachés, proxys) no traten un conflicto como un éxito.
 */
export function codigoHttp(codigo: string): 400 | 403 | 404 | 409 | 422 | 500 {
  // `pasarela_no_disponible` no es un error del sistema: es que la pasarela
  // está encendida y le falta una credencial, o está apagada. Sin esta línea
  // caía en el 500 de abajo y quien lo viera buscaría una avería que no hay.
  if (codigo === "pasarela_no_disponible") return 409;
  // Igual que el anterior: «ese mes está cerrado» no es una avería del
  // sistema. Sin esta línea el panel enseñaría «error del sistema» cuando lo
  // correcto es decir que el periodo está cerrado y hay que reabrirlo.
  if (codigo === "periodo_cerrado") return 409;
  switch (codigo) {
    case "entrada_invalida":
      return 400;
    case "no_autorizado":
      return 403;
    case "no_encontrado":
      return 404;
    // Repetido y conflicto de versión son los dos «alguien llegó antes»: 409 es
    // justo lo que significa, y la pantalla sabe que toca recargar.
    case "repetido":
    case "conflicto_version":
      return 409;
    case "transicion_invalida":
    case "sin_stock":
      return 422;
    default:
      return 500;
  }
}
