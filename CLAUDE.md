# Baby Caleb — flujo de subida de medios

La clienta sube fotos/logos/banners nuevos a `media-inbox/` (ver
`media-inbox/README.md`). Esa carpeta es un buzón de entrada permanente:

- **Nunca la borres, renombres ni repurpuses**, aunque esté vacía. Debe seguir
  existiendo siempre, exclusivamente para recibir subidas.
- Cuando encuentres archivos sueltos ahí, es contenido pendiente de organizar.
  Recórtalos/optimízalos y colócalos en `public/img/` siguiendo la convención
  de nombres existente (`logo-*`, `producto-*`, `promo-*`/`banner-*`,
  `hero-*`, `tip-*`) — mira `scripts/process-images.mjs` como referencia de
  cómo se recortaron las imágenes originales.
- Una vez organizado un archivo, quítalo de `media-inbox/` para dejarla lista
  para la próxima subida. Si el destino o nombre no está claro por el pedido
  de la clienta, pregunta antes de mover nada.
