# Ropero Vecinal

Marketplace de ropa de segunda mano entre vecinos de San Miguel, Lima.
Publicado en https://ropero-vecinal.web.app (Firebase Hosting + Authentication + Firestore, proyecto `ropero-vecinal`).

## Estructura

- `public/index.html`: todo el sitio en una sola página (HTML, CSS y JS sin compilación).
- `firestore.rules`: reglas de seguridad de Firestore.
- `firebase.json` y `.firebaserc`: configuración de Firebase (Hosting, reglas y emuladores).
- `scripts/migrar.mjs`: migración de seguridad y tareas de admin (`--hacer-admin`, `--asignar`).
- `test/`: pruebas de las reglas y del sitio contra los emuladores.
- `SEGURIDAD.md`: qué se corrigió y los pasos para publicarlo.

## Publicar

Antes de la primera publicación con cuentas, sigue los pasos de [SEGURIDAD.md](SEGURIDAD.md): activar los métodos de ingreso, correr la migración y hacerte admin.

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,hosting
```

## Probar en local

```bash
cd test
npm install
npm test           # reglas de Firestore en el emulador
npm run e2e        # el sitio en Chrome headless contra los emuladores
npm run emuladores # emuladores corriendo; abre http://127.0.0.1:5050/?emulador=1
```

En `localhost` o `127.0.0.1` con `?emulador=1` la página usa los emuladores y el proyecto `demo-ropero-vecinal`, que nunca toca los datos reales.

## Estado

- El primer commit es el sitio tal como estaba publicado el 6 de noviembre de 2026. Se quitaron del código el nombre y el celular que definían quién es administrador, porque este repositorio es público.
- La rama `seguridad/firebase-auth` agrega cuentas con Firebase Authentication, teléfonos privados y reglas de Firestore. El detalle está en [SEGURIDAD.md](SEGURIDAD.md).
- Ahora es admin quien tenga un documento `admins/{uid}`, que se crea con `scripts/migrar.mjs --hacer-admin`.
