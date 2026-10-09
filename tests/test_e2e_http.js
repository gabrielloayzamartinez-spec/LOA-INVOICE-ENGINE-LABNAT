/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DE INTEGRACION END-TO-END POR HTTP REAL
 * ==============================================================================
 * Los demas tests usan dobles de `fetch`. Este levanta DOS SERVIDORES HTTP REALES
 * en localhost que hablan el protocolo de vTiger y de GHL, y ejecuta el motor
 * completo contra ellos. Asi se verifica lo que un doble no puede:
 *
 *   - Cookies y redirecciones reales (302) en el login web de vTiger.
 *   - El body multipart REAL que viaja por la red (boundary incluido) y que el
 *     PDF llega integro a la Media Library.
 *   - Cabeceras de autenticacion en cada llamada a GHL.
 *   - El proceso del CLI completo, de punta a punta.
 *
 * Cero contacto con sistemas reales: todo ocurre en 127.0.0.1.
 *
 * Ejecucion:  node tests/test_e2e_http.js
 * ==============================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(AQUI, '..', 'src', 'cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-e2e-'));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const LOC = 'loc-e2e';
const PIT = 'pit-e2e-secreto';

const HTML_LOGIN = `<html><body><form method="POST" action="index.php">
  <input type="hidden" name="__vtrftk" value="sid:e2e:1">
  <input type="hidden" name="module" value="Users">
  <input type="hidden" name="action" value="Login">
  <input type="text" name="username"><input type="password" name="password">
</form></body></html>`;
const HTML_INTERNO = '<html><body><a href="index.php?module=Users&action=Logout">Logout</a>Home</body></html>';

// ------------------------------------------------------------------------------
// Servidor vTiger real (login web + ExportPDF)
// ------------------------------------------------------------------------------
function crearVtigerFalso({ rechazaLogin = false } = {}) {
  const estado = { logins: 0, posts: [], pdfs: 0, detalles: 0 };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && u.searchParams.get('action') === 'Login') {
      estado.logins++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'PHPSESSID=sess-e2e; Path=/' });
      return res.end(HTML_LOGIN);
    }

    if (req.method === 'POST') {
      let cuerpo = '';
      req.on('data', c => { cuerpo += c; });
      req.on('end', () => {
        estado.posts.push({ url: req.url, cuerpo, cookie: req.headers.cookie || '' });
        res.writeHead(302, { location: 'index.php?module=Home&action=index', 'set-cookie': 'PHPSESSID=sess-e2e; Path=/' });
        res.end();
      });
      return;
    }

    if (u.searchParams.get('module') === 'Home') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(rechazaLogin ? HTML_LOGIN : HTML_INTERNO);
    }

    if (u.searchParams.get('view') === 'Detail') {
      estado.detalles++;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><a href="index.php?module=SalesOrder&action=ExportPDF&record=6x1&folderid=7">PDF</a></html>');
    }

    if (u.searchParams.get('action') === 'ExportPDF') {
      if (u.searchParams.get('folderid') === '7') {
        estado.pdfs++;
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end(PDF);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>sin plantilla</html>');
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('ruta no simulada');
  });

  return { server, estado };
}

// ------------------------------------------------------------------------------
// Servidor GHL real (Media Library + contactos + tags + campos)
// ------------------------------------------------------------------------------
function crearGhlFalso({ contactos = {} } = {}) {
  const estado = {
    contactos: JSON.parse(JSON.stringify(contactos)),
    subidas: [],
    puts: [],
    tags: [],
    lecturas: 0,
    auths: []
  };

  const server = http.createServer((req, res) => {
    const trozos = [];
    req.on('data', c => trozos.push(c));
    req.on('end', () => {
      const cuerpo = Buffer.concat(trozos);
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;
      estado.auths.push(req.headers.authorization || '');

      const json = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (p === '/medias/upload-file' && req.method === 'POST') {
        estado.subidas.push({
          bytes: cuerpo.length,
          locationId: u.searchParams.get('locationId'),
          auth: req.headers.authorization || '',
          tipo: req.headers['content-type'] || '',
          crudo: cuerpo.toString('latin1')
        });
        // Permite simular un fallo de la Media Library (TEST 6).
        if (estado.fallarSubida) return json({ message: 'boom en la Media Library' }, 500);
        return json({ fileId: 'file_e2e', url: `http://${req.headers.host}/cdn/factura.pdf` });
      }

      const mContacto = /^\/contacts\/([^/]+)$/.exec(p);
      const mTags = /^\/contacts\/([^/]+)\/tags$/.exec(p);
      const mLookup = p === '/contacts/lookup';
      const mCampos = /^\/locations\/([^/]+)\/customFields$/.exec(p);

      if (mLookup && req.method === 'GET') {
        const tel = u.searchParams.get('phone') || '';
        return json({ contact: { id: tel.includes('9999') ? 'contacto-cli' : 'contacto-e2e' } });
      }

      if (mCampos && req.method === 'GET') {
        return json({ customFields: [
          { id: 'F_URL', name: 'URL Factura PDF', fieldKey: 'contact.url_factura_pdf' },
          { id: 'F_NUM', name: 'Factura Nº Orden', fieldKey: 'contact.factura_numero_orden' }
        ] });
      }

      if (mTags && req.method === 'POST') {
        const { tags = [] } = JSON.parse(cuerpo.toString('utf8') || '{}');
        const id = mTags[1];
        estado.tags.push({ id, tags });
        estado.contactos[id] = estado.contactos[id] || { id, customFields: [], tags: [] };
        estado.contactos[id].tags = [...new Set([...(estado.contactos[id].tags || []), ...tags])];
        return json({}, 201);
      }

      if (mContacto && req.method === 'GET') {
        estado.lecturas++;
        const id = mContacto[1];
        const c = estado.contactos[id];
        if (!c) return json({ message: 'contacto no encontrado' }, 404);
        return json({ contact: c });
      }

      if (mContacto && req.method === 'PUT') {
        const id = mContacto[1];
        const { customFields = [] } = JSON.parse(cuerpo.toString('utf8') || '{}');
        estado.puts.push({ id, customFields });
        estado.contactos[id] = estado.contactos[id] || { id, customFields: [], tags: [] };
        for (const campo of customFields) {
          estado.contactos[id].customFields = (estado.contactos[id].customFields || []).filter(f => f.id !== campo.id);
          estado.contactos[id].customFields.push({ id: campo.id, value: campo.field_value });
        }
        return json({}, 200);
      }

      return json({ message: `ruta no simulada: ${req.method} ${p}` }, 404);
    });
  });

  return { server, estado };
}

function escuchar(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function cerrar(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(' [TEST] INTEGRACION END-TO-END POR HTTP REAL (vTiger + GHL)');
console.log('==========================================================\n');

const vt = crearVtigerFalso();
const ghl = crearGhlFalso({ contactos: { 'contacto-e2e': { id: 'contacto-e2e', customFields: [], tags: [] }, 'contacto-cli': { id: 'contacto-cli', customFields: [], tags: [] } } });
const puertoVt = await escuchar(vt.server);
const puertoGhl = await escuchar(ghl.server);

// Entorno: los modulos lo leen en tiempo de ejecucion.
process.env.VTIGER_URL = `http://127.0.0.1:${puertoVt}`;
process.env.VTIGER_WEB_USERNAME = 'usuario-web';
process.env.VTIGER_WEB_PASSWORD = 'clave-web';
process.env.GHL_BASE_URL = `http://127.0.0.1:${puertoGhl}`;
process.env.GHL_API_KEY_CENTRAL = PIT;
process.env.GHL_LOCATION_ID_CENTRAL = LOC;
process.env.INVOICE_PDF_ENABLED = 'true';
process.env.INVOICE_LOG_DIR = path.join(TMP, 'logs');

const { publicarFacturaDeContacto } = await import('../src/core/invoice_publisher.js');
const { CLAVES_PUENTE_FACTURA } = await import('../src/core/invoice_bridge.js');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Publicacion completa contra servidores HTTP reales');
const r1 = await publicarFacturaDeContacto({
  contactId: 'contacto-e2e',
  orden: { id: '6x1', numeroOrden: 'G-04212158' },
  sede: 'PALACIOS'
});

assert(r1.publicado === true, `La factura se publica (motivo: ${r1.motivo})`);
assert(r1.url === `http://127.0.0.1:${puertoGhl}/cdn/factura.pdf`, 'Devuelve la URL publica real del servidor');
assert(r1.fileId === 'file_e2e', 'Devuelve el fileId de la Media Library');
// VIA B: el invoice se GENERA en el motor. El canal web de vTiger no se toca
// (verificado contra la instancia real: vTiger no tiene plantilla PDF para estas ordenes).
assert(vt.estado.logins === 0, `NO se loguea en vTiger: el PDF se genera localmente (recibido: ${vt.estado.logins})`);
assert(vt.estado.pdfs === 0, 'NO se descarga ningun PDF de vTiger');
assert(vt.estado.posts.length === 0, 'NO hay POST al canal web de vTiger');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] El PDF llega integro por multipart a la Media Library');
assert(ghl.estado.subidas.length === 1, 'Se sube exactamente un archivo');
const subida = ghl.estado.subidas[0];
assert(/%PDF-1\./.test(subida.crudo), 'El cuerpo multipart contiene un PDF real (pdfkit genera %PDF-1.3)');
assert(subida.crudo.includes('factura_G-04212158.pdf'), 'El nombre del archivo viaja en el multipart');
assert(/multipart\/form-data;\s*boundary=/.test(subida.tipo), 'Usa multipart/form-data con boundary');
assert(subida.locationId === LOC, 'Sube a la location de la Cuenta Empresa');
assert(subida.auth === `Bearer ${PIT}`, 'Autentica con el PIT de la Cuenta Empresa');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] El puente queda escrito en el contacto (campos + tag)');
assert(ghl.estado.puts.length === 1, 'Se marca el contacto una vez');
const campos = ghl.estado.puts[0].customFields;
assert(campos.find(c => c.id === 'F_URL')?.field_value === r1.url, 'Escribe la URL en el campo resuelto por NOMBRE (URL Factura PDF)');
assert(campos.find(c => c.id === 'F_NUM')?.field_value === 'G-04212158', 'Escribe el numero de orden (idempotencia)');
assert(ghl.estado.tags.length === 1 && ghl.estado.tags[0].tags.includes('FACTURA_LISTA'), 'Agrega el tag FACTURA_LISTA que dispara el workflow');
assert(ghl.estado.auths.every(a => a === `Bearer ${PIT}`), 'Todas las llamadas a GHL usan el PIT de la Cuenta Empresa');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Idempotencia por HTTP: la segunda pasada no toca nada');
const subidasAntes = ghl.estado.subidas.length;
const putsAntes = ghl.estado.puts.length;
const r2 = await publicarFacturaDeContacto({ contactId: 'contacto-e2e', orden: { id: '6x1', numeroOrden: 'G-04212158' }, sede: 'PALACIOS' });
assert(r2.publicado === false && r2.motivo === 'YA_PUBLICADA', `Segunda pasada -> YA_PUBLICADA (recibido: ${r2.motivo})`);
assert(ghl.estado.subidas.length === subidasAntes && ghl.estado.puts.length === putsAntes, 'NO se vuelve a subir ni a marcar el contacto');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] El CLI completo, de punta a punta, contra los servidores HTTP');
const salidaCli = await new Promise((resolve) => {
  // ASINCRONO a proposito: con `execFileSync` el event loop de ESTE proceso queda
  // bloqueado y los servidores falsos (que viven aqui) no podrian responder.
  execFile(process.execPath, [CLI, 'publish', '--contact=contacto-cli', '--order=6x1', '--numero=G-777'], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      VTIGER_URL: `http://127.0.0.1:${puertoVt}`,
      VTIGER_WEB_USERNAME: 'usuario-web',
      VTIGER_WEB_PASSWORD: 'clave-web',
      GHL_BASE_URL: `http://127.0.0.1:${puertoGhl}`,
      GHL_API_KEY_CENTRAL: PIT,
      GHL_LOCATION_ID_CENTRAL: LOC,
      INVOICE_PDF_ENABLED: 'true'
    }
  }, (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
});
assert(/"publicado": true/.test(salidaCli), 'El CLI reporta la publicacion exitosa');
if (!/"publicado": true/.test(salidaCli)) console.log(`    [DIAG CLI] ${salidaCli.replace(/\s+/g, ' ').slice(0, 700)}`);
assert(/G-777/.test(salidaCli), 'El CLI informa el numero de orden publicado');
const contactoCli = ghl.estado.contactos['contacto-cli'];
assert(contactoCli.customFields.find(c => c.id === 'F_NUM')?.value === 'G-777', 'El CLI dejo el numero de orden en el contacto');
assert(contactoCli.tags.includes('FACTURA_LISTA'), 'El CLI agrego el tag que dispara el workflow');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Fallo de la Media Library: no se marca el contacto (no se dispara el workflow)');
// En la Via B el PDF se genera localmente, asi que el fallo relevante ya no son
// las credenciales web sino la PUBLICACION: si GHL rechaza la subida, el contacto
// no debe quedar marcado (y por lo tanto el cliente no recibe nada).
process.env.VTIGER_URL = `http://127.0.0.1:${puertoVt}`;
ghl.estado.fallarSubida = true;
const subidasAntes6 = ghl.estado.subidas.length;
const r6 = await publicarFacturaDeContacto({ contactId: 'contacto-cli', orden: { id: '6x9', numeroOrden: 'G-999' } });
assert(r6.publicado === false && r6.motivo === 'MEDIA_NO_DISPONIBLE', `Sin URL publica no se publica (recibido: ${r6.motivo})`);
assert(ghl.estado.subidas.length === subidasAntes6 + 1, 'Se intento subir el PDF una vez');
assert(ghl.estado.contactos['contacto-cli'].customFields.every(c => c.value !== 'G-999'), 'El contacto NO queda marcado si la publicacion falla');
ghl.estado.fallarSubida = false;

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Fail-safe: servidor de GHL caido');
await cerrar(ghl.server);
process.env.VTIGER_URL = `http://127.0.0.1:${puertoVt}`;
const r7 = await publicarFacturaDeContacto({ contactId: 'contacto-e2e', orden: { id: '6x10', numeroOrden: 'G-1010' } });
assert(r7.publicado === false, 'Con GHL caido no se publica');
assert(['CONTACTO_ILEGIBLE', 'MEDIA_NO_DISPONIBLE', 'ESCRITURA_FALLIDA'].includes(r7.motivo), `El motivo es explicito y no lanza (recibido: ${r7.motivo})`);

// ------------------------------------------------------------------------------
await cerrar(vt.server);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
