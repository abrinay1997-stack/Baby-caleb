# Contrato entre el sistema y el CRM

> **El contrato vivo es el código**, en `sistema/src/contrato/`. Este documento
> explica cómo funciona y qué hay que hacer en el otro repo. Si los dos no
> coinciden, manda el código. El diseño y el porqué de cada método están en
> [`docs/plan/03-contratos.md`](plan/03-contratos.md).

## Las dos piezas

| Repo | Qué es | Cómo se conecta |
|---|---|---|
| `abrinay1997-stack/Baby-caleb` → `sistema/` | Worker `babycaleb-sistema`. Dueño de pedidos, inventario, dinero y entregas | Expone los entrypoints `SistemaWeb` y `SistemaCRM` |
| `juanarrietabusiness-pixel/CRM-Baby-Caleb` | Worker `juancitoads-bot`. El bot de atención y la consola de la dueña | Llama al sistema por service binding y consume la cola `bc-avisos` |

**No hay bindings circulares.** El CRM tiene binding al sistema; el sistema no
tiene binding al CRM. Lo que el sistema le quiere decir al CRM va por la cola
`bc-avisos`. Orden de despliegue cuando cambia el contrato: **sistema primero,
CRM después.**

## La huella, y por qué existe

El CRM tiene una **copia** de los esquemas en `src/sistema/contrato.ts`. Si una
copia se queda atrás, el síntoma no es un error claro: es un pedido que entra
con un campo que el otro lado ignora, o un evento que llega con una etiqueta que
no entiende, y eso se descubre semanas después mirando por qué un aviso no
salió.

Para que eso sea imposible, los dos repos calculan una **huella** de su copia y
tienen una prueba que la compara contra una constante escrita a mano:

- En el sistema: `sistema/src/contrato/huella.ts` (`HUELLA_CONTRATO`) y
  `huella.test.ts`. Se recalcula con `npm run huella` desde `sistema/`.
- En el CRM: la misma constante y la misma prueba.

La huella sale del **significado** de los esquemas (su JSON Schema), no de su
texto: arreglar una tilde en un comentario no la cambia, y agregar un campo
—aunque sea opcional— sí. Eso último es a propósito: un campo nuevo es
compatible hacia atrás, pero los dos lados tienen que saber que existe.

### Cómo se cambia el contrato

1. Cambiarlo en `docs/plan/03-contratos.md` (el porqué).
2. Cambiar `sistema/src/contrato/`. `npm run huella` dirá la huella nueva.
3. Poner esa huella en `HUELLA_CONTRATO`.
4. Copiar los esquemas al CRM con **la misma** huella.
5. Desplegar el sistema y después el CRM.

Si solo se arregla un lado, el otro se pone rojo. Eso es la función, no un
estorbo.

### Qué cambios son compatibles

| Cambio | ¿Se puede? |
|---|---|
| Agregar un campo opcional | Sí |
| Agregar un método nuevo | Sí |
| Agregar un tipo de evento | Sí |
| Quitar un campo o cambiar su tipo | **No**: versión nueva del método (`registrarVentaV2`) y se retira la vieja cuando el CRM ya no la use |
| Renombrar cualquier cosa | **No**: es quitar y agregar a la vez |

## Reglas que el contrato da por sentadas

1. **Ningún método lanza errores de negocio.** Devuelven
   `{ ok: true; datos: T }` o `{ ok: false; codigo; mensaje }`. Una excepción
   que cruza un binding pierde su tipo y llega como un error genérico, así que
   un error devuelto es la única forma de que el otro lado pueda decidir.
2. **Los montos son enteros de centavos y los calcula siempre el sistema.**
   Ningún método de entrada acepta un precio: `crearPedido` recibe códigos y
   cantidades. El navegador no decide un cobro.
3. **El bot y la web nunca reciben el costo ni la cantidad exacta de stock.**
   Reciben `disponibilidad`: `disponible` · `pocas` · `agotado`. Son los mismos
   tres valores que ya usa el CRM en `src/catalog/validation.ts`, y el umbral de
   «pocas» es su `STOCK_BAJO = 5`, que pasa a `ajustes` para que la dueña lo
   pueda cambiar.
4. **Quién actúa viaja en cada llamada que escribe** (`actor`), y el sistema
   decide si ese actor puede. Un actor `bot` nunca puede llamar a los métodos de
   la dueña: se rechaza con `no_autorizado`.
5. **Toda escritura lleva `idempotencia`.** Misma clave y misma entrada → misma
   respuesta, sin escribir de nuevo. Misma clave con otra entrada → `repetido`.
   Vence a las 48 h. En los botones de Telegram la clave es el id de la acción
   propuesta, así dos toques no venden dos veces.
6. **Las colas entregan al menos una vez.** Cada consumidor guarda el `id` del
   evento en su propia tabla y no lo repite. El CRM necesita la suya.

## Los doce códigos de error

`entrada_invalida` · `no_encontrado` · `no_autorizado` · `sin_stock` ·
`transicion_invalida` · `conflicto_version` · `monto_no_coincide` ·
`pasarela_no_disponible` · `periodo_cerrado` · `repetido` · `limite` · `interno`

El otro lado decide qué hacer según el **código**, no según el texto: el
`mensaje` está en español y puede cambiar sin avisar, porque se muestra o se le
da al modelo para que corrija.

## Los eventos de `bc-avisos` (los consume el CRM)

| Tipo | Qué hace el CRM |
|---|---|
| `pedido.creado` | Aviso a la dueña por Telegram |
| `pago.confirmado` | Aviso a la dueña; a la clienta, «recibimos su pago» |
| `pedido.agendado` | A la clienta: pedido agendado |
| `pedido.en_ruta` | A la clienta: va en camino, con enlace de seguimiento |
| `pedido.entregado` | Marca «compró» en `compras` (descanso de 15 días y recompra) |
| `pedido.cancelado` | Aviso a la dueña |
| `inventario.bajo` | Aviso a la dueña |
| `sistema.alerta` | Aviso a la dueña o al equipo técnico |

El sobre de todo mensaje es `{ id, tipo, version, ocurridoEn, datos }`, y el
`id` es un ULID.

**Ningún evento lleva datos personales de clientas.** Va una `clienteRef`
—canal más id externo— y el CRM resuelve a quién avisar con sus propios datos.
Es la decisión D-20 aplicada también a las colas: un evento se guarda, se
reintenta y se registra, así que cuantos menos datos personales pase, mejor.

El CRM decide **por qué canal** sale cada aviso a la clienta, con esta regla:

1. Si escribió en las últimas 24 h por un canal, el aviso sale por ahí como
   mensaje normal.
2. Si no, y tiene celular: plantilla aprobada de la Cloud API, categoría
   utilidad, dentro del tope `WA_DAILY_TEMPLATE_CAP`.
3. **Nunca** un mensaje saliente nuevo por el puente QR fuera de una
   conversación abierta.
4. Si no hay forma de avisar, queda anotado en el pedido y la dueña lo ve en el
   panel.

## Lo que hay que cambiar en el CRM

Todo como extensión, para no chocar con la plantilla Juancito Ads si sigue
recibiendo actualizaciones. La lista completa está en
[`docs/plan/03-contratos.md` §7](plan/03-contratos.md); lo mínimo para empezar:

| Archivo | Qué hace |
|---|---|
| `wrangler.toml`: `[[services]] SISTEMA` con `entrypoint = "SistemaCRM"` | El binding al sistema |
| `wrangler.toml`: `[[queues.consumers]] bc-avisos` | El consumidor de avisos |
| `src/sistema/contrato.ts` | La copia de los esquemas, con la misma huella |
| `src/sistema/cliente.ts` | El cliente tipado del RPC |
| `src/catalog/fuente.ts` | `FuenteCatalogo` con `CatalogoLocal` y `CatalogoSistema`, elegida por `CATALOGO_FUENTE` |
| `src/eventos/consumidor.ts` + `queue()` | Los avisos a la clienta y a la dueña |

El interruptor `CATALOGO_FUENTE` es lo que hace reversible el traspaso: con
`local` el CRM sigue leyendo su propia D1, y con `sistema` pregunta al sistema.
Si algo sale mal durante la ventana de traspaso, se vuelve a `local` sin
desplegar nada.

## Estado

| Parte | Dónde está |
|---|---|
| `Resultado`, los doce códigos | ✅ `sistema/src/contrato/resultado.ts` |
| Esquemas de catálogo, zonas, pedidos y pagos | ✅ `sistema/src/contrato/esquemas.ts` |
| Eventos de las dos colas | ✅ `sistema/src/contrato/eventos.ts` |
| Huella y su prueba | ✅ `sistema/src/contrato/huella.ts` |
| **Los métodos implementados** | ⏳ F3 en adelante: hoy los entrypoints responden que todavía no están |
| La copia en el CRM | ⏳ F3.3 |
