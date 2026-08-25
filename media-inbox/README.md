# ⬆️ WEB BYSLOGISTICS | 🗂️ MEDIA — Carpeta de subida de contenido

Esta carpeta (`media-inbox/`) es el **único** lugar donde se sube contenido nuevo:
fotos de producto, logos, banners, imágenes para el blog, lo que sea.

## Para la clienta

1. Sube aquí el archivo tal cual lo tengas (sin organizarlo, sin renombrarlo).
2. Dile a la IA qué quieres hacer con él, por ejemplo:
   - "Subí el logo nuevo, reemplázalo en toda la página."
   - "Estas 3 fotos son del paquete talla L, agrégalas al catálogo."
   - "Esta imagen es para el banner principal del inicio."
3. La IA se encarga de recortarlo, optimizarlo y colocarlo en su lugar correcto
   dentro del sitio.

No hace falta crear subcarpetas ni ordenar nada — para eso está la IA.

## Reglas fijas (no cambian)

- Esta carpeta **nunca se borra ni se renombra**. Es infraestructura permanente
  del proyecto, exclusiva para subir contenido.
- Esta carpeta **no es el destino final** de ninguna imagen — es solo el buzón
  de entrada. El destino final siempre es `public/img/`.
- Una vez que la IA organiza un archivo subido aquí (lo mueve/procesa a su
  carpeta final en `public/img/`), lo retira de `media-inbox/` para que quede
  limpia y lista para la próxima subida. El archivo `.gitkeep` se queda para
  que la carpeta exista siempre en el repositorio, incluso vacía.

## Para la IA (Claude u otra)

- Los archivos que aparezcan sueltos en `media-inbox/` (fuera de este README
  y de `.gitkeep`) son subidas pendientes de organizar.
- Destino y convención de nombres en `public/img/`:
  - `logo-*` → logos de marca
  - `producto-*` → fotos de producto/catálogo
  - `promo-*` / `banner-*` → banners y promociones
  - `hero-*` → imágenes del hero/inicio
  - `tip-*` → imágenes de blog/tips
- Si el pedido de la clienta no deja claro el destino o el nombre, pregúntale
  antes de mover el archivo.
- Nunca borres, renombres ni repurpuses la carpeta `media-inbox/` en sí misma.
