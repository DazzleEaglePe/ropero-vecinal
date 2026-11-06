# Seguridad de Ropero Vecinal

Este documento explica qué estaba mal, qué cambió en la rama `seguridad/firebase-auth` y qué hay que hacer para publicarlo.

## Qué estaba mal

1. **No había cuentas de verdad.** Las cuentas vivían en el `localStorage` del navegador (`ropero_cuentas`, con la contraseña en SHA-256).
   - Una cuenta creada en el celular no servía en otra computadora.
   - «¿Olvidaste tu contraseña?» dejaba poner una contraseña nueva sin verificar nada.
2. **El rol de admin se decidía en el navegador**, comparando el nombre o el celular con valores fijos en el código. Cualquiera podía hacerse admin desde la consola del navegador.
3. **Los celulares de los vendedores eran públicos.**
   - Cada prenda guardaba `telefono`, y la carga rápida del catálogo pedía `telefono` y `whatsapp`.
   - `publicador` llevaba el nombre completo.
   - Cualquier visitante, sin cuenta, descargaba el nombre y el celular de todos los vendedores.
   - `intereses` guardaba además el celular de cada comprador.
4. **Robo de prendas por celular.** Al registrarse, las prendas publicadas con el mismo celular pasaban a la cuenta nueva. Registrarse con el número de otra persona bastaba para quedarse con sus prendas.
5. **Firestore estaba abierto.** Como el sitio escribía sin sesión, las reglas tenían que dejar leer y escribir a cualquiera. Con eso se podía borrar o cambiar cualquier prenda o reseña, darse por pagada una comisión, etc.

## Qué cambió

### Cuentas (Firebase Authentication)

- Registro con correo y contraseña. El nombre queda como `displayName` de la cuenta.
- Ingreso con correo y contraseña, y botón «Continuar con Google» en el mismo modal.
- «¿Olvidaste tu contraseña?» manda el correo oficial de Firebase para elegir una contraseña nueva.
  - El mensaje es el mismo exista o no la cuenta, para no revelar qué correos están registrados.
- La sesión se recuerda en el dispositivo y «Cerrar sesión» la cierra de verdad.
- Se borró el código de `ropero_cuentas` y del hash SHA-256 de contraseñas.
  - Al cargar, la página borra del navegador esas claves y las del perfil local anterior (`ropero_sesion`, `ropero_vecinal_perfil`, `ropero_vecinal_user_id`, `usuarioNombre`, `usuarioTelefono` y `usuarioPreferenciaEntrega`).
- Se quitó el traspaso de prendas por celular. Para devolver una prenda antigua a su dueño, ver «Devolver prendas» más abajo.

### Datos

| Dónde | Qué guarda | Quién lo lee |
|---|---|---|
| `prendas/{id}` | La prenda, con `publicador` = «Nombre A.». Sin teléfono. | Cualquiera |
| `prendas/{id}/privado/contacto` | `{ telefono }` del vendedor | El dueño, el admin y quien marcó «Me interesa» |
| `interesados/{prendaId}_{uid}` | Quién marcó «Me interesa» («Nombre A.») | El comprador, el dueño de la prenda y el admin |
| `intereses` | Métrica de cada «Me interesa», sin teléfono | Solo el admin |
| `usuarios/{uid}` | Nombre, inicial del apellido y zona | Cualquiera |
| `usuarios/{uid}/privado/datos` | Apellido, correo, WhatsApp y preferencia de entrega | El propio usuario y el admin |
| `resenas` | Reseñas | Cualquiera |
| `admins/{uid}` | Marca de administrador | Cada uno, solo el suyo |

- **Publicar** escribe la prenda y su `privado/contacto` en un mismo lote.
- **«Me interesa»** primero crea `interesados/{prendaId}_{uid}` y después lee `privado/contacto` para armar el enlace de WhatsApp. Sin cuenta no hay teléfono.
- La carga rápida del catálogo ya no pide `telefono` ni `whatsapp`.
- Si alguien cambia su WhatsApp en su perfil, se actualiza el contacto de sus prendas disponibles.
- Los registros antiguos de `usuarios`, creados con `add` y que tienen correo y teléfono, dejaron de ser públicos: las reglas solo se los muestran al admin.

### Admin

- Ya no hay nombres ni celulares en el código. Es admin quien tenga un documento `admins/{uid}`.
- Ese documento no se puede escribir desde el navegador. Se crea con `scripts/migrar.mjs --hacer-admin`.
- La página lo lee una vez al iniciar sesión, solo para mostrar los botones. Las reglas lo vuelven a comprobar en cada escritura.

### Reglas de Firestore (`firestore.rules`)

- **Prendas.**
  - Se crean solo con sesión, a nombre propio (`userId == uid`), como `available` y sin `telefono` ni `whatsapp`.
  - El dueño las edita, pero no puede cambiar `userId`, poner la comisión en `pagada` o `rechazada`, ni escribir `comisionVerificadaAt`.
  - El admin puede todo. Las borra el dueño o el admin.
- **Reseñas.** Solo las crea el comprador de una prenda vendida a su nombre, una por prenda. Después solo el admin las cambia.
- **Chat** (apagado): solo lo ven y escriben sus participantes.
- **Todo lo demás está cerrado.**
- Las pruebas están en `test/reglas.test.mjs`.

### Otros cambios en la página

- Modo emulador: en `localhost` o `127.0.0.1` con `?emulador=1`, la página usa los emuladores de Auth y Firestore y el proyecto `demo-ropero-vecinal`. En ese modo no se envía la visita a Google Analytics.
- Se escapan los datos de las prendas al pintarlos (precio, estado, fotos, filtros y nombre del vendedor), para que una prenda con HTML en sus campos no pueda ejecutar código en el navegador de otros vecinos.

## Pasos para publicarlo

Hazlos en este orden. Nada de esto se hizo en esta rama: todo se probó solo con los emuladores.

### 1. Activar los métodos de ingreso

En [Firebase Console](https://console.firebase.google.com/project/ropero-vecinal/authentication/providers) > Authentication > Método de acceso:

1. Activa **Correo electrónico/contraseña**.
2. Activa **Google**. Elige el correo de asistencia del proyecto.
3. En Authentication > Configuración > **Dominios autorizados**, revisa que estén `ropero-vecinal.web.app` y `ropero-vecinal.firebaseapp.com`.
4. (Opcional) En Authentication > Plantillas, pon en español el correo de «Restablecer contraseña».

### 2. Crear la llave de servicio

1. Ve a Configuración del proyecto > Cuentas de servicio > **Generar nueva clave privada**.
2. Guarda el `.json` **fuera del repositorio**, por ejemplo en `~/llaves/ropero-vecinal.json`. El `.gitignore` también ignora `*serviceAccount*.json` y `*-firebase-adminsdk-*.json`, pero es mejor que ni pase por la carpeta.
3. No la compartas. Quien la tenga puede leer y cambiar toda la base de datos.

```bash
cd scripts
npm install
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/llaves/ropero-vecinal.json"
```

### 3. Correr la migración en modo prueba

```bash
node migrar.mjs
```

- No escribe nada: lista prenda por prenda lo que haría y un resumen. Revisa:
  - cuántos teléfonos se copiarán a `privado/contacto`;
  - qué prendas no tienen un teléfono válido;
  - cómo quedan los nombres acortados («Nombre A.»).
- La primera línea debe decir `Proyecto: ropero-vecinal (PRODUCCIÓN)`.

### 4. Aplicar la migración y publicar, uno detrás del otro

Desde que corre la migración, el sitio publicado hoy deja de encontrar los teléfonos. Desde que se publican las reglas nuevas, el sitio de hoy ya no puede escribir. Por eso conviene hacer las dos cosas seguidas:

```bash
node migrar.mjs --aplicar
cd ..
firebase deploy --only firestore:rules,hosting
```

### 5. Hacerte admin

1. Entra a https://ropero-vecinal.web.app y crea tu cuenta (o entra con Google).
2. En Firebase Console > Authentication > Usuarios, copia tu **UID**.
3. Ejecuta:

```bash
cd scripts
node migrar.mjs --hacer-admin <tu-uid>             # muestra lo que haría
node migrar.mjs --hacer-admin <tu-uid> --aplicar   # lo hace
```

4. Cierra sesión y vuelve a entrar para ver las opciones de admin.

Para quitarle el rol a alguien, borra su documento en la colección `admins` desde la consola de Firestore.

### 6. Avisar a los vecinos

- **Todos tienen que crear su cuenta otra vez.** Las cuentas anteriores vivían en cada navegador y no se pueden pasar a Firebase Authentication.
  - Sus prendas siguen publicadas y con su WhatsApp, pero quedan sin dueño en la página: no las pueden marcar como vendidas ni borrar.
- Cuando alguien cree su cuenta nueva, devuélvele sus prendas (ver abajo).
- Mientras tanto, el admin puede marcarlas como vendidas o borrarlas.

### Devolver prendas a su dueño

1. Busca el id de la prenda en la consola de Firestore (colección `prendas`).
2. Busca el UID de la persona en Authentication > Usuarios.
3. Comprueba por WhatsApp que la persona sea la dueña de verdad (por ejemplo, que te escriba desde el número de la prenda).
4. Ejecuta:

```bash
node migrar.mjs --asignar <prendaId> <uid>             # muestra lo que haría
node migrar.mjs --asignar <prendaId> <uid> --aplicar   # lo hace
```

`--asignar` cambia el dueño. Si la persona ya completó su perfil, también pone su «Nombre A.». El teléfono de contacto de la prenda se conserva.

## Probar en local (emuladores)

Hace falta Java (para el emulador de Firestore) y Node 22 o más. No se necesita `firebase login`: los emuladores usan el proyecto `demo-ropero-vecinal`, que nunca toca el proyecto real.

```bash
cd test
npm install
npm test           # pruebas de reglas (test/reglas.test.mjs)
npm run e2e        # el sitio en Chrome headless contra los emuladores (test/sitio.e2e.mjs)
npm run emuladores # deja los emuladores corriendo; abre http://127.0.0.1:5050/?emulador=1
```

## Riesgos que siguen abiertos

- **Spam de interés para juntar teléfonos.** Cualquiera con cuenta puede marcar «Me interesa» y ver el WhatsApp del vendedor; es el diseño del sitio. Crear muchas cuentas para juntar números es posible. Si pasa, conviene activar App Check y exigir correo verificado en las reglas.
- **El correo no se verifica.** Se puede crear una cuenta con un correo ajeno (no da acceso a nada de esa persona, pero el nombre es libre).
- **Reseñas.** El vendedor elige al comprador entre quienes marcaron «Me interesa». Con una segunda cuenta podría reseñarse a sí mismo.
- **Los números de soporte y de Yape siguen en el código**, como antes.
- **Las fotos siguen en base64 dentro de cada prenda.** Arriesga el límite de 1 MB por documento y hace pesado el catálogo.
