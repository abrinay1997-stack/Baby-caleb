#!/usr/bin/env bash
# Comprueba que `babycaleb-web` está sirviendo Y que el Worker reescribió el
# <head> de cada ruta.
#
#   web-salud.sh <url-base>
#
# Un «200 OK» no basta. La SPA trae un index.html con el mismo <title> para
# las siete páginas, y el trabajo del Worker es cambiarlo por ruta antes de
# que lo vea un robot. Si ese paso se cayera, el sitio seguiría en pie, las
# personas no notarían nada, y lo que se rompería es justo lo invisible:
# Google y WhatsApp verían siete páginas iguales.
#
# Por eso la prueba es comparativa: la portada y /faq tienen que traer
# títulos DISTINTOS, y /faq un canónico que apunte a /faq.

set -euo pipefail

base="${1:?falta la url base}"
base="${base%/}"

titulo() {
  curl -fsS --max-time 20 "$1" | tr '\n' ' ' | grep -oiE '<title>[^<]*</title>' | head -1
}

intentos=10
for i in $(seq 1 "$intentos"); do
  portada="$(titulo "$base/" || true)"
  faq="$(titulo "$base/faq" || true)"

  if [ -n "$portada" ] && [ -n "$faq" ] && [ "$portada" != "$faq" ]; then
    echo "✓ el Worker reescribe el head"
    echo "  /    → $portada"
    echo "  /faq → $faq"

    canonico="$(curl -fsS --max-time 20 "$base/faq" | tr '\n' ' ' \
      | grep -oiE '<link rel="canonical" href="[^"]*"' | head -1)"
    # ABSOLUTO y apuntando a /faq. Pedir solo que «contenga /faq» dejaba pasar
    # un canónico RELATIVO, y eso ya ocurrió: con SITE_URL vacío el Worker
    # armaba las URLs sin dominio. Mirando la página no se nota —el navegador
    # resuelve un canónico relativo— pero `og:url` sale relativo también, y eso
    # es lo que lee WhatsApp al pegar un enlace.
    case "$canonico" in
      *'href="http'*"/faq"*) echo "  canónico: $canonico"; exit 0 ;;
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
  fi

  echo "intento $i/$intentos: portada='${portada:-vacío}' faq='${faq:-vacío}'"
  [ "$i" -lt "$intentos" ] && sleep 3
done

# Dos fallos distintos con dos arreglos distintos, y confundirlos manda al
# siguiente que lo lea a mirar donde no es.
if [ -z "${portada:-}" ] || [ -z "${faq:-}" ]; then
  echo "✗ no se pudo leer un <title> de $base."
  echo "  portada: ${portada:-(nada)}"
  echo "  /faq:    ${faq:-(nada)}"
  echo "  Esto NO dice nada del Worker: o el sitio no responde, o responde algo"
  echo "  que no es HTML. Mire antes si la URL es la correcta y si contesta."
  exit 1
fi

echo "✗ $base sirve, pero /faq y la portada traen el MISMO <title>."
echo "  $portada"
echo "  El sitio está en pie y el Worker no está reescribiendo el <head>:"
echo "  para Google y para WhatsApp las siete páginas serían la misma."
exit 1
