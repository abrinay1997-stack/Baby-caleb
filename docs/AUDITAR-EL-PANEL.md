# Instrucción para auditar el panel con Claude en Chrome

Pega el bloque de abajo en Claude dentro de Chrome, **después de haber
iniciado sesión** en el panel (Cloudflare Access te pedirá el correo; el
agente trabaja en tu navegador, así que usa tu sesión).

**El panel está en la raíz**, no en `/admin`:

```
https://babycaleb-sistema-staging.juanarrietabusiness.workers.dev/
```

---

## El bloque para pegar

```
Vas a auditar el panel de administración de Baby Caleb, que ya tengo abierto
y con sesión iniciada en esta pestaña.

LO PRIMERO, Y NO ES NEGOCIABLE: estos datos son REALES y son el cerebro de
la web pública babycaleb.com. El catálogo, los precios y las existencias que
veas son los del negocio. Así que:

- Puedes MIRAR todo lo que quieras, entrar en cada pestaña y cada ficha.
- Antes de CAMBIAR cualquier cosa, apunta el valor que había.
- Haz un solo cambio cada vez, compruébalo, y DÉJALO COMO ESTABA.
- No borres nada. No toques Usuarios. No cambies nada en Ajustes que diga
  PENDIENTE: eso lo decide la dueña, no nosotros.

QUIÉN VA A USAR ESTO: la dueña de Baby Caleb, desde su teléfono, sin saber de
informática. Juzga todo desde ahí, no desde lo que es técnicamente correcto.

PRIMERO, EN TAMAÑO TELÉFONO (pon la ventana en 390 px de ancho, que es un
iPhone normal; es como lo va a usar ella de verdad). Recorre TODAS las
pestañas del menú y en cada una dime:

1. ¿Se entiende QUÉ es esta pantalla y PARA QUÉ sirve, sin que nadie te lo
   explique?
2. ¿Hay algo cortado, encimado, o que se salga de lado? ¿Hay que desplazar la
   página a la derecha para leer algo? (Eso último es un fallo, siempre.)
3. ¿Los botones se pueden tocar con el dedo sin pelearse? ¿Alguno queda tapado
   por la barra de abajo?
4. ¿Alguna palabra es de informático y no de tienda? Apúntala con la pantalla
   donde está.
5. Si un número se ve raro (un cero donde esperarías algo, un signo menos, un
   «—»), dímelo aunque no sepas si está mal. Prefiero un falso aviso a que se
   te pase.

DESPUÉS, LAS TAREAS DE VERDAD. Estas son las cosas que la dueña va a hacer.
Intenta hacerlas tú e cuéntame si se puede, cuántos toques cuesta y dónde te
atascaste:

a) Cambiar el precio de un producto. (Apunta el precio viejo. Cámbialo a algo
   obviamente falso, como 99.99. Luego DÉJALO COMO ESTABA.)
b) Quitar un producto de la página web sin borrarlo.
c) Cambiar la foto de un producto.
d) Cambiar la descripción o el nombre de un producto.
e) Ver cuántas cajas quedan de una talla.
f) Ver a qué zonas se entrega y cuánto cuesta el envío.

SI ALGUNA NO SE PUEDE, dímelo claramente: «no encontré cómo hacer X». Eso es
el hallazgo más valioso de todos — significa que la dueña tampoco va a poder.

LUEGO, LA PRUEBA QUE MÁS ME IMPORTA (la sinapsis):

Con el precio todavía cambiado a 99.99, abre babycaleb.com en otra pestaña,
busca ese producto y dime si el precio nuevo aparece ahí. Después vuelve al
panel, deja el precio como estaba, y comprueba otra vez en la web que volvió
al valor original.

Eso me dice si el panel y la página están de verdad conectados, que es lo
único que ninguna prueba automática me puede garantizar.

AL FINAL, dame:
- Las tres cosas que más le van a molestar a ella, en orden.
- Lo que no se puede hacer y debería poderse.
- Si la sinapsis funcionó o no, con lo que viste en cada paso.
- Capturas de lo que esté mal.

No arregles nada ni toques código. Solo mira, prueba y cuenta.
```

---

## Qué esperar

Pestañas desplegadas hoy: **Resumen, Catálogo, Existencias, Bodegas, Zonas,
Ajustes, Usuarios**.

Cobros, Contabilidad, Pedidos y Entregas llegan con el despliegue en curso.
Cuando entre, repite la auditoría incluyendo esas cuatro.

**Lo que todavía no existe, y no es un fallo del panel:** no hay forma de
crear un pedido, ni desde la web ni desde el panel. La pantalla de Pedidos va
a estar vacía y eso es correcto hasta que se enganche `crearPedido`.
