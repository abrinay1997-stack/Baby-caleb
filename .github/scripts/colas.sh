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
# Crear una cola es idempotente desde fuera: si ya existe, wrangler se queja y
# seguimos. Lo que NO se tolera es cualquier otro error, porque entonces el
# despliegue de después fallaría igual y más lejos de la causa.
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

for cola in "${colas[@]}"; do
  salida="$(npx wrangler queues create "$cola" 2>&1)" && {
    echo "creada: $cola"
    continue
  }

  # «ya existe» no es un fallo: es el estado que queremos.
  if grep -qiE "already exists|ya existe|queue with this name" <<<"$salida"; then
    echo "ya estaba: $cola"
    continue
  fi

  echo "::error::no se pudo crear la cola $cola"
  echo "$salida"
  exit 1
done

echo "las ${#colas[@]} colas de $entorno están listas"
