# Instrucción para crear la puerta de Access con Claude en Chrome

Cada superficie del sistema vive detrás de **Cloudflare Access**: una puerta
que pide el correo antes de dejar ver nada. Access no se configura desde el
repositorio —vive en Zero Trust— así que este paso lo hace una persona, o un
agente en su navegador.

**Hazlo DESPUÉS de que el despliegue haya creado el subdominio.** Antes no hay
a qué ponerle puerta.

## El bloque para pegar

Cambia `panel.babycaleb.com` por el host que toque y el nombre de la
aplicación. El resto se queda igual.

```
Necesito que crees una aplicación de Cloudflare Access. Ya tengo la sesión
abierta en esta pestaña.

ANTES QUE NADA, LAS REGLAS. Esta es la cuenta real de Cloudflare del negocio:

- Crea UNA aplicación nueva. No toques ninguna de las que ya existen.
- No borres, no archives y no edites nada que no hayas creado tú ahora.
- No cambies ajustes de la cuenta, ni de DNS, ni de los Workers.
- Si algo no coincide con lo que te digo más abajo, PARA y cuéntamelo en vez
  de improvisar.

LO QUE HAY QUE CREAR

Ve a Zero Trust › Access › Applications › Add an application › Self-hosted.

  Application name .... Panel Baby Caleb
  Session duration .... 24 hours
  Subdomain ........... panel
  Domain .............. babycaleb.com
  Path ................ déjalo VACÍO (la puerta cubre el host entero)

Sigue a la política de acceso:

  Policy name ......... Dueña y Juan
  Action .............. Allow
  Include ............. Emails  →  juandavidarrieta99@gmail.com

Deja todo lo demás como viene por defecto. No actives Service Auth, ni
WARP, ni bypass, ni ninguna regla de Require o Exclude.

Guarda la aplicación.

LO QUE NECESITO QUE ME TRAIGAS

Dos datos, y ninguno es secreto (son identificadores públicos; lo secreto es
la llave con la que Cloudflare firma, y esa no sale de Cloudflare):

1. El **Application Audience (AUD) Tag** de la aplicación que acabas de crear.
   Está en su pestaña Overview. Son 64 caracteres hexadecimales.

2. El **dominio del equipo**, en Zero Trust › Settings › Custom Pages (o en
   Settings › General, según la versión). Tiene la forma
   `algo-algo-1234.cloudflareaccess.com`.

   OJO CON ESTE: cópiamelo TAL CUAL lo veas en pantalla, aunque no lleve
   `https://` delante. No se lo pongas tú. Ya nos costó una vez: el panel lo
   enseña sin protocolo y el código lo valida con él, y el síntoma de pegarlo
   mal es un 403 en absolutamente todo — idéntico a no tener Access, sin
   ninguna pista de que la configuración es lo que está mal.

AL TERMINAR, dime:
- Los dos datos de arriba.
- Si la aplicación quedó creada y con su política, o dónde te atascaste.
- Si viste algo que no cuadre con estas instrucciones.

No configures nada más. No pruebes a entrar al panel todavía: hasta que yo no
ponga esos dos datos en el sistema y lo vuelva a desplegar, va a rechazar a
todo el mundo (está hecho así a propósito: sin configuración de Access, se
cierra en vez de abrirse).
```

## Después

Pásame los dos datos. Yo los pongo en `sistema/wrangler.jsonc` (en las `vars`
del entorno que toque), vuelvo a desplegar y ahí entras.

## Por qué el panel rechaza a todo el mundo mientras tanto

`revisarPeticion` llama a `configAccess`, y si falta el dominio del equipo o el
AUD —o tienen mala forma— devuelve `null` y la petición se rechaza con el
motivo «sin configurar». Falla **cerrado**.

Y producción lleva `workers_dev: false` y `preview_urls: false`: no hay puerta
trasera. La única entrada es el subdominio, por Access. Es a propósito.

---

# Instrucción para añadir correos a una puerta que ya existe

La de arriba crea la puerta. Esta **añade gente a una que ya está creada**, que
es lo que hace falta cada vez que entra alguien nuevo al negocio.

Son dos cerrojos y hacen falta los dos:

| | Qué hace | Dónde se toca |
|---|---|---|
| Política de Access | La puerta de la calle. Sin esto Cloudflare ni la deja llegar. | Zero Trust (esta instrucción) |
| Tabla `usuarios` | Dice quién es y qué puede tocar. | La D1 del sistema |

Si solo se hace uno de los dos, la persona ve un error sin explicación:
con Access pero sin fila, pasa la puerta y el panel la rechaza; con fila pero
sin Access, no llega ni a ver el panel.

## El bloque para pegar

```
Necesito que añadas unos correos a una aplicación de Cloudflare Access que YA
EXISTE. Ya tengo la sesión abierta en esta pestaña.

ANTES QUE NADA, LAS REGLAS. Esta es la cuenta real de Cloudflare del negocio:

- Solo vas a EDITAR la política de UNA aplicación que ya existe.
- No crees aplicaciones nuevas. No borres ni archives ninguna.
- No toques DNS, ni Workers, ni ajustes de la cuenta.
- No quites ningún correo que ya esté en la lista. Solo añades.
- Si algo no coincide con lo que te digo más abajo, PARA y cuéntamelo en vez
  de improvisar.

LO QUE HAY QUE HACER

Ve a Zero Trust › Access › Applications y abre la aplicación que se llama
«Panel Baby Caleb» (la del host panel.babycaleb.com).

Entra a su pestaña de políticas (Policies) y abre la política que ya tiene.

PRIMERO, COMPRUEBA ALGO IMPORTANTE

Mira la regla de inclusión (Include). Tiene que decir «Emails» con una lista
de correos.

Si dice «Everyone» o «Todos los usuarios autenticados», ESO ESTÁ MAL y es un
agujero: significa que cualquiera con un correo de Google puede entrar al
panel del negocio. Cámbialo a «Emails» y deja SOLO los cuatro correos de
abajo. Avísame de que lo encontraste así.

LOS CUATRO CORREOS QUE TIENEN QUE QUEDAR EN LA LISTA

  yulilkajudith@gmail.com
  juanarrietabusiness@gmail.com
  juandavidarrieta99@gmail.com
  abrinay1997@gmail.com

El selector es «Emails» (correos sueltos), NO «Email domain»: con el dominio
entrarían todos los de @gmail.com, que es todo el mundo.

Guarda la política.

CUANDO TERMINES, CUÉNTAME

  1. Cómo estaba la regla de inclusión ANTES (¿«Emails» o «Everyone»?).
  2. La lista completa de correos que quedó, tal como se ve en pantalla.
  3. Si la aplicación tiene más de una política, dime cuántas y cómo se
     llaman — no toques las demás, solo dímelo.
  4. Cualquier aviso o error que te haya salido al guardar.

No me pegues tokens, claves ni secretos en el chat. Nada de lo que te pido
aquí lo es, así que si algo te parece un secreto, no lo copies: descríbemelo.
```

## Después

El correo nuevo entra en la siguiente petición. No hay que redesplegar nada:
el Worker cruza el correo firmado con `usuarios` en cada petición, así que
tanto dar de alta como dar de baja tienen efecto inmediato.

Lo que SÍ hay que hacer es la otra mitad: la fila en `usuarios`. Sin ella,
Access deja pasar a alguien que el panel no conoce.
