// Prueba de punta a punta del sitio contra los emuladores (Auth, Firestore y Hosting).
// Se corre con:  npm run e2e   (desde test/)
//
// 1. Siembra una prenda «antigua» con teléfono (como las que hay hoy en producción) y la migra con
//    scripts/migrar.mjs contra el emulador.
// 2. Abre public/ en Chrome headless con ?emulador=1 y prueba: registro, publicación, «Me interesa»
//    hasta el enlace de WhatsApp, marcar como vendida, reseña, ingreso, cambio de contraseña,
//    Google (ventana del emulador), --hacer-admin y --asignar.
// 3. Falla si la página registra errores de consola.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, getDocs, collection, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const PROYECTO = 'demo-ropero-vecinal';
const SITIO = 'http://127.0.0.1:5050/?emulador=1';
const AUTH = 'http://127.0.0.1:9099';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIGRAR = fileURLToPath(new URL('../scripts/migrar.mjs', import.meta.url));

// Datos inventados para la prueba.
const VENDEDORA = { nombre: 'Ana', apellido: 'Prueba', correo: 'ana.prueba@example.com', pass: 'clave-ana-123', cel: '900000011', zona: 'Costanera' };
const COMPRADOR = { nombre: 'Beto', apellido: 'Ensayo', correo: 'beto.ensayo@example.com', pass: 'clave-beto-123', cel: '900000022', zona: 'Bertolotto' };
const ANTIGUA = { id: 'prendaAntigua0001', telefono: '900000033' };

const resultados = [];
const erroresConsola = [];
let fallo = false;

function ok(nombre, condicion, detalle = '') {
  resultados.push(`${condicion ? '✔' : '✘'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!condicion) fallo = true;
  return condicion;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// PNG de 48×48 de un solo color (sin dependencias).
function png(r, g, b) {
  const w = 48, h = 48;
  const filas = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    filas[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      filas[i] = (r + x * 3) & 255; filas[i + 1] = (g + y * 3) & 255; filas[i + 2] = b;
    }
  }
  const trozo = (tipo, datos) => {
    const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo), datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([largo, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IDAT', deflateSync(filas)), trozo('IEND', Buffer.alloc(0)),
  ]);
}

function migrar(...extra) {
  return execFileSync('node', [MIGRAR, ...extra], {
    env: { ...process.env, GCLOUD_PROJECT: PROYECTO },
    encoding: 'utf8',
  });
}

async function nuevaPagina(contexto, etiqueta) {
  const page = await contexto.newPage();
  page.setDefaultTimeout(20000);
  await page.evaluateOnNewDocument(() => {
    // WhatsApp no se abre de verdad: se guarda la URL. Las demás ventanas (Google) se abren normal.
    window.__abiertas = [];
    const abrirOriginal = window.open.bind(window);
    window.open = (url, ...resto) => {
      if (String(url).startsWith('https://wa.me/')) { window.__abiertas.push(String(url)); return null; }
      return abrirOriginal(url, ...resto);
    };
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const texto = m.text();
    const url = (m.location() && m.location().url) || '';
    // El sitio no tiene favicon (pasa igual en producción).
    if (/favicon\.ico/.test(url) || /favicon/.test(texto)) return;
    // 400 provocado a propósito al probar una contraseña equivocada.
    if (page.__esperaErrorLogin && /accounts:signInWithPassword/.test(url) && /status of 400/.test(texto)) return;
    erroresConsola.push(`[${etiqueta}] ${texto} ${url}`);
  });
  page.on('pageerror', (err) => erroresConsola.push(`[${etiqueta}] pageerror: ${err.message}`));
  page.on('dialog', async (d) => {
    page.__dialogos = page.__dialogos || [];
    page.__dialogos.push(d.message());
    await d.accept();
  });
  return page;
}

async function escribir(page, selector, texto) {
  await page.$eval(selector, (el) => { el.value = ''; });
  await page.type(selector, texto);
}

async function registrar(page, persona) {
  await page.waitForSelector('#modal-auth:not([hidden])');
  await page.click('#tab-crear');
  await escribir(page, '#auth-nombre', persona.nombre);
  await escribir(page, '#auth-apellido', persona.apellido);
  await escribir(page, '#auth-correo', persona.correo);
  await escribir(page, '#auth-pass', persona.pass);
  await escribir(page, '#auth-cel', persona.cel);
  await page.select('#auth-zona', persona.zona);
  await page.click('#form-crear button[type=submit]');
  await page.waitForSelector('#user-menu:not([hidden])');
}

async function uidDe(page) {
  return page.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
}

// Las tarjetas se vuelven a pintar con cada cambio del catálogo: siempre se buscan de nuevo.
function buscarEnTarjeta(cat, sel) {
  const card = [...document.querySelectorAll('#catalog-grid .prenda-card')]
    .find((c) => c.querySelector('.prenda-cat') && c.querySelector('.prenda-cat').textContent === cat);
  return card ? (sel ? card.querySelector(sel) : card) : null;
}
async function tarjeta(page, categoria, selector = null, timeout = 20000) {
  await page.waitForFunction(`(${buscarEnTarjeta})(${JSON.stringify(categoria)}, ${JSON.stringify(selector)})`, { timeout });
}
async function hayEnTarjeta(page, categoria, selector) {
  return page.evaluate(`!!(${buscarEnTarjeta})(${JSON.stringify(categoria)}, ${JSON.stringify(selector)})`);
}
async function clicEnTarjeta(page, categoria, selector) {
  await tarjeta(page, categoria, selector);
  await page.evaluate(`(${buscarEnTarjeta})(${JSON.stringify(categoria)}, ${JSON.stringify(selector)}).click()`);
}

async function principal() {
  // ---------- Siembra y migración ----------
  const env = await initializeTestEnvironment({ projectId: PROYECTO, firestore: { host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  // Lecturas y escrituras sin reglas (como lo haría la consola de Firebase).
  const admin = async (fn) => {
    let resultado;
    await env.withSecurityRulesDisabled(async (ctx) => { resultado = await fn(ctx.firestore()); });
    return resultado;
  };
  await admin(async (db) => {
    await setDoc(doc(db, 'prendas', ANTIGUA.id), {
      cat: 'Chaquetas', talla: 'L', estado: 'Buen estado', modo: 'venta', precio: 45, desc: 'Prenda sembrada para la prueba.',
      publicador: 'Persona Antigua', zona: 'Parque Central', telefono: ANTIGUA.telefono, status: 'available',
      userId: 'user_antiguo_navegador', fotoHash: 'hash-antiguo', fecha: new Date('2026-10-01T12:00:00Z'),
    });
    await setDoc(doc(db, 'intereses', 'interesAntiguo1'), {
      prendaId: ANTIGUA.id, compradorId: 'user_otro', compradorNombre: 'Alguien', compradorTelefono: '900000044',
    });
  });

  const prueba = migrar();
  ok('migrar.mjs sin --aplicar no escribe', prueba.includes('No se escribió nada'));
  let antigua = await admin(async (db) => (await getDoc(doc(db, 'prendas', ANTIGUA.id))).data());
  ok('…y la prenda sigue igual', antigua.telefono === ANTIGUA.telefono);

  migrar('--aplicar');
  antigua = await admin(async (db) => (await getDoc(doc(db, 'prendas', ANTIGUA.id))).data());
  const contactoAntiguo = await admin(async (db) => (await getDoc(doc(db, 'prendas', ANTIGUA.id, 'privado', 'contacto'))).data());
  const interesAntiguo = await admin(async (db) => (await getDoc(doc(db, 'intereses', 'interesAntiguo1'))).data());
  ok('migrar.mjs --aplicar saca el teléfono de la prenda', !('telefono' in antigua) && !('whatsapp' in antigua));
  ok('…lo deja en privado/contacto', contactoAntiguo && contactoAntiguo.telefono === ANTIGUA.telefono);
  ok('…acorta publicador a «Nombre A.»', antigua.publicador === 'Persona A.', antigua.publicador);
  ok('…borra compradorTelefono de intereses', !('compradorTelefono' in interesAntiguo));

  // ---------- Navegador ----------
  const dir = mkdtempSync(join(tmpdir(), 'ropero-e2e-'));
  const frente = join(dir, 'frente.png');
  const atras = join(dir, 'atras.png');
  writeFileSync(frente, png(200, 30, 60));
  writeFileSync(atras, png(20, 120, 220));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    // --- Vendedora: carga, registro y publicación ---
    const ctxA = await browser.createBrowserContext();
    const a = await nuevaPagina(ctxA, 'vendedora');
    const consultasRest = [];
    a.on('request', (r) => { if (r.url().includes(':runQuery')) consultasRest.push(r.postData() || ''); });
    await a.goto(SITIO, { waitUntil: 'load' });
    await tarjeta(a, 'Chaquetas');
    ok('la página carga el catálogo desde el emulador', true);
    ok('la consulta rápida (REST) ya no pide telefono ni whatsapp',
      consultasRest.length > 0 && consultasRest.every((b) => !b.includes('"telefono"') && !b.includes('"whatsapp"')),
      `${consultasRest.length} consulta(s)`);

    await a.click('#btn-entrar');
    await registrar(a, VENDEDORA);
    const uidA = await uidDe(a);
    ok('registro con correo y contraseña (Firebase Auth)', !!uidA);
    const nombreMenu = await a.$eval('#user-corto', (el) => el.textContent);
    ok('la cabecera muestra la sesión', nombreMenu === VENDEDORA.nombre, nombreMenu);
    const perfilA = await admin(async (db) => (await getDoc(doc(db, 'usuarios', uidA))).data());
    const privadoA = await admin(async (db) => (await getDoc(doc(db, 'usuarios', uidA, 'privado', 'datos'))).data());
    ok('usuarios/{uid} tiene solo el perfil público', perfilA && perfilA.nombre === 'Ana' && perfilA.apellidoInicial === 'P'
      && !('telefono' in perfilA) && !('correo' in perfilA), JSON.stringify(Object.keys(perfilA || {})));
    ok('usuarios/{uid}/privado/datos guarda correo y teléfono', privadoA && privadoA.telefono === VENDEDORA.cel && privadoA.correo === VENDEDORA.correo);
    const displayName = await a.evaluate(() => firebase.auth().currentUser.displayName);
    ok('displayName de la cuenta', displayName === 'Ana Prueba', displayName);

    await a.click('#btn-publicar-nav');
    await a.waitForSelector('#screen-publicar.active');
    await (await a.$('#foto-frente')).uploadFile(frente);
    await a.waitForFunction(() => document.querySelector('#slot-frente img'));
    await (await a.$('#foto-atras')).uploadFile(atras);
    await a.waitForFunction(() => document.querySelector('#slot-atras img'));
    await a.select('#pub-categoria', 'Vestidos');
    await escribir(a, '#pub-precio', '25');
    await a.click('#btn-publicar');
    await a.waitForFunction(() => document.querySelector('#screen-catalogo.active'));
    ok('publicar muestra el aviso de éxito', (a.__dialogos || []).some((m) => m.includes('Prenda publicada con éxito')), (a.__dialogos || []).join(' | '));
    const nuevas = await admin(async (db) => {
      const snap = await getDocs(collection(db, 'prendas'));
      return snap.docs.filter((d) => d.data().userId === uidA).map((d) => ({ id: d.id, ...d.data() }));
    });
    const prenda = nuevas[0];
    ok('la prenda nueva queda a nombre del uid', nuevas.length === 1);
    ok('la prenda nueva no tiene telefono ni whatsapp', prenda && !('telefono' in prenda) && !('whatsapp' in prenda));
    ok('publicador = «Nombre A.»', prenda && prenda.publicador === 'Ana P.', prenda && prenda.publicador);
    const contactoNuevo = await admin(async (db) => (await getDoc(doc(db, 'prendas', prenda.id, 'privado', 'contacto'))).data());
    ok('el teléfono queda en prendas/{id}/privado/contacto', contactoNuevo && contactoNuevo.telefono === VENDEDORA.cel);

    // --- Comprador: «Me interesa» → WhatsApp ---
    const ctxB = await browser.createBrowserContext();
    const b = await nuevaPagina(ctxB, 'comprador');
    await b.goto(SITIO, { waitUntil: 'load' });
    const leeSinInteres = await b.evaluate(async (id) => {
      try { await firebase.firestore().doc(`prendas/${id}/privado/contacto`).get(); return 'leyó'; }
      catch (e) { return e.code; }
    }, prenda.id);
    ok('un visitante no puede leer privado/contacto', leeSinInteres === 'permission-denied', leeSinInteres);
    await clicEnTarjeta(b, 'Vestidos', '.interesa-btn');
    await registrar(b, COMPRADOR);
    const uidB = await uidDe(b);
    await b.waitForSelector('#modal-datos:not([hidden])');
    await b.click('#modal-entrega-group .pill[data-entrega="Punto público seguro"]');
    await b.click('#modal-datos-guardar');
    await b.waitForSelector('#screen-entrega.active');
    await b.click('.entrega-card[data-entrega="publico"]');
    await b.waitForSelector('#btn-whatsapp-entrega');
    const href = await b.$eval('#btn-whatsapp-entrega', (el) => el.href);
    const abiertas = await b.evaluate(() => window.__abiertas);
    ok('«Me interesa» arma el enlace de WhatsApp con el teléfono privado', href.startsWith(`https://wa.me/51${VENDEDORA.cel}?text=`), href.slice(0, 40));
    ok('…y lo abre', abiertas.length === 1 && abiertas[0] === href);
    const interesado = await admin(async (db) => (await getDoc(doc(db, 'interesados', `${prenda.id}_${uidB}`))).data());
    ok('se creó interesados/{prendaId}_{uid}', interesado && interesado.compradorId === uidB && interesado.compradorNombre === 'Beto E.',
      interesado && interesado.compradorNombre);
    const intereses = await admin(async (db) => (await getDocs(collection(db, 'intereses'))).docs.map((d) => d.data()).filter((x) => x.compradorId === uidB));
    ok('intereses sin compradorTelefono', intereses.length > 0 && intereses.every((x) => !('compradorTelefono' in x)), `${intereses.length} registro(s)`);

    // --- Vendedora marca como vendida (lee la lista de interesados) ---
    await a.reload({ waitUntil: 'load' });
    await a.waitForSelector('#user-menu:not([hidden])');
    await clicEnTarjeta(a, 'Vestidos', '.vender-btn:not(.calificar-btn)');
    await a.waitForSelector('#modal-venta:not([hidden])');
    const opciones = await a.$$eval('#sv-comprador option', (os) => os.map((o) => o.textContent));
    ok('la vendedora ve a quien marcó «Me interesa»', opciones.includes('Beto E.'), opciones.join(', '));
    await a.click('#sv-publicar');
    await a.waitForSelector('#modal-venta', { hidden: true });
    await esperar(800);
    const vendida = await admin(async (db) => (await getDoc(doc(db, 'prendas', prenda.id))).data());
    ok('la prenda queda vendida al comprador', vendida.status === 'sold' && vendida.buyerId === uidB);

    // --- Comprador deja su reseña ---
    await b.goto(SITIO, { waitUntil: 'load' });
    await b.waitForSelector('#user-menu:not([hidden])');
    await clicEnTarjeta(b, 'Vestidos', '.calificar-btn');
    await b.waitForSelector('#modal-venta:not([hidden])');
    await b.click('#sv-estrellas button[data-v="5"]');
    await b.type('#sv-comentario', 'Puntual y la prenda tal como en las fotos.');
    await b.click('#sv-publicar');
    await esperar(1000);
    const resena = await admin(async (db) => (await getDoc(doc(db, 'resenas', `${prenda.id}_${uidB}`))).data());
    ok('el comprador publica su reseña', resena && resena.stars === 5 && resena.sellerId === uidA);

    // --- Cerrar sesión, olvidar contraseña e ingresar ---
    await a.click('#btn-user');
    await a.click('#menu-salir');
    await a.waitForSelector('#btn-entrar:not([hidden])');
    ok('cerrar sesión', (await uidDe(a)) === null);
    await a.click('#btn-entrar');
    await a.waitForSelector('#form-entrar:not([hidden])');
    await escribir(a, '#login-correo', VENDEDORA.correo);
    await a.click('#btn-olvide');
    await a.click('#btn-nueva-pass');
    await a.waitForFunction(() => getComputedStyle(document.getElementById('recuperar-ok')).display === 'block');
    const codigos = await (await fetch(`${AUTH}/emulator/v1/projects/${PROYECTO}/oobCodes`)).json();
    ok('«¿Olvidaste tu contraseña?» envía el correo de cambio', (codigos.oobCodes || [])
      .some((c) => c.requestType === 'PASSWORD_RESET' && c.email === VENDEDORA.correo));
    await escribir(a, '#login-pass', 'clave-equivocada');
    a.__esperaErrorLogin = true;
    await a.click('#form-entrar button[type=submit]');
    await a.waitForSelector('#auth-error-login.show');
    await esperar(300);
    a.__esperaErrorLogin = false;
    const errorLogin = await a.$eval('#auth-error-login', (el) => el.textContent);
    ok('contraseña equivocada: mensaje', errorLogin === 'Correo o contraseña incorrectos.', errorLogin);
    await escribir(a, '#login-pass', VENDEDORA.pass);
    await a.click('#form-entrar button[type=submit]');
    await a.waitForSelector('#user-menu:not([hidden])');
    ok('ingresar con correo y contraseña', (await uidDe(a)) === uidA);
    await tarjeta(a, 'Chaquetas');
    ok('sin admins/{uid} no ve «Eliminar» en prendas ajenas', !(await hayEnTarjeta(a, 'Chaquetas', '.eliminar-btn')));

    // --- Admin y devolución de prendas ---
    const salidaAdmin = migrar('--hacer-admin', uidA, '--aplicar');
    ok('migrar.mjs --hacer-admin', salidaAdmin.includes('ya es admin') || salidaAdmin.includes('Listo'));
    await a.reload({ waitUntil: 'load' });
    await a.waitForSelector('#user-menu:not([hidden])');
    await tarjeta(a, 'Chaquetas', '.eliminar-btn', 8000).catch(() => null);
    ok('con admins/{uid} la página la trata como admin', await hayEnTarjeta(a, 'Chaquetas', '.eliminar-btn'));

    const pruebaAsignar = migrar('--asignar', ANTIGUA.id, uidB);
    ok('--asignar sin --aplicar no escribe', pruebaAsignar.includes('No se escribió nada'));
    migrar('--asignar', ANTIGUA.id, uidB, '--aplicar');
    antigua = await admin(async (db) => (await getDoc(doc(db, 'prendas', ANTIGUA.id))).data());
    ok('--asignar devuelve la prenda a la cuenta nueva', antigua.userId === uidB && antigua.publicador === 'Beto E.', antigua.publicador);

    // --- Continuar con Google (ventana del emulador de Auth) ---
    const ctxC = await browser.createBrowserContext();
    const c = await nuevaPagina(ctxC, 'google');
    await c.goto(SITIO, { waitUntil: 'load' });
    await c.click('#btn-entrar');
    await c.waitForSelector('#modal-auth:not([hidden])');
    const ventanaP = new Promise((r, rechazar) => {
      c.once('popup', r);
      setTimeout(() => rechazar(new Error('No se abrió la ventana de Google del emulador')), 15000);
    });
    await c.click('#btn-google');
    const ventana = await ventanaP;
    ventana.setDefaultTimeout(20000);
    await ventana.waitForSelector('button, a');
    // Pantalla del emulador: «Add new account» → «Auto-generate user information» → «Sign in with Google.com».
    await ventana.evaluate(() => [...document.querySelectorAll('button')].find((el) => /add new account/i.test(el.textContent)).click());
    await esperar(500);
    await ventana.evaluate(() => document.querySelector('#autogen-button').click());
    await ventana.waitForFunction(() => document.querySelector('#email-input').value.length > 0);
    await esperar(300);
    await ventana.evaluate(() => document.querySelector('#sign-in').click());
    await c.waitForSelector('#user-menu:not([hidden])');
    const uidC = await uidDe(c);
    const enPerfil = await c.$eval('#screen-registro', (el) => el.classList.contains('active'));
    ok('«Continuar con Google» crea la sesión', !!uidC);
    ok('…y lleva a completar el perfil (zona y WhatsApp)', enPerfil);
    const perfilC = await admin(async (db) => (await getDoc(doc(db, 'usuarios', uidC))).data());
    ok('…con usuarios/{uid} creado', !!perfilC && typeof perfilC.nombre === 'string');
  } finally {
    await browser.close();
    await env.cleanup();
  }

  ok('sin errores de consola en la página', erroresConsola.length === 0, erroresConsola.slice(0, 5).join(' || '));
}

try {
  await principal();
} catch (err) {
  fallo = true;
  resultados.push(`✘ la prueba se interrumpió: ${err && err.stack ? err.stack : err}`);
  if (erroresConsola.length) resultados.push('Errores de consola: ' + erroresConsola.join(' || '));
}
console.log('\n' + resultados.join('\n'));
console.log(fallo ? '\nFALLÓ' : `\nTODO BIEN (${resultados.length} comprobaciones)`);
process.exit(fallo ? 1 : 0);
