# 03 · Contratos entre la web, el sistema y el CRM

Este documento es el borrador de `docs/CONTRATO_CRM.md` (sistema ↔ CRM) y del contrato web ↔
sistema. Cuando se construya, el contrato vivo es el código de `sistema/src/contrato/` y este texto
lo explica. Si no coinciden, manda el código.

## 1. Principios

- **RPC por service binding** con entrypoints con nombre: `SistemaWeb` (para la web), `SistemaCRM`
  (para el CRM) y `CanalWeb` (en el CRM, para la web). Cada entrypoint expone solo lo suyo.
- **Ningún método lanza errores de negocio**: devuelven `Resultado<T>` (§5). Una excepción que
  cruza un binding pierde su tipo y llega como un error genérico.
- **Entradas validadas con zod en el lado que recibe**, aunque el que llama también valide.
- **Montos siempre en centavos (enteros) y siempre calculados por el sistema.**
- **El bot y la web nunca reciben costo ni cantidad exacta de stock**: disponibilidad en etiqueta
  (`disponible` · `pocas` · `agotado`), como `disponibilidadDe()` del CRM. El umbral de «pocas» es
  `STOCK_BAJO = 5` del CRM, que pasa a `ajustes`.
- **Quién actúa** viaja en cada llamada que escribe (`actor`), y el sistema decide si ese actor puede.

## 2. `SistemaWeb`: lo que la web puede pedir

```ts
type Disponibilidad = 'disponible' | 'pocas' | 'agotado';

interface VariantePublica {
  codigo: string;            // 'NAT-M'
  slug: string;              // 'panal-nateen-talla-m'
  nombre: string;
  talla: string | null;
  pesoMinLb: number | null; pesoMaxLb: number | null;
  unidadesPorCaja: number;
  precioCents: number;
  disponibilidad: Disponibilidad;
}
interface CatalogoPublico { version: number; generadoEn: number; variantes: VariantePublica[] }

interface SistemaWeb {
  catalogo(): Promise<Resultado<CatalogoPublico>>;
  zonasEnvio(): Promise<Resultado<{ id: string; nombre: string; alias: string[]; region: 'ciudad' | 'interior';
    tarifaCents: number | null; requierePagoTotal: boolean }[]>>;

  crearPedido(entrada: {
    idempotencia: string;                                   // UUID que genera el navegador por intento
    lineas: { codigo: string; cantidad: number }[];         // nada de precios
    cliente: { nombre: string; celular: string; correo?: string; consentimientoMkt: boolean };
    entrega: { zonaId: string; texto: string; referencia?: string; lat?: number; lng?: number;
               precision?: 'gps' | 'pin' | 'geocodificado' | 'manual' };
    notas?: string;
    identidadWeb?: string;                                  // sesión de Mi cuenta, si hay
  }): Promise<Resultado<{ numero: string; token: string; totalCents: number; abonoMinimoCents: number;
      requierePagoTotal: boolean; venceEn: number | null; metodos: MetodoDePago[] }>>;

  estadoPedido(token: string): Promise<Resultado<EstadoPublicoPedido>>;   // sin nombre, celular ni dirección completa

  iniciarPago(entrada: { token: string; proveedor: 'yappy' | 'tilopay' | 'paypal';
    tipo: 'abono' | 'total'; montoCents?: number; idempotencia: string })
    : Promise<Resultado<{ pagoId: string; redirectUrl?: string; datosBoton?: Record<string, unknown> }>>;

  avisoPasarela(proveedor: string, solicitud: { cuerpo: string; cabeceras: Record<string, string>; ip: string })
    : Promise<Resultado<{ http: number }>>;                 // la web responde a la pasarela con ese código

  vueltaPasarela(proveedor: string, query: Record<string, string>)
    : Promise<Resultado<{ token: string; estado: 'confirmando' | 'aprobado' | 'rechazado' }>>;

  buscarDireccion(q: string): Promise<Resultado<{ etiqueta: string; lat: number; lng: number }[]>>;
  direccionInversa(lat: number, lng: number): Promise<Resultado<{ etiqueta: string }>>;

  cuenta: {                                                  // Mi cuenta (F7)
    pedirCodigo(celular: string): Promise<Resultado<{ enviado: true }>>;
    entrar(celular: string, codigo: string): Promise<Resultado<{ sesion: string; venceEn: number }>>;
    misPedidos(sesion: string): Promise<Resultado<EstadoPublicoPedido[]>>;
    repetirPedido(sesion: string, numero: string, idempotencia: string): Promise<Resultado<{ token: string }>>;
  };
}
```

Contenido de la web (`content.json`): cada variante de `products[].variants[]` gana `codigo` y
pierde `price`; `priceFrom` se calcula en el navegador con el catálogo. Una prueba de la web falla si:

- aparece `price` o `priceFrom` en `content.json`, o un monto con `$` en `netlify/functions` o en
  `worker/` fuera de los formateadores;
- una variante no tiene `codigo`, o su código no existe en la copia de respaldo del catálogo
  (`src/data/catalogo.respaldo.json`, que el build descarga de `/api/catalogo`).

## 3. `SistemaCRM`: lo que el CRM puede pedir

```ts
interface Actor { tipo: 'bot' | 'duena' | 'usuario'; id: string; canal: string; conversacionRef?: string }

interface SistemaCRM {
  // Catálogo para catalogQuery (reemplaza CatalogRepo.search/listActive del CRM)
  buscarCatalogo(q: string, limite?: number): Promise<Resultado<VariantePublica[]>>;
  listarCatalogo(): Promise<Resultado<VariantePublica[]>>;

  // Solo para la consola de la dueña (actor.tipo === 'duena')
  stockDetallado(actor: Actor, codigo?: string): Promise<Resultado<{ codigo: string; nombre: string;
    porBodega: { bodega: string; fisico: number; reservado: number }[] }[]>>;
  movimientos(actor: Actor, codigo?: string, n?: number): Promise<Resultado<MovimientoVista[]>>;
  registrarVenta(actor: Actor, e: { idempotencia: string; lineas: { codigo: string; cantidad: number;
    bodega?: string }[]; pagado: 'todo' | 'abono' | 'nada'; metodo?: string; clienteRef?: IdentidadRef })
    : Promise<Resultado<{ numero: string; deshacerId: string; etiquetas: Record<string, Disponibilidad> }>>;
  registrarDevolucion(actor: Actor, e: { idempotencia: string; numero?: string; codigo: string;
    cantidad: number; vuelveAlInventario: boolean; motivo: string }): Promise<Resultado<{ deshacerId: string }>>;
  ajustarStock(actor: Actor, e: { idempotencia: string; codigo: string; bodega: string;
    modo: 'sumar' | 'restar' | 'fijar'; cantidad: number; motivo: string }): Promise<Resultado<{ deshacerId: string }>>;
  deshacer(actor: Actor, deshacerId: string): Promise<Resultado<{ hecho: true }>>;

  // Clientes y pedidos desde el chat
  clientePorIdentidad(r: { canal: string; idExterno: string; nombre?: string; celular?: string })
    : Promise<Resultado<{ clienteId: string; nuevo: boolean; fusionPropuesta?: string }>>;
  pedidosDeCliente(r: IdentidadRef): Promise<Resultado<EstadoPublicoPedido[]>>;   // «¿dónde está mi pedido?»
  cotizarEnvio(textoZona: string): Promise<Resultado<{ zona: string; tarifaCents: number | null;
    requierePagoTotal: boolean } | { zona: null; sugerencias: string[] }>>;
  proponerPedido(actor: Actor, e: { idempotencia: string; clienteRef: IdentidadRef;
    lineas: { codigo: string; cantidad: number }[]; zonaTexto?: string })
    : Promise<Resultado<{ numero: string; token: string; totalCents: number }>>;   // queda por_abonar
  registrarComprobante(actor: Actor, e: { idempotencia: string; clienteRef: IdentidadRef;
    numero?: string; archivo: { mime: string; base64: string } })
    : Promise<Resultado<{ propuestaId: string; numeroSugerido: string | null }>>;
  confirmarAbono(actor: Actor, e: { propuestaId: string; numero: string; montoCents: number; metodo: string })
    : Promise<Resultado<{ estado: string; estadoPago: string }>>;                   // solo la dueña

  // Asistente (F6): las herramientas viven en el sistema
  herramientasAsistente(actor: Actor): Promise<Resultado<DefinicionHerramienta[]>>;
  ejecutarHerramienta(actor: Actor, e: { nombre: string; argumentos: unknown; conversacion: string;
    conAdjuntos: boolean; textoExterno: boolean }): Promise<Resultado<ResultadoHerramienta>>;
  confirmarAccion(actor: Actor, accionId: string, decision: 'permitir' | 'rechazar')
    : Promise<Resultado<ResultadoHerramienta>>;
  registrarUsoIA(actor: Actor, uso: { modelo: string; entrada: number; salida: number;
    cacheLeida: number; cacheEscrita: number }): Promise<Resultado<{ dentroDelTope: boolean }>>;
}
```

**Identidad de la dueña.** El CRM ya sabe quién es la dueña (`OWNER_TELEGRAM_CHAT_ID` o el vínculo
del panel). Pasa `actor.tipo = 'duena'` con su `chat_id`, y el sistema lo cruza con
`usuarios.telegram_chat_id`. Un actor `bot` nunca puede llamar a los métodos de la dueña: el sistema
lo rechaza con `codigo: 'no_autorizado'`.

## 4. Eventos de cola

Sobre de todo mensaje:

```ts
interface Evento<T> {
  id: string;            // ULID; el consumidor lo guarda en eventos_recibidos y no lo repite
  tipo: string;
  version: 1;
  ocurridoEn: number;
  datos: T;
}
```

### `bc-avisos` (lo consume el CRM)

| Tipo | Datos | Qué hace el CRM |
|---|---|---|
| `pedido.creado` | numero, token, origen, clienteRef, totalCents | Aviso a la dueña por Telegram |
| `pago.confirmado` | numero, token, montoCents, metodo, estadoPago, clienteRef | Aviso a la dueña; a la clienta, «recibimos su pago» |
| `pedido.agendado` | numero, token, ventana, clienteRef | A la clienta: pedido agendado |
| `pedido.en_ruta` | numero, token, motorizadoNombre, clienteRef | A la clienta: va en camino, con enlace de seguimiento |
| `pedido.entregado` | numero, clienteRef, codigos | Marca «compró» en `compras` del CRM (descanso de 15 días y recompra) |
| `pedido.cancelado` | numero, motivo, clienteRef | Aviso a la dueña |
| `inventario.bajo` | codigo, etiqueta, bodega | Aviso a la dueña |
| `sistema.alerta` | nivel, mensaje | Aviso a la dueña o al equipo técnico |

**Por qué canal sale cada aviso a la clienta.** El CRM decide, con esta regla:

1. Si la clienta escribió en las últimas 24 h por un canal, el aviso sale por ese canal como mensaje
   normal.
2. Si no, y tiene celular: plantilla aprobada de la Cloud API de WhatsApp, categoría utilidad
   (`pedido_agendado`, `pedido_en_camino`, `pedido_entregado`, `pago_recibido`), dentro del tope
   `WA_DAILY_TEMPLATE_CAP`.
3. Nunca un mensaje saliente nuevo por el puente QR fuera de una conversación abierta.
4. Si no hay forma de avisar, queda anotado en el pedido y la dueña lo ve en el panel.

### `bc-tareas` (lo consume el sistema)

| Tipo | Qué hace |
|---|---|
| `meta.purchase` | Envía el evento `Purchase` a la Conversions API (con `event_id` = id del pago, datos con hash SHA-256) |
| `pago.consultar` | Consulta a la pasarela un pago que quedó en «confirmando» |
| `reporte.excel` | Arma un Excel o un ZIP pesado y lo deja en R2 |
| `correo.enviar` | Correo transaccional, si se activa |

Configuración: `max_retries = 5`, `max_batch_size = 10`, cola de mensajes muertos por cola. Lo que
cae en la cola muerta genera `sistema.alerta`.

## 5. Idempotencia y errores

```ts
type Resultado<T> =
  | { ok: true; datos: T }
  | { ok: false; codigo: CodigoError; mensaje: string; detalle?: Record<string, unknown> };

type CodigoError =
  | 'entrada_invalida' | 'no_encontrado' | 'no_autorizado' | 'sin_stock' | 'transicion_invalida'
  | 'conflicto_version' | 'monto_no_coincide' | 'pasarela_no_disponible' | 'periodo_cerrado'
  | 'repetido' | 'limite' | 'interno';
```

- `mensaje` está en español y sirve para mostrarlo o para que el modelo corrija (como `BrianError`).
- **Idempotencia.** Todo método que escribe recibe `idempotencia` (UUID del que llama). Se guarda en
  `idempotencia` con la huella de la entrada y la respuesta. Misma clave y misma entrada → misma
  respuesta, sin escribir de nuevo. Misma clave con otra entrada → `repetido`. Vence a las 48 h.
- **Botones de Telegram**: la clave es el id de la acción propuesta, así dos toques no venden dos
  veces.
- **Webhooks**: idempotentes por `(proveedor, evento_id)` en `eventos_pasarela`.
- **Colas**: idempotentes por `Evento.id` en `eventos_recibidos` (en cada consumidor).

## 6. Versionado y pruebas de contrato

- `sistema/src/contrato/` define los esquemas zod y exporta `HUELLA_CONTRATO` (SHA-256 del texto de
  los esquemas, generada por un script).
- El CRM tiene una copia en `src/sistema/contrato.ts` con la misma huella. Una prueba en cada repo
  falla si la huella no coincide con la del otro (el CI del CRM descarga el archivo del sistema de
  `main` de este repo).
- **Cambios compatibles hacia atrás**: solo se agregan campos opcionales o métodos nuevos. Quitar o
  cambiar algo exige versión nueva del método (`registrarVentaV2`) y retirar la vieja cuando el CRM
  ya no la use.
- **Orden de despliegue** cuando cambia el contrato: sistema → CRM.
- Fixtures compartidas (`contrato/fixtures/*.json`) se prueban en los dos lados.

## 7. Cambios que pide el CRM

Todo como extensión, para no chocar con la plantilla Juancito Ads si sigue recibiendo
actualizaciones (pregunta abierta en [10](10-riesgos-y-decisiones.md)).

| Archivo nuevo o cambio en `CRM-Baby-Caleb` | Qué hace |
|---|---|
| `wrangler.toml`: `[[services]] SISTEMA` con `entrypoint = "SistemaCRM"` | Binding al sistema |
| `wrangler.toml`: `[[queues.consumers]] bc-avisos` | Consumidor de avisos |
| `src/sistema/cliente.ts` + `contrato.ts` | Cliente tipado del RPC y copia del contrato con huella |
| `src/catalog/fuente.ts` | Interfaz `FuenteCatalogo` con `CatalogoLocal` (D1 del CRM) y `CatalogoSistema` (RPC), elegida por la variable `CATALOGO_FUENTE` |
| `src/tools/catalogQuery.ts`, `src/owner/inventario.ts`, `src/admin/views/catalogo.ts` | Usan `FuenteCatalogo` en vez de `new CatalogRepo(new Db(env.DB))` |
| `src/tools/cotizarEnvio.ts` | Pregunta al sistema cuando `CATALOGO_FUENTE=sistema`; si no, lee `member/zonas-envio.ts` |
| `src/channels/web.ts` + `export class CanalWeb extends WorkerEntrypoint` | Canal web: misma KB, mismo revisor, trato de usted |
| `src/eventos/consumidor.ts` + `queue()` en `src/index.ts` | Avisos a la clienta y a la dueña |
| `src/owner/cerebro.ts` | Suma las herramientas del sistema a la consola (F6) |
| `scripts/auditar-verdad.ts` | Audita el catálogo del sistema cuando `CATALOGO_FUENTE=sistema` |
| `test/babycaleb/` | Pruebas con las dos fuentes de catálogo y del canal web |
