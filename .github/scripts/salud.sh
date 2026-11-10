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
# gastar diez.
#
# Cómo sacarla de ahí, según con qué esté protegido el Worker:
#
#  - **Por hostname propio** (panel.babycaleb.com): una aplicación de Access
#    para esa ruta exacta con una política Bypass / Include / Everyone. Es el
#    camino documentado para rutas de salud.
#  - **Por Worker** (lo que se puede hacer en workers.dev, porque ese dominio
#    no es nuestro): NO hay recorte por ruta — Access cubre el Worker entero.
#    Ahí la salida es un TOKEN DE SERVICIO: una política Service Auth en la
#    misma aplicación, y este guion entra con credencial propia. Es mejor que
#    un bypass: /salud no queda pública y las entradas siguen registrándose.
#
# Para lo segundo, este guion manda las cabeceras de Access si encuentra
# ACCESS_CLIENT_ID y ACCESS_CLIENT_SECRET en el entorno. Si no están, no las
# manda y se comporta como siempre: un bot de la plantilla sin Access montado
# no se rompe por esto.

set -euo pipefail

base="${1:?falta la url base}"
esperado="${2:?falta el sha esperado}"
url="${base%/}/salud"

# Credencial de servicio para pasar Access, si la hay. Nunca se imprime.
cabeceras=()
if [ -n "${ACCESS_CLIENT_ID:-}" ] && [ -n "${ACCESS_CLIENT_SECRET:-}" ]; then
  cabeceras=(-H "CF-Access-Client-Id: ${ACCESS_CLIENT_ID}"
             -H "CF-Access-Client-Secret: ${ACCESS_CLIENT_SECRET}")
  echo "· usando el token de servicio de Access"
fi

# El borde tarda unos segundos en servir la versión nueva.
intentos=10
espera=3

for i in $(seq 1 "$intentos"); do
  codigo="$(curl -fsS -o cuerpo.json -D respuesta.txt -w '%{http_code}' \
    ${cabeceras[@]+"${cabeceras[@]}"} "$url" 2>/dev/null || echo "000")"

  # Access responde en el borde, antes del Worker: un 30x al dominio del equipo
  # es configuración mal puesta, no propagación. Reintentar no la arregla.
  if [ "$codigo" = "301" ] || [ "$codigo" = "302" ] || [ "$codigo" = "303" ]; then
    destino="$(tr -d '\r' < respuesta.txt | awk 'tolower($1) == "location:" { print $2; exit }')"
    case "$destino" in
      *cloudflareaccess.com*)
        echo "✗ $url está DENTRO de la aplicación de Cloudflare Access."
        echo "  Access redirige a iniciar sesión ($codigo) antes de que el Worker corra,"
        echo "  así que ni el despliegue ni ningún monitor pueden leer la salud."
        if [ ${#cabeceras[@]} -eq 0 ]; then
          echo "  No se mandó token de servicio: faltan ACCESS_CLIENT_ID y"
          echo "  ACCESS_CLIENT_SECRET en los secretos del repositorio. Hay que crear un"
          echo "  Service Token en Zero Trust y añadirle a la aplicación una política"
          echo "  Service Auth que lo acepte."
        else
          echo "  SÍ se mandó token de servicio y Access igual lo rechazó: revise que la"
          echo "  aplicación tenga una política Service Auth que incluya ESE token, y que"
          echo "  el token no haya caducado."
        fi
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
