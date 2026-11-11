#!/usr/bin/env bash
# Comprueba que `babycaleb-web` está sirviendo Y que el Worker reescribió el
# <head> de cada ruta.
#
#   web-salud.sh <url-base> [sha-esperado]
#
# Un «200 OK» no basta. La SPA trae un index.html con el mismo <title> para
# las siete páginas, y el trabajo del Worker es cambiarlo por ruta antes de
# que lo vea un robot. Si ese paso se cayera, el sitio seguiría en pie, las
# personas no notarían nada, y lo que se rompería es justo lo invisible:
# Google y WhatsApp verían siete páginas iguales.
#
# ## Por qué se espera la versión por su número
#
# Un despliegue de Cloudflare tarda unos segundos en servirse en todas partes,
# y este guion arrancaba un segundo después. Así que podía comprobar la versión
# VIEJA y culpar a la nueva. Pasó: el canónico relativo ya estaba arreglado y
# desplegado —el sitio en vivo lo servía bien— y el flujo salió en rojo igual.
#
# Reintentar a ciegas no lo arregla, porque un reintento no distingue «todavía
# no llegó» de «llegó y está mal». Lo que sí: PREGUNTARLE al sitio en qué
# versión está. `/api/salud` publica el commit, así que se espera a que coincida
# con el que se acaba de desplegar y recién entonces se comprueba. A partir de
# ahí, lo que se mide es determinista y un fallo es un fallo de verdad.
#
# Sin `sha-esperado` (una corrida a mano) no hay nada que esperar: se comprueba
# lo que haya, diciéndolo.

set -euo pipefail

base="${1:?falta la url base}"
base="${base%/}"
esperado="${2:-}"

# ---- 1. Esperar a que esté sirviendo la versión que se acaba de desplegar ---

if [ -n "$esperado" ]; then
  intentos=20
  for i in $(seq 1 "$intentos"); do
    sirviendo="$(curl -fsS --max-time 20 "$base/api/salud" 2>/dev/null \
      | grep -oE '"version":"[^"]*"' | cut -d'"' -f4 || true)"

    [ "$sirviendo" = "$esperado" ] && break

    if [ "$i" -eq "$intentos" ]; then
      echo "::error::$base no llegó a servir la versión desplegada."
      echo "  esperada:  $esperado"
      echo "  sirviendo: ${sirviendo:-(no se pudo leer /api/salud)}"
      echo ""
      echo "  Esto NO dice nada del <head>: es que el despliegue no se propagó"
      echo "  o /api/salud no contesta. Mire el paso de despliegue, no el código"
      echo "  del Worker."
      exit 1
    fi
    echo "esperando la versión nueva ($i/$intentos): sirviendo ${sirviendo:-(nada)}"
    sleep 3
  done
  echo "✓ sirviendo la versión desplegada (${esperado:0:7})"
else
  echo "⚠ sin sha esperado: se comprueba lo que esté sirviendo ahora mismo."
fi

# ---- 2. Ahora sí, lo que importa -------------------------------------------

cabeza() { curl -fsS --max-time 20 "$1" | tr '\n' ' '; }
titulo() { cabeza "$1" | grep -oiE '<title>[^<]*</title>' | head -1; }

portada="$(titulo "$base/" || true)"
faq="$(titulo "$base/faq" || true)"

# Dos fallos distintos con dos arreglos distintos, y confundirlos manda al
# siguiente que lo lea a mirar donde no es.
if [ -z "$portada" ] || [ -z "$faq" ]; then
  echo "::error::no se pudo leer un <title> de $base."
  echo "  portada: ${portada:-(nada)}"
  echo "  /faq:    ${faq:-(nada)}"
  echo "  Esto NO dice nada del Worker: o el sitio no responde, o responde algo"
  echo "  que no es HTML. Mire antes si la URL es la correcta y si contesta."
  exit 1
fi

if [ "$portada" = "$faq" ]; then
  echo "::error::$base sirve, pero /faq y la portada traen el MISMO <title>."
  echo "  $portada"
  echo "  El sitio está en pie y el Worker no está reescribiendo el <head>:"
  echo "  para Google y para WhatsApp las siete páginas serían la misma."
  exit 1
fi

echo "✓ el Worker reescribe el head"
echo "  /    → $portada"
echo "  /faq → $faq"

canonico="$(cabeza "$base/faq" | grep -oiE '<link rel="canonical" href="[^"]*"' | head -1)"

# ABSOLUTO y apuntando a /faq. Pedir solo que «contenga /faq» dejaba pasar un
# canónico RELATIVO, y eso ya ocurrió: con SITE_URL vacío el Worker armaba las
# URLs sin dominio. Mirando la página no se nota —el navegador resuelve un
# canónico relativo— pero `og:url` sale relativo también, y eso es lo que lee
# WhatsApp al pegar un enlace.
case "$canonico" in
  *'href="http'*"/faq"*) echo "  canónico: $canonico" ;;
  *"/faq"*)
    echo "::error::/faq lleva un canónico RELATIVO: ${canonico}"
    echo "  Tiene que ser absoluto (https://…/faq). Si SITE_URL está vacío,"
    echo "  el Worker debe usar el origen de la petición — ver worker/sitio.ts."
    exit 1
    ;;
  *)
    echo "::error::/faq no lleva un canónico que apunte a /faq: ${canonico:-(ninguno)}"
    exit 1
    ;;
esac
