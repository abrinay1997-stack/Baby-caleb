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
