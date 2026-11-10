#!/usr/bin/env bash
# Comprueba que lo que quedó desplegado es lo que se quiso desplegar.
#
#   salud.sh <url-base> <sha-esperado>
#
# No basta con que `wrangler deploy` no falle: un despliegue puede salir bien y
# dejar vivo el código anterior (caché del borde, una versión que no se
# promovió, el entorno equivocado). Lo único que lo demuestra es que /salud
# conteste con la versión que se acaba de publicar.
#
# También exige que haya una migración aplicada: si `migracion` viene en null,
# el Worker nuevo está hablando con una base sin esquema, y es mejor saberlo
# ahora que cuando entre el primer pedido.
#
# La ruta /salud tiene que quedar FUERA de la aplicación de Cloudflare Access.
# No lleva ningún dato del negocio y por eso el código no le pide token; si
# queda dentro, aquí llega un 403.

set -euo pipefail

base="${1:?falta la url base}"
esperado="${2:?falta el sha esperado}"
url="${base%/}/salud"

# El borde tarda unos segundos en servir la versión nueva.
intentos=10
espera=3

for i in $(seq 1 "$intentos"); do
  codigo="$(curl -fsS -o cuerpo.json -w '%{http_code}' "$url" 2>/dev/null || echo "000")"

  if [ "$codigo" = "200" ]; then
    version="$(jq -r '.version // ""' cuerpo.json)"
    migracion="$(jq -r '.migracion // ""' cuerpo.json)"
    sano="$(jq -r '.sano // false' cuerpo.json)"

    if [ "$version" = "$esperado" ] && [ "$sano" = "true" ] && [ -n "$migracion" ]; then
      echo "✓ $url responde sano"
      echo "  versión:   $version"
      echo "  migración: $migracion"
      exit 0
    fi

    echo "intento $i/$intentos: version='$version' (se esperaba '$esperado') sano='$sano' migracion='$migracion'"
  else
    echo "intento $i/$intentos: HTTP $codigo"
    if [ "$codigo" = "403" ]; then
      echo "  403 suele significar que /salud quedó DENTRO de la aplicación de Access."
      echo "  Hay que excluir esa ruta: no lleva datos del negocio."
    fi
  fi

  [ "$i" -lt "$intentos" ] && sleep "$espera"
done

echo "✗ $url no llegó a contestar lo esperado tras $intentos intentos"
echo "  último cuerpo:"
cat cuerpo.json 2>/dev/null || echo "  (vacío)"
exit 1
