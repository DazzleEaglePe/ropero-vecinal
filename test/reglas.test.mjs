// Pruebas de firestore.rules contra el emulador de Firestore.
// Se corren con:  npm test   (desde test/; levanta el emulador, corre las pruebas y lo apaga)
import { before, after, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where,
  serverTimestamp, writeBatch, setLogLevel,
} from 'firebase/firestore';

// Los rechazos esperados no se imprimen como advertencias.
setLogLevel('silent');

const PROYECTO = 'demo-ropero-vecinal';
const REGLAS = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');

// Personas de prueba (uids inventados).
const VENDEDORA = 'uidVendedora01';
const COMPRADOR = 'uidComprador01';
const OTRA = 'uidOtraPersona1';
const ADMIN = 'uidAdministra01';
const PRENDA = 'prendaDePrueba01';
const TEL = '900000001';

let env;

function prendaBase(extra = {}) {
  return {
    cat: 'Chaquetas', talla: 'M', estado: 'Poco uso', modo: 'venta', precio: 30, desc: '',
    publicador: 'Ana P.', zona: 'Costanera', status: 'available', userId: VENDEDORA,
    ...extra,
  };
}

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROYECTO,
    firestore: { rules: REGLAS },
  });
});

after(async () => {
  if (env) await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  // Datos iniciales escritos sin reglas.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'prendas', PRENDA), prendaBase());
    await setDoc(doc(a, 'prendas', PRENDA, 'privado', 'contacto'), { telefono: TEL });
    await setDoc(doc(a, 'admins', ADMIN), { desde: 'prueba' });
  });
});

describe('prendas y contacto', () => {
  test('un visitante lee las prendas', async () => {
    await assertSucceeds(getDoc(doc(db(null), 'prendas', PRENDA)));
    await assertSucceeds(getDocs(collection(db(null), 'prendas')));
  });

  test('un visitante no lee privado/contacto', async () => {
    await assertFails(getDoc(doc(db(null), 'prendas', PRENDA, 'privado', 'contacto')));
  });

  test('alguien con sesión pero sin «Me interesa» no lee privado/contacto', async () => {
    await assertFails(getDoc(doc(db(COMPRADOR), 'prendas', PRENDA, 'privado', 'contacto')));
  });

  test('quien marcó «Me interesa» sí lee privado/contacto', async () => {
    const c = db(COMPRADOR);
    // Antes de crear el documento puede comprobar que no existe.
    await assertSucceeds(getDoc(doc(c, 'interesados', `${PRENDA}_${COMPRADOR}`)));
    await assertSucceeds(setDoc(doc(c, 'interesados', `${PRENDA}_${COMPRADOR}`), {
      prendaId: PRENDA, compradorId: COMPRADOR, compradorNombre: 'Beto C.', fecha: serverTimestamp(),
    }));
    const snap = await assertSucceeds(getDoc(doc(c, 'prendas', PRENDA, 'privado', 'contacto')));
    if (snap.data().telefono !== TEL) throw new Error('no llegó el teléfono');
  });

  test('la dueña y el admin leen privado/contacto', async () => {
    await assertSucceeds(getDoc(doc(db(VENDEDORA), 'prendas', PRENDA, 'privado', 'contacto')));
    await assertSucceeds(getDoc(doc(db(ADMIN), 'prendas', PRENDA, 'privado', 'contacto')));
  });

  test('nadie crea una prenda con telefono o whatsapp', async () => {
    const v = db(VENDEDORA);
    await assertFails(addDoc(collection(v, 'prendas'), prendaBase({ telefono: TEL })));
    await assertFails(addDoc(collection(v, 'prendas'), prendaBase({ whatsapp: '51' + TEL })));
    await assertFails(addDoc(collection(db(ADMIN), 'prendas'), prendaBase({ userId: ADMIN, telefono: TEL })));
    // Sin teléfono, a nombre propio y disponible: sí.
    await assertSucceeds(addDoc(collection(v, 'prendas'), prendaBase()));
  });

  test('no se crea una prenda sin sesión, a nombre de otra persona o ya vendida', async () => {
    await assertFails(addDoc(collection(db(null), 'prendas'), prendaBase()));
    await assertFails(addDoc(collection(db(OTRA), 'prendas'), prendaBase()));
    await assertFails(addDoc(collection(db(VENDEDORA), 'prendas'), prendaBase({ status: 'sold' })));
    await assertFails(addDoc(collection(db(VENDEDORA), 'prendas'), prendaBase({ comisionEstado: 'pagada' })));
  });

  test('la prenda y su contacto se crean en un mismo lote', async () => {
    const v = db(VENDEDORA);
    const ref = doc(collection(v, 'prendas'));
    const lote = writeBatch(v);
    lote.set(ref, prendaBase());
    lote.set(doc(v, 'prendas', ref.id, 'privado', 'contacto'), { telefono: TEL });
    await assertSucceeds(lote.commit());
  });

  test('nadie escribe el contacto de una prenda ajena', async () => {
    await assertFails(setDoc(doc(db(OTRA), 'prendas', PRENDA, 'privado', 'contacto'), { telefono: '900000009' }));
    await assertFails(setDoc(doc(db(null), 'prendas', PRENDA, 'privado', 'contacto'), { telefono: '900000009' }));
  });

  test('nadie cambia el userId de una prenda ajena', async () => {
    await assertFails(updateDoc(doc(db(OTRA), 'prendas', PRENDA), { userId: OTRA }));
    await assertFails(updateDoc(doc(db(null), 'prendas', PRENDA), { userId: OTRA }));
    // La dueña tampoco puede regalarla a otra cuenta.
    await assertFails(updateDoc(doc(db(VENDEDORA), 'prendas', PRENDA), { userId: OTRA }));
  });

  test('la dueña no puede marcar su comisión como pagada ni rechazada', async () => {
    const v = db(VENDEDORA);
    await assertFails(updateDoc(doc(v, 'prendas', PRENDA), { comisionEstado: 'pagada' }));
    await assertFails(updateDoc(doc(v, 'prendas', PRENDA), { comisionEstado: 'rechazada' }));
    await assertFails(updateDoc(doc(v, 'prendas', PRENDA), { comisionVerificadaAt: new Date().toISOString() }));
    // Avisar el pago (pendiente) sí puede.
    await assertSucceeds(updateDoc(doc(v, 'prendas', PRENDA), {
      comisionEstado: 'pendiente', comisionOperacion: '123456', comisionSolicitadaAt: new Date().toISOString(),
    }));
    // El admin confirma el pago.
    await assertSucceeds(updateDoc(doc(db(ADMIN), 'prendas', PRENDA), {
      comisionEstado: 'pagada', comisionVerificadaAt: new Date().toISOString(),
    }));
  });

  test('la dueña marca como vendida; otra persona no', async () => {
    const venta = { status: 'sold', soldAt: new Date().toISOString(), buyerId: COMPRADOR, buyerName: 'Beto C.' };
    await assertFails(updateDoc(doc(db(OTRA), 'prendas', PRENDA), venta));
    await assertSucceeds(updateDoc(doc(db(VENDEDORA), 'prendas', PRENDA), venta));
  });

  test('borrar: la dueña o el admin, nadie más', async () => {
    await assertFails(deleteDoc(doc(db(OTRA), 'prendas', PRENDA)));
    await assertFails(deleteDoc(doc(db(null), 'prendas', PRENDA)));
    const v = db(VENDEDORA);
    const lote = writeBatch(v);
    lote.delete(doc(v, 'prendas', PRENDA, 'privado', 'contacto'));
    lote.delete(doc(v, 'prendas', PRENDA));
    await assertSucceeds(lote.commit());
  });

  test('el admin borra una prenda ajena', async () => {
    await assertSucceeds(deleteDoc(doc(db(ADMIN), 'prendas', PRENDA)));
  });
});

describe('interesados', () => {
  const id = `${PRENDA}_${COMPRADOR}`;
  const datos = () => ({ prendaId: PRENDA, compradorId: COMPRADOR, compradorNombre: 'Beto C.', fecha: serverTimestamp() });

  test('no se crea a nombre de otra persona ni con otro id', async () => {
    await assertFails(setDoc(doc(db(OTRA), 'interesados', id), datos()));
    await assertFails(setDoc(doc(db(COMPRADOR), 'interesados', `${PRENDA}_${OTRA}`), datos()));
    await assertFails(setDoc(doc(db(null), 'interesados', id), datos()));
  });

  test('no se guarda el teléfono del comprador', async () => {
    await assertFails(setDoc(doc(db(COMPRADOR), 'interesados', id), { ...datos(), telefono: '900000002' }));
  });

  test('la dueña no se marca interesada en su propia prenda', async () => {
    await assertFails(setDoc(doc(db(VENDEDORA), 'interesados', `${PRENDA}_${VENDEDORA}`), {
      prendaId: PRENDA, compradorId: VENDEDORA, compradorNombre: 'Ana P.', fecha: serverTimestamp(),
    }));
  });

  test('lo leen comprador, dueña y admin; otra persona no', async () => {
    await assertSucceeds(setDoc(doc(db(COMPRADOR), 'interesados', id), datos()));
    await assertSucceeds(getDoc(doc(db(COMPRADOR), 'interesados', id)));
    await assertSucceeds(getDoc(doc(db(VENDEDORA), 'interesados', id)));
    await assertSucceeds(getDoc(doc(db(ADMIN), 'interesados', id)));
    await assertFails(getDoc(doc(db(OTRA), 'interesados', id)));
    await assertFails(getDoc(doc(db(null), 'interesados', id)));
    // La dueña consulta la lista de interesados de su prenda (para «Marcar como vendido»).
    await assertSucceeds(getDocs(query(collection(db(VENDEDORA), 'interesados'), where('prendaId', '==', PRENDA))));
    await assertFails(getDocs(query(collection(db(OTRA), 'interesados'), where('prendaId', '==', PRENDA))));
  });

  test('solo el comprador lo borra', async () => {
    await assertSucceeds(setDoc(doc(db(COMPRADOR), 'interesados', id), datos()));
    await assertFails(deleteDoc(doc(db(VENDEDORA), 'interesados', id)));
    await assertSucceeds(deleteDoc(doc(db(COMPRADOR), 'interesados', id)));
  });
});

describe('intereses (métricas)', () => {
  const base = () => ({
    prendaId: PRENDA, cat: 'Chaquetas', vendedorNombre: 'Ana P.', vendedorZona: 'Costanera',
    compradorId: COMPRADOR, compradorNombre: 'Beto', modalidadEntrega: null, fecha: serverTimestamp(),
  });

  test('se crea con sesión, a nombre propio y sin teléfono', async () => {
    await assertSucceeds(addDoc(collection(db(COMPRADOR), 'intereses'), base()));
    await assertFails(addDoc(collection(db(COMPRADOR), 'intereses'), { ...base(), compradorTelefono: '900000002' }));
    await assertFails(addDoc(collection(db(OTRA), 'intereses'), base()));
    await assertFails(addDoc(collection(db(null), 'intereses'), base()));
  });

  test('solo el admin los lee', async () => {
    await assertFails(getDocs(collection(db(COMPRADOR), 'intereses')));
    await assertSucceeds(getDocs(collection(db(ADMIN), 'intereses')));
  });
});

describe('usuarios', () => {
  test('cada quien escribe solo su perfil y sus datos privados', async () => {
    const c = db(COMPRADOR);
    await assertSucceeds(setDoc(doc(c, 'usuarios', COMPRADOR), { nombre: 'Beto', apellidoInicial: 'C', zona: 'Costanera' }));
    await assertSucceeds(setDoc(doc(c, 'usuarios', COMPRADOR, 'privado', 'datos'), {
      apellido: 'Castro', correo: 'beto@example.com', telefono: '900000002', preferenciaEntrega: '',
    }));
    await assertFails(setDoc(doc(db(OTRA), 'usuarios', COMPRADOR), { nombre: 'X', apellidoInicial: 'X', zona: '' }));
    await assertFails(setDoc(doc(db(OTRA), 'usuarios', COMPRADOR, 'privado', 'datos'), { telefono: '900000009' }));
    // El teléfono no va en el perfil público.
    await assertFails(setDoc(doc(c, 'usuarios', COMPRADOR), { nombre: 'Beto', telefono: '900000002' }));
  });

  test('los datos privados no los lee otra persona; el admin sí', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'usuarios', COMPRADOR, 'privado', 'datos'), { telefono: '900000002' });
    });
    await assertFails(getDoc(doc(db(OTRA), 'usuarios', COMPRADOR, 'privado', 'datos')));
    await assertFails(getDoc(doc(db(null), 'usuarios', COMPRADOR, 'privado', 'datos')));
    await assertSucceeds(getDoc(doc(db(COMPRADOR), 'usuarios', COMPRADOR, 'privado', 'datos')));
    await assertSucceeds(getDoc(doc(db(ADMIN), 'usuarios', COMPRADOR, 'privado', 'datos')));
  });

  test('los registros antiguos con correo y teléfono no son públicos', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'usuarios', 'registroAntiguo1'), {
        nombre: 'Persona', apellido: 'Antigua', correo: 'antigua@example.com', telefono: '900000003',
      });
      await setDoc(doc(ctx.firestore(), 'usuarios', VENDEDORA), { nombre: 'Ana', apellidoInicial: 'P', zona: 'Costanera' });
    });
    await assertFails(getDoc(doc(db(null), 'usuarios', 'registroAntiguo1')));
    await assertFails(getDocs(collection(db(OTRA), 'usuarios')));
    await assertSucceeds(getDoc(doc(db(null), 'usuarios', VENDEDORA)));
  });
});

describe('reseñas', () => {
  const resena = (extra = {}) => ({
    id: `${PRENDA}_${COMPRADOR}`, sellerId: VENDEDORA, sellerName: 'Ana P.', prendaId: PRENDA, prendaCat: 'Chaquetas',
    buyerId: COMPRADOR, buyerName: 'Beto C.', stars: 5, comment: 'Todo bien.', fecha: new Date().toISOString(),
    createdBy: COMPRADOR, ...extra,
  });

  test('solo el comprador de una prenda vendida la reseña, una vez', async () => {
    const ref = (ctx) => doc(ctx, 'resenas', `${PRENDA}_${COMPRADOR}`);
    // Aún no está vendida.
    await assertFails(setDoc(ref(db(COMPRADOR)), resena()));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'prendas', PRENDA), { status: 'sold', buyerId: COMPRADOR, buyerName: 'Beto C.' });
    });
    await assertFails(setDoc(doc(db(OTRA), 'resenas', `${PRENDA}_${OTRA}`), resena({ buyerId: OTRA, createdBy: OTRA })));
    await assertFails(setDoc(ref(db(COMPRADOR)), resena({ stars: 9 })));
    await assertSucceeds(setDoc(ref(db(COMPRADOR)), resena()));
    // Sin edición posterior.
    await assertFails(setDoc(ref(db(COMPRADOR)), resena({ stars: 1 })));
    await assertFails(deleteDoc(ref(db(COMPRADOR))));
    await assertSucceeds(getDoc(ref(db(null))));
    await assertSucceeds(updateDoc(ref(db(ADMIN)), { comment: 'Editado por el admin.' }));
  });
});

describe('admins', () => {
  test('un no admin no escribe en admins', async () => {
    await assertFails(setDoc(doc(db(OTRA), 'admins', OTRA), { yo: true }));
    await assertFails(setDoc(doc(db(null), 'admins', OTRA), { yo: true }));
    await assertFails(deleteDoc(doc(db(OTRA), 'admins', ADMIN)));
    // Ni siquiera un admin lo hace desde el cliente.
    await assertFails(setDoc(doc(db(ADMIN), 'admins', OTRA), { yo: true }));
  });

  test('cada quien lee solo su propio documento de admin', async () => {
    await assertSucceeds(getDoc(doc(db(OTRA), 'admins', OTRA)));
    await assertSucceeds(getDoc(doc(db(ADMIN), 'admins', ADMIN)));
    await assertFails(getDoc(doc(db(OTRA), 'admins', ADMIN)));
    await assertFails(getDocs(collection(db(ADMIN), 'admins')));
  });
});

describe('chat (apagado) y colecciones no declaradas', () => {
  test('una conversación solo la leen sus participantes', async () => {
    const convId = `c_${PRENDA}_${COMPRADOR}`;
    const c = db(COMPRADOR);
    await assertSucceeds(getDoc(doc(c, 'conversaciones', convId)));
    await assertSucceeds(setDoc(doc(c, 'conversaciones', convId), {
      id: convId, product_id: PRENDA, product_title: 'Chaquetas', buyer_id: COMPRADOR, buyer_name: 'Beto',
      seller_id: VENDEDORA, seller_name: 'Ana P.', last_message: 'Hola', unread_seller_count: 1, unread_buyer_count: 0,
    }));
    await assertSucceeds(addDoc(collection(c, 'mensajes'), {
      conversation_id: convId, sender_id: COMPRADOR, receiver_id: VENDEDORA, content: 'Hola',
      created_at_ms: Date.now(), is_read: false,
    }));
    await assertSucceeds(getDocs(query(collection(db(VENDEDORA), 'mensajes'), where('conversation_id', '==', convId))));
    await assertFails(getDoc(doc(db(OTRA), 'conversaciones', convId)));
    await assertFails(getDocs(query(collection(db(OTRA), 'mensajes'), where('conversation_id', '==', convId))));
  });

  test('lo demás está cerrado', async () => {
    await assertFails(setDoc(doc(db(COMPRADOR), 'cualquierCosa', 'x'), { a: 1 }));
    await assertFails(getDoc(doc(db(null), 'cualquierCosa', 'x')));
  });
});
