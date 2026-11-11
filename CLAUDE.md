# Baby Caleb — flujo de subida de medios

La clienta sube fotos/logos/banners nuevos a `📤SUBIR-CONTENIDO/` (ver
`📤SUBIR-CONTENIDO/README.md`). Esa carpeta es un buzón de entrada permanente:

- **Nunca la borres, renombres ni repurpuses**, aunque esté vacía. Debe seguir
  existiendo siempre, exclusivamente para recibir subidas.
- Cuando encuentres archivos sueltos ahí, es contenido pendiente de organizar.
  Recórtalos/optimízalos y colócalos en `public/img/` siguiendo la convención
  de nombres existente (`logo-*`, `producto-*`, `promo-*`/`banner-*`,
  `hero-*`, `tip-*`) — mira `scripts/process-images.mjs` como referencia de
  cómo se recortaron las imágenes originales.
- Una vez organizado un archivo, quítalo de `📤SUBIR-CONTENIDO/` para dejarla
  lista para la próxima subida. Si el destino o nombre no está claro por el
  pedido de la clienta, pregunta antes de mover nada.

# Sistema Baby Caleb (en construcción)

Este repo es también la casa del sistema propio de Baby Caleb en Cloudflare: la
web se queda en la raíz y el sistema (pedidos, inventario, pagos, entregas,
contabilidad, asistente) nace en `sistema/`. Antes de programar cualquier parte
del sistema, lee `docs/plan/README.md` y el documento de la parte que toques.

**Y lee `docs/TRAMPAS.md` ANTES de escribir, no después de romper algo.** Son
once reglas, cada una ahí porque ya mordió en este repositorio — una de ellas
tres veces. Las lecciones ya estaban escritas, pero cada una vivía en el
archivo que protege, así que solo se leían estando ya dentro: tarde. Ese
archivo es el índice que faltaba.

- **Un dato, un solo dueño:** precio, existencias y costo viven solo en la D1
  del sistema. Nunca escribas un precio en `content.json` ni en el código.
- **Ninguna cifra a ojo:** montos, comisiones, impuestos y puntos salen de la
  dueña o de una fuente citada; lo que falta queda `PENDIENTE`.
- **El navegador no decide un pago** y los libros (inventario, asientos,
  bitácoras) no se editan ni se borran.
- **El diseño de la web no se toca** sin pedido explícito: lo nuevo usa los
  bloques y los tokens que ya existen (`brand.json`, `src/styles/`).
- **Secretos fuera del chat; datos de clientas fuera de GitHub.**
- El CRM (`juanarrietabusiness-pixel/CRM-Baby-Caleb`) es otro repo: los cambios
  allá siguen sus propias reglas (`CLAUDE.md` de ese repo).
