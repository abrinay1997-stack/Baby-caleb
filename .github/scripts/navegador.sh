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

# Cada intento con tiempo máximo, y esto NO es un detalle.
#
# La primera versión de este guion reintentaba sin límite por intento, y eso
# empeoró el problema en vez de arreglarlo: `apt` no fallaba rápido, se
# QUEDABA COLGADO esperando un DNS que no contestaba. Cuatro intentos sin
# tope convirtieron un cuelgue en cuatro cuelgues seguidos, y el límite por
# defecto de un trabajo de GitHub son SEIS HORAS. Tres corridas estuvieron
# media hora quemando minutos en un paso que tarda treinta segundos.
#
# La lección, que vale más que el arreglo: **un reintento sin tiempo máximo
# no es resiliencia, es el mismo fallo repetido**. Si lo que se reintenta se
# puede colgar, el tope es parte del reintento, no un extra.
POR_INTENTO=180

if [ "${1:-}" = "--solo-dependencias" ]; then
  comando=(timeout "$POR_INTENTO" npx playwright install-deps chromium)
  que="las dependencias del navegador"
else
  comando=(timeout "$POR_INTENTO" npx playwright install --with-deps chromium)
  que="el navegador"
fi

esperas=(5 15 30)
intentos=$(( ${#esperas[@]} + 1 ))

for i in $(seq 1 "$intentos"); do
  # El estado se captura con `|| estado=$?` y NO se lee con `$?` después de un
  # `if`: ahí `$?` es el del `if` entero —cero cuando la condición es falsa y
  # no hay `else`— así que la comprobación de abajo no se cumplía nunca. Lo
  # escribí así primero y la línea del cuelgue no salía.
  estado=0
  "${comando[@]}" || estado=$?

  if [ "$estado" -eq 0 ]; then
    [ "$i" -gt 1 ] && echo "✓ $que se instaló al intento $i"
    exit 0
  fi

  # 124 es lo que devuelve `timeout` cuando corta. Se dice, porque un cuelgue
  # y un fallo se arreglan distinto y el log tiene que distinguirlos.
  if [ "$estado" -eq 124 ]; then
    echo "   (el intento $i se quedó colgado ${POR_INTENTO}s y se cortó)"
  fi

  if [ "$i" -lt "$intentos" ]; then
    espera=${esperas[$((i - 1))]}
    echo "intento $i/$intentos falló; reintentando en ${espera}s…"
    sleep "$espera"
  fi
done

# Se dice qué mirar, para que el siguiente no busque en el sitio equivocado.
echo "::error::no se pudo instalar $que tras $intentos intentos (tope ${POR_INTENTO}s cada uno)."
echo "Si el log de arriba dice «Temporary failure resolving», el problema es"
echo "la red de la máquina de GitHub (los espejos de Ubuntu), no este"
echo "repositorio ni los permisos de ningún token. Suele pasarse solo:"
echo "vuelva a lanzar el flujo desde la pestaña Actions."
exit 1
