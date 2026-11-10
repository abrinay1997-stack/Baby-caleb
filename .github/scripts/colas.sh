#!/usr/bin/env bash
# Crea las colas que `wrangler.jsonc` declara, si no están.
#
# POR QUÉ ESTO EXISTE
#
# `wrangler deploy` NO crea las colas: si falta una, se niega a desplegar y
# dice cuál. Eso está bien —mejor que fallar que publicar un Worker que se cae
# al primer mensaje—, pero significa que alguien tiene que crearlas, y ese
# «alguien» a mano es exactamente lo que se olvida. Pasó: el primer despliegue
# a staging murió en «Queue bc-tareas-staging-muertos does not exist».
#
# CÓMO SE SABE QUE UNA COLA YA ESTÁ
#
# NO leyendo el mensaje de error. La primera versión de este guion toleraba
# «already exists»... y Cloudflare dice «is already taken». Resultado: el
# segundo despliegue falló por una cola que SÍ existía. Adivinar la redacción
# de un error ajeno es apostar a que nadie la cambie ni la traduzca.
#
# Así que: si crear falla, se PREGUNTA qué colas hay. Si la cola está en la
# lista, ya estaba y seguimos; si no está, el fallo es de verdad.
#
#   .github/scripts/colas.sh staging|production
set -euo pipefail

entorno="${1:?falta el entorno (staging|production)}"
sufijo=""
[ "$entorno" = "staging" ] && sufijo="-staging"

colas=(
  "bc-avisos${sufijo}"
  "bc-avisos${sufijo}-muertos"
  "bc-tareas${sufijo}"
  "bc-tareas${sufijo}-muertos"
)

existe() {
  # `queues list` imprime una tabla. Se busca el nombre como palabra completa
  # para que «bc-avisos» no case con «bc-avisos-muertos».
  npx wrangler queues list 2>/dev/null | grep -qE "(^|[^a-z0-9-])$1([^a-z0-9-]|$)"
}

for cola in "${colas[@]}"; do
  if salida="$(npx wrangler queues create "$cola" 2>&1)"; then
    echo "creada: $cola"
    continue
  fi

  if existe "$cola"; then
    echo "ya estaba: $cola"
    continue
  fi

  echo "::error::no se pudo crear la cola $cola y tampoco existe"
  echo "$salida"
  exit 1
done

echo "las ${#colas[@]} colas de $entorno están listas"
