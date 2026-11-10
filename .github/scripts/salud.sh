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
# No lleva ningún dato del negocio y por eso el código no le pide token.
#
# Si queda dentro, lo que llega aquí NO es un 403: es un 302 al dominio del
# equipo (…cloudflareaccess.com) pidiendo iniciar sesión, porque Access actúa
# en el borde ANTES de que el Worker corra. Y eso no se arregla esperando: es
# configuración de la cuenta, así que se corta en el primer intento en vez de
# gastar diez. Se sale con Bypass en una aplicación de Access para esa ruta
# exacta (Access → Aplicaciones → la del host + /salud → Bypass/Everyone).

set -euo pipefail

base="${1:?falta la url base}"
esperado="${2:?falta el sha esperado}"
url="${base%/}/salud"

# El borde tarda unos segundos en servir la versión nueva.
intentos=10
espera=3

for i in $(seq 1 "$intentos"); do
  codigo="$(curl -fsS -o cuerpo.json -D cabeceras.txt -w '%{http_code}' "$url" 2>/dev/null || echo "000")"

  # Access responde en el borde, antes del Worker: un 30x al dominio del equipo
  # es configuración mal puesta, no propagación. Reintentar no la arregla.
  if [ "$codigo" = "301" ] || [ "$codigo" = "302" ] || [ "$codigo" = "303" ]; then
    destino="$(tr -d '\r' < cabeceras.txt | awk 'tolower($1) == "location:" { print $2; exit }')"
    case "$destino" in
      *cloudflareaccess.com*)
        echo "✗ $url está DENTRO de la aplicación de Cloudflare Access."
        echo "  Access redirige a iniciar sesión ($codigo) antes de que el Worker corra,"
        echo "  así que ni el despliegue ni ningún monitor pueden leer la salud."
        echo "  Se arregla en Zero Trust → Access → Aplicaciones: una aplicación para"
        echo "  esta ruta exacta con una política Bypass / Include / Everyone."
        echo "  Ruta: ${url}"
        exit 1
        ;;
    esac
  fi

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
      echo "  Un 403 aquí viene del Worker, no de Access (Access manda un 302)."
      echo "  Mire el cuerpo: /salud no pide token, así que algo más lo está negando."
    fi
  fi

  [ "$i" -lt "$intentos" ] && sleep "$espera"
done

echo "✗ $url no llegó a contestar lo esperado tras $intentos intentos"
echo "  último cuerpo:"
cat cuerpo.json 2>/dev/null || echo "  (vacío)"
exit 1
