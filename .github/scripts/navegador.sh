#!/usr/bin/env bash
# Instala Chromium para la auditoría del panel, aguantando un DNS que falla.
#
#   navegador.sh [--solo-dependencias]
#
# ## Por qué esto existe
#
# `playwright install --with-deps` hace DOS cosas con redes distintas: baja el
# navegador del CDN de Playwright, y baja unas librerías y tipografías del
# sistema con `apt` desde los espejos de Ubuntu. La segunda se cayó tres veces
# seguidas el 11 de noviembre, en tres flujos distintos, con esto:
#
#     Temporary failure resolving 'archive.ubuntu.com'
#     Temporary failure resolving 'security.ubuntu.com'
#
# Eso no es una cuota ni un permiso ni el plan de GitHub: es la máquina
# efímera de esa corrida quedándose sin resolver nombres. El mismo paso había
# pasado bien dos horas antes en el mismo repo.
#
# ## Por qué un reintento aquí SÍ es correcto
#
# Y conviene dejarlo escrito, porque reintentar suele ser la forma de tapar un
# fallo de verdad. Aquí no: lo que se reintenta es **traer un archivo**, que o
# llega o no llega, y un fallo de DNS se arregla solo en segundos. No se
# reintenta ninguna prueba, ni la auditoría, ni un despliegue. Si el navegador
# se instala y luego Chromium no arranca, eso revienta en el paso siguiente y
# revienta a la primera, que es como tiene que ser.
#
# Si alguien alguna vez quiere envolver en esto la auditoría o las pruebas: no.
# Una prueba que pasa al tercer intento no pasó.

set -euo pipefail

if [ "${1:-}" = "--solo-dependencias" ]; then
  comando=(npx playwright install-deps chromium)
  que="las dependencias del navegador"
else
  comando=(npx playwright install --with-deps chromium)
  que="el navegador"
fi

esperas=(5 15 30)
intentos=$(( ${#esperas[@]} + 1 ))

for i in $(seq 1 "$intentos"); do
  if "${comando[@]}"; then
    [ "$i" -gt 1 ] && echo "✓ $que se instaló al intento $i"
    exit 0
  fi

  if [ "$i" -lt "$intentos" ]; then
    espera=${esperas[$((i - 1))]}
    echo "intento $i/$intentos falló; reintentando en ${espera}s…"
    sleep "$espera"
  fi
done

# Se dice qué mirar, para que el siguiente no busque en el sitio equivocado.
echo "::error::no se pudo instalar $que tras $intentos intentos."
echo "Si el log de arriba dice «Temporary failure resolving», el problema es"
echo "la red de la máquina de GitHub (los espejos de Ubuntu), no este"
echo "repositorio ni los permisos de ningún token. Suele pasarse solo:"
echo "vuelva a lanzar el flujo desde la pestaña Actions."
exit 1
