#!/usr/bin/env node
// Migración de seguridad y tareas de administración de Ropero Vecinal (firebase-admin).
//
// Por defecto SOLO MUESTRA lo que haría. Escribe únicamente si se agrega --aplicar.
//
// Uso (desde la carpeta scripts/, después de `npm install`):
//   export GOOGLE_APPLICATION_CREDENTIALS="/ruta/fuera/del/repo/llave-de-servicio.json"
//
//   node migrar.mjs                               muestra la migración (no escribe)
//   node migrar.mjs --aplicar                     la aplica:
//       - copia el teléfono de cada prenda a prendas/{id}/privado/contacto
//       - borra los campos telefono y whatsapp de la prenda
//       - acorta publicador a «Nombre A.»
//       - borra compradorTelefono de intereses
//   node migrar.mjs --asignar <prendaId> <uid> [--aplicar]
//       devuelve una prenda antigua a su dueño cuando este ya creó su cuenta nueva
//   node migrar.mjs --hacer-admin <uid> [--aplicar]
//       crea admins/{uid}: esa cuenta pasa a ser administradora
//
// Con los emuladores (pruebas): define FIRESTORE_EMULATOR_HOST=127.0.0.1:8080,
// FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 y GCLOUD_PROJECT=demo-ropero-vecinal; no hace falta llave.

import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const AYUDA = `Uso:
  node migrar.mjs [--aplicar]
  node migrar.mjs --asignar <prendaId> <uid> [--aplicar]
  node migrar.mjs --hacer-admin <uid> [--aplicar]
Sin --aplicar solo muestra lo que haría.`;

// ---------- Argumentos ----------
const args = process.argv.slice(2);
const conocidos = new Set(['--aplicar', '--asignar', '--hacer-admin', '--ayuda', '-h']);
for (const a of args) {
  if (a.startsWith('-') && !conocidos.has(a)) salir(`Opción desconocida: ${a}\n\n${AYUDA}`);
}
if (args.includes('--ayuda') || args.includes('-h')) {
  console.log(AYUDA);
  process.exit(0);
}
const APLICAR = args.includes('--aplicar');

function valoresDe(opcion, cuantos) {
  const i = args.indexOf(opcion);
  if (i === -1) return null;
  const valores = args.slice(i + 1, i + 1 + cuantos);
  if (valores.length < cuantos || valores.some((v) => v.startsWith('-'))) {
    salir(`${opcion} necesita ${cuantos === 1 ? 'un valor' : cuantos + ' valores'}.\n\n${AYUDA}`);
  }
  return valores;
}
const asignar = valoresDe('--asignar', 2);
const hacerAdmin = valoresDe('--hacer-admin', 1);
if (asignar && hacerAdmin) salir('Usa --asignar o --hacer-admin, no los dos a la vez.');

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  process.exit(codigo);
}

// ---------- Conexión ----------
const EN_EMULADOR = !!process.env.FIRESTORE_EMULATOR_HOST;
let proyecto;
if (EN_EMULADOR) {
  proyecto = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-ropero-vecinal';
  initializeApp({ projectId: proyecto });
} else {
  const ruta = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!ruta) {
    salir('Falta GOOGLE_APPLICATION_CREDENTIALS con la ruta de la llave de servicio (un archivo .json fuera del repositorio).\n'
      + 'Créala en Firebase Console > Configuración del proyecto > Cuentas de servicio > Generar nueva clave privada.');
  }
  let llave;
  try {
    llave = JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (err) {
    salir(`No se pudo leer la llave de servicio en ${ruta}: ${err.message}`);
  }
  proyecto = llave.project_id;
  initializeApp({ credential: applicationDefault(), projectId: proyecto });
}
const db = getFirestore();

console.log(`Proyecto: ${proyecto} ${EN_EMULADOR ? '(EMULADOR)' : '(PRODUCCIÓN)'}`);
console.log(APLICAR ? 'Modo: APLICAR (se escriben los cambios)\n' : 'Modo: prueba (no se escribe nada; agrega --aplicar para hacerlo)\n');

// ---------- Utilidades ----------
// Deja 9 dígitos (quita el 51 de Perú si viene adelante). Devuelve '' si no es un celular válido.
function normalizarTelefono(valor) {
  let t = String(valor ?? '').replace(/\D/g, '');
  if (t.length === 11 && t.startsWith('51')) t = t.slice(2);
  return /^\d{9}$/.test(t) ? t : '';
}
function enmascararTelefono(t) {
  return t ? `*****${t.slice(-4)}` : '(vacío)';
}
// «Nombre Apellido …» → «Nombre A.». Si ya está así o es una sola palabra, no cambia.
function acortarNombre(texto) {
  const partes = String(texto ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';
  if (partes.length === 1) return partes[0];
  if (partes.length === 2 && /^\p{L}\.$/u.test(partes[1])) return `${partes[0]} ${partes[1].toUpperCase()}`;
  return `${partes[0]} ${partes[1].charAt(0).toLocaleUpperCase('es')}.`;
}
function nombreCorto(nombre, apellidoInicial) {
  const n = String(nombre ?? '').trim();
  const i = String(apellidoInicial ?? '').trim().charAt(0).toLocaleUpperCase('es');
  return i ? `${n} ${i}.` : n;
}
function describirPrenda(id, d) {
  return `${id} (${d.cat || 'Prenda'}${d.talla ? ' · talla ' + d.talla : ''})`;
}

// Lotes de escritura: cada grupo (las operaciones de una prenda) va entero en el mismo lote.
class Lotes {
  constructor() { this.grupos = []; }
  agregar(ops) { if (ops.length) this.grupos.push(ops); }
  get total() { return this.grupos.reduce((n, g) => n + g.length, 0); }
  async escribir() {
    let lote = db.batch();
    let enLote = 0;
    let escritas = 0;
    for (const grupo of this.grupos) {
      if (enLote + grupo.length > 450) {
        await lote.commit();
        lote = db.batch();
        enLote = 0;
      }
      for (const op of grupo) op(lote);
      enLote += grupo.length;
      escritas += grupo.length;
    }
    if (enLote) await lote.commit();
    return escritas;
  }
}

async function comprobarCuenta(uid) {
  try {
    return await getAuth().getUser(uid);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      salir(`No hay ninguna cuenta con el uid ${uid}. Cópialo de Firebase Console > Authentication > Usuarios.`);
    }
    if (EN_EMULADOR) {
      console.warn(`Aviso: no se pudo consultar Authentication (${err.code || err.message}); se sigue sin comprobar el uid.`);
      return null;
    }
    throw err;
  }
}

// ---------- Migración ----------
async function migrar() {
  const lotes = new Lotes();
  const resumen = { prendas: 0, contactos: 0, telefonosBorrados: 0, sinTelefonoValido: 0, nombres: 0, intereses: 0 };

  const prendas = await db.collection('prendas').get();
  resumen.prendas = prendas.size;
  console.log(`Prendas: ${prendas.size}`);
  for (const doc of prendas.docs) {
    const d = doc.data();
    const ops = [];
    const notas = [];
    const cambios = {};

    const tieneTelefono = 'telefono' in d || 'whatsapp' in d;
    if (tieneTelefono) {
      const tel = normalizarTelefono(d.telefono) || normalizarTelefono(d.whatsapp);
      const contactoRef = doc.ref.collection('privado').doc('contacto');
      const contacto = await contactoRef.get();
      if (contacto.exists) {
        notas.push('ya tiene privado/contacto (se conserva)');
      } else if (tel) {
        ops.push((lote) => lote.set(contactoRef, { telefono: tel }));
        resumen.contactos++;
        notas.push(`teléfono ${enmascararTelefono(tel)} → privado/contacto`);
      } else {
        resumen.sinTelefonoValido++;
        notas.push('teléfono vacío o no válido: se borra sin copiar');
      }
      cambios.telefono = FieldValue.delete();
      cambios.whatsapp = FieldValue.delete();
      resumen.telefonosBorrados++;
      notas.push('se borran telefono y whatsapp de la prenda');
    }

    if (typeof d.publicador === 'string') {
      const corto = acortarNombre(d.publicador);
      if (corto && corto !== d.publicador) {
        cambios.publicador = corto;
        resumen.nombres++;
        notas.push(`publicador «${d.publicador}» → «${corto}»`);
      }
    }

    if (Object.keys(cambios).length) ops.push((lote) => lote.update(doc.ref, cambios));
    if (ops.length) {
      lotes.agregar(ops);
      console.log(`  · ${describirPrenda(doc.id, d)}: ${notas.join('; ')}`);
    }
  }

  // Solo se trae el campo que interesa (la colección puede ser grande).
  const intereses = await db.collection('intereses').select('compradorTelefono').get();
  for (const doc of intereses.docs) {
    if ('compradorTelefono' in doc.data()) {
      lotes.agregar([(lote) => lote.update(doc.ref, { compradorTelefono: FieldValue.delete() })]);
      resumen.intereses++;
    }
  }
  console.log(`\nIntereses: ${intereses.size} (con compradorTelefono: ${resumen.intereses})`);

  console.log('\nResumen:');
  console.log(`  contactos privados a crear:        ${resumen.contactos}`);
  console.log(`  prendas a las que se borra el tel.: ${resumen.telefonosBorrados}`);
  console.log(`  prendas sin teléfono válido:        ${resumen.sinTelefonoValido}`);
  console.log(`  nombres a acortar:                  ${resumen.nombres}`);
  console.log(`  intereses a limpiar:                ${resumen.intereses}`);
  console.log(`  escrituras en total:                ${lotes.total}`);

  if (!APLICAR) {
    console.log('\nNo se escribió nada. Revisa la lista y vuelve a correr con --aplicar.');
    return;
  }
  const escritas = await lotes.escribir();
  console.log(`\nListo: ${escritas} escrituras aplicadas.`);
}

// ---------- Devolver una prenda a su dueño ----------
async function asignarPrenda(prendaId, uid) {
  const ref = db.collection('prendas').doc(prendaId);
  const snap = await ref.get();
  if (!snap.exists) salir(`No existe la prenda ${prendaId}.`);
  const d = snap.data();
  const cuenta = await comprobarCuenta(uid);

  const cambios = { userId: uid };
  const perfil = await db.collection('usuarios').doc(uid).get();
  if (perfil.exists && perfil.data().nombre) {
    cambios.publicador = nombreCorto(perfil.data().nombre, perfil.data().apellidoInicial);
  }
  const ops = [(lote) => lote.update(ref, cambios)];

  // Si la prenda no tiene contacto privado, se usa el WhatsApp del perfil de la cuenta nueva.
  const contactoRef = ref.collection('privado').doc('contacto');
  const contacto = await contactoRef.get();
  let notaContacto = 'contacto privado: se conserva el que tiene';
  if (!contacto.exists) {
    const datos = await db.collection('usuarios').doc(uid).collection('privado').doc('datos').get();
    const tel = datos.exists ? normalizarTelefono(datos.data().telefono) : '';
    if (tel) {
      ops.push((lote) => lote.set(contactoRef, { telefono: tel }));
      notaContacto = `contacto privado: se crea con ${enmascararTelefono(tel)} (del perfil de la cuenta)`;
    } else {
      notaContacto = 'contacto privado: no tiene y la cuenta aún no guardó su WhatsApp';
    }
  }

  console.log(`Prenda ${describirPrenda(prendaId, d)}`);
  console.log(`  dueño: ${d.userId || '(ninguno)'} → ${uid}${cuenta && cuenta.email ? ' (cuenta ' + cuenta.email + ')' : ''}`);
  if (cambios.publicador) console.log(`  publicador: «${d.publicador || ''}» → «${cambios.publicador}»`);
  console.log(`  ${notaContacto}`);

  if (!APLICAR) {
    console.log('\nNo se escribió nada. Vuelve a correr con --aplicar para hacerlo.');
    return;
  }
  const lote = db.batch();
  ops.forEach((op) => op(lote));
  await lote.commit();
  console.log('\nListo: la prenda quedó en la cuenta indicada.');
}

// ---------- Hacer admin ----------
async function crearAdmin(uid) {
  const cuenta = await comprobarCuenta(uid);
  const ref = db.collection('admins').doc(uid);
  if ((await ref.get()).exists) {
    console.log(`${uid} ya es admin. No hay nada que hacer.`);
    return;
  }
  console.log(`Se creará admins/${uid}${cuenta && cuenta.email ? ' (cuenta ' + cuenta.email + ')' : ''}.`);
  if (!APLICAR) {
    console.log('\nNo se escribió nada. Vuelve a correr con --aplicar para hacerlo.');
    return;
  }
  await ref.set({ creado: FieldValue.serverTimestamp() });
  console.log('\nListo: esa cuenta ya es admin (debe cerrar sesión y volver a entrar en el sitio).');
}

try {
  if (asignar) await asignarPrenda(asignar[0], asignar[1]);
  else if (hacerAdmin) await crearAdmin(hacerAdmin[0]);
  else await migrar();
} catch (err) {
  salir(`Error: ${err && err.stack ? err.stack : err}`);
}
