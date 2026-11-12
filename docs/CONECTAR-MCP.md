# Conectar una herramienta al sistema (MCP)

El sistema de Baby Caleb habla **MCP**, que es el idioma con el que un
asistente de IA en su computadora puede consultar el negocio sin que usted
abra el panel. Preguntarle «¿cuánto queda de la talla M?» a su asistente y que
conteste con el número de verdad, sacado de la base.

Es la misma puerta que el chat de Caleb dentro del panel: **las mismas
herramientas, los mismos permisos y la misma bitácora.** Conectar una
herramienta no le da a nadie permisos que no tuviera.

## 1. Cree su llave

En el panel: **Menú → Configuración → Llaves de conexión → Crear una llave**.

Póngale un nombre que le diga a usted de cuál se trata («Mi computadora», «La
portátil del trabajo»). Cuando tenga tres, ese nombre es lo único que le dirá
cuál sobra.

**La llave se enseña una sola vez.** El sistema guarda solo una huella, así que
ni él mismo puede volver a enseñársela. Si la pierde, la revoca y crea otra —
eso es más barato que poder recuperarla, porque un sistema que puede
recuperarla es un sistema que alguien más también puede.

## 2. Póngala en su herramienta

La dirección del servidor es:

```
https://ruta.babycaleb.com/mcp
```

Y la llave va como una cabecera de autorización:

```
Authorization: Bearer bcmcp_...
```

En un cliente que se configura con un archivo JSON, se ve así:

```json
{
  "mcpServers": {
    "baby-caleb": {
      "type": "http",
      "url": "https://ruta.babycaleb.com/mcp",
      "headers": {
        "Authorization": "Bearer bcmcp_PEGUE_AQUI_SU_LLAVE"
      }
    }
  }
}
```

Cada programa guarda eso en un sitio distinto. Si el suyo pide «servidor MCP
por HTTP», es esa dirección y esa cabecera.

## 3. Qué puede hacer, y qué no

**Puede consultar** lo que su rol le deje ver: el catálogo, las existencias,
los movimientos. Si usted es asistente y no dueña, las herramientas de cambiar
precios ni siquiera aparecen en la lista — una herramienta que no se enseña es
una que no se puede pedir por equivocación.

**No puede cambiar precios, mover existencias ni tocar dinero por su cuenta.**
Si se lo pide, el sistema deja la acción esperando y le contesta que **no se
hizo**, con el aviso de que hay que permitirla en el panel. Eso es a propósito:
el punto de la confirmación es que la mire una persona, y si la propia
herramienta pudiera confirmarse a sí misma no serviría de nada.

**No salen datos de las clientas.** Ni nombres, ni teléfonos, ni correos, ni
direcciones. Una clienta es una referencia (`C-0042`). Al otro lado de esa
conexión hay un modelo de otra empresa, y las clientas no acordaron nada con
ella.

## 4. Si algo no funciona

| Lo que ve | Qué pasa |
|---|---|
| `401` | La llave está mal escrita, fue revocada, o la persona está dada de baja |
| `405` | Su herramienta está intentando abrir un canal de streaming; este servidor contesta de una vez, por POST |
| «no se hizo» | Es correcto: esa acción necesita que alguien la permita en el panel |

Para dejar de usar una llave: **Llaves de conexión → Revocar**. Tiene efecto en
la siguiente petición, sin esperar nada. Revocar no borra el registro de que
existió, porque hay que poder reconstruir por dónde entró cada cosa.

---

## Para quien programa

El servidor vive en `sistema/src/mcp/`. Habla JSON-RPC 2.0 por POST, con los
métodos `initialize`, `ping`, `tools/list` y `tools/call`, y negocia las
versiones de protocolo `2025-11-25`, `2025-06-18` y `2025-03-26`.

No usa el SDK oficial: ese da por hecho un servidor de Node con sockets, y
aquí vive un Worker. Las formas de los mensajes se leyeron de los esquemas del
paquete `@modelcontextprotocol/sdk`, no de la memoria.

**La regla que gobierna esto está en `CLAUDE.md` y en `TRAMPAS.md` §13: todo
lleva MCP, y en el mismo cambio.** Lo comprueba `sistema/scripts/sin-mcp.mjs`,
que corre en CI: una ruta nueva del panel sin decidir si MCP la cubre pone la
ejecución en rojo.

```
node sistema/scripts/sin-mcp.mjs --lista
```
