# Ropero Vecinal

Marketplace de ropa de segunda mano entre vecinos de San Miguel, Lima.
Publicado en https://ropero-vecinal.web.app (Firebase Hosting + Firestore, proyecto `ropero-vecinal`).

## Estructura

- `public/index.html`: todo el sitio en una sola página (HTML, CSS y JS sin compilación).
- `firebase.json` y `.firebaserc`: configuración de Firebase Hosting.

## Publicar

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
```

## Estado

Este primer commit es el sitio tal como estaba publicado el 6 de noviembre de 2026, con una sola diferencia:
se quitaron del código el nombre y el celular que definían quién es administrador, porque este repositorio es público.
Mientras tanto nadie es administrador en esta copia.

Las correcciones de seguridad (cuentas con Firebase Authentication, teléfonos privados y reglas de Firestore)
van en una rama aparte con su propio pull request.
