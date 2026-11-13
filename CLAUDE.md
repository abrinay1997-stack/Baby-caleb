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
catorce reglas, cada una ahí porque ya mordió en este repositorio — dos de ellas
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

- **El panel se usa desde el teléfono.** Antes de tocar `sistema/panel/src/`,
  lea `docs/design-system.md`: 44 px en lo táctil, 16 px en los campos, piso de
  12 px, nada de `100vh` ni de `min-width` en píxeles. Lo comprueba
  `npm run panel:auditar`, y una pantalla nueva hay que añadirla a **las dos**
  listas (el auditor y el servidor de muestra) o no se mide.
- **Todo lleva MCP, y en el mismo cambio.** Un ajuste nuevo, un campo nuevo o
  una capacidad nueva no están terminados hasta que se pueden usar también por
  MCP. No es una fase posterior ni un «ya lo añadimos después»: se construye en
  paralelo, en el mismo trabajo, o queda a medias. Lo que hoy no tiene MCP
  también tiene que tenerlo. Y **todo plan futuro lo incluye desde el
  principio**: un plan sin MCP está incompleto y hay que devolverlo.
  El porqué está en `docs/TRAMPAS.md` §13.

- **Secretos fuera del chat; datos de clientas fuera de GitHub.**
- El CRM (`juanarrietabusiness-pixel/CRM-Baby-Caleb`) es otro repo: los cambios
  allá siguen sus propias reglas (`CLAUDE.md` de ese repo).
