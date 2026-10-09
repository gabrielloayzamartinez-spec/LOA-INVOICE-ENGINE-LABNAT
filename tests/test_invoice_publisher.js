/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE INTEGRACION DEL PUBLICADOR DE FACTURAS
 * ==============================================================================
 * Prueba el flujo COMPLETO de punta a punta con un `fetch` simulado que
 * reproduce vTiger (login + ExportPDF) y GHL (Media Library + contacto + tags):
 *
 *   login vTiger -> ExportPDF (PDF) -> Media Library (URL) -> PUT contacto
 *   -> POST tags FACTURA_LISTA
 *
 * Y la garantia critica: una SEGUNDA pasada no descarga, no sube y no marca
 * nada (el cliente no recibe dos mensajes).
 *
 * Cero red real: no se toca vTiger ni GHL.
 *
 * Ejecucion:  node src/tests/test_invoice_publisher.js
 * ==============================================================================
 */

import { crearDepsFactura, publicarFacturaDeContacto, headersCentral, NOMBRES_CAMPOS_FACTURA } from '../src/core/invoice_publisher.js';
import { crearClienteSesionWeb } from '../src/connectors/vtiger_web_session.js';
import { CLAVES_PUENTE_FACTURA, TAG_FACTURA_LISTA } from '../src/core/invoice_bridge.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const VTIGER = 'https://vtiger.ejemplo.test';
const GHL = 'https://services.leadconnectorhq.com';
const LOC = 'ATPYNnsfZ1W8sd6WgWIV';
const KEY = 'pit-central-de-prueba';
const CONTACT_ID = 'contacto123';
const ORDEN = { id: '6x35385', numeroOrden: 'G-04212158' };
const FIELD_IDS = { [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'F_URL', [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: 'F_NUM' };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

const HTML_LOGIN = `<html><body><form method="POST" action="index.php">
  <input type="hidden" name="__vtrftk" value="sid:abc123:999">
  <input type="hidden" name="module" value="Users">
  <input type="hidden" name="action" value="Login">
  <input type="text" name="username"><input type="password" name="password">
</form></body></html>`;
const HTML_INTERNO = '<html><body><a href="index.php?module=Users&action=Logout">Logout</a></body></html>';

function resp(cuerpo, { status = 200, setCookies = [], tipo = 'application/json' } = {}) {
  // `Response` solo acepta texto/binario: los objetos se serializan aqui.
  const body = (typeof cuerpo === 'string' || cuerpo instanceof Uint8Array || cuerpo instanceof ArrayBuffer)
    ? cuerpo
    : JSON.stringify(cuerpo);
  const h = new Headers({ 'content-type': tipo });
  for (const c of setCookies) h.append('set-cookie', c);
  return new Response(body, { status, headers: h });
}

/** Entorno simulado de vTiger + GHL con estado mutable del contacto. */
function crearEntorno({ contactoInicial = { id: CONTACT_ID, customFields: [], tags: [] }, contactoStatus = 200 } = {}) {
  const llamadas = [];
  const estado = { contacto: JSON.parse(JSON.stringify(contactoInicial)) };

  const fetchImpl = async (url, opciones = {}) => {
    const u = String(url);
    const metodo = (opciones.method || 'GET').toUpperCase();
    llamadas.push({ url: u, metodo, body: opciones.body || null, headers: opciones.headers || {} });

    // ---------------------------- vTiger ----------------------------
    if (u.startsWith(VTIGER)) {
      if (/module=Users&action=Login/.test(u)) return resp(HTML_LOGIN, { setCookies: ['PHPSESSID=sess1; path=/'], tipo: 'text/html' });
      if (/module=Home&action=index/.test(u)) return resp(HTML_INTERNO, { tipo: 'text/html' });
      if (/view=Detail/.test(u)) return resp('<html><a href="index.php?module=SalesOrder&action=ExportPDF&record=6x35385&folderid=7">PDF</a></html>', { tipo: 'text/html' });
      if (/action=ExportPDF/.test(u)) {
        return /folderid=7/.test(u)
          ? resp(new Uint8Array(PDF), { tipo: 'application/pdf' })
          : resp('<html>sin plantilla</html>', { tipo: 'text/html' });
      }
      if (metodo === 'POST') return resp('', { status: 302, setCookies: ['PHPSESSID=sess1; path=/'] });
      return resp('<html>?</html>', { status: 404, tipo: 'text/html' });
    }

    // ----------------------------- GHL ------------------------------
    if (u.includes('/medias/upload-file')) {
      return resp({ fileId: 'file_99', url: 'https://cdn.ghl.test/factura_G-04212158.pdf' });
    }
    if (u.includes(`/contacts/${CONTACT_ID}/tags`) && metodo === 'POST') {
      const tags = JSON.parse(String(opciones.body || '{}')).tags || [];
      estado.contacto.tags = [...new Set([...(estado.contacto.tags || []), ...tags])];
      return resp({}, { status: 201 });
    }
    if (u.includes(`/contacts/${CONTACT_ID}`) && metodo === 'PUT') {
      if (contactoStatus !== 200) return resp({ message: 'contacto no encontrado' }, { status: contactoStatus });
      const campos = JSON.parse(String(opciones.body || '{}')).customFields || [];
      for (const c of campos) {
        estado.contacto.customFields = (estado.contacto.customFields || []).filter(f => f.id !== c.id);
        estado.contacto.customFields.push({ id: c.id, value: c.field_value });
      }
      return resp({}, { status: 200 });
    }
    if (u.includes(`/contacts/${CONTACT_ID}`) && metodo === 'GET') {
      if (contactoStatus !== 200) return resp({ message: 'contacto no encontrado' }, { status: contactoStatus });
      return resp({ contact: estado.contacto });
    }

    return resp({ message: `sin ruta simulada: ${metodo} ${u}` }, { status: 404 });
  };

  const cuenta = (fragmento, metodo = null) => llamadas.filter(l => l.url.includes(fragmento) && (!metodo || l.metodo === metodo)).length;
  return { fetchImpl, llamadas, estado, cuenta };
}

function depsDe(entorno) {
  return crearDepsFactura({
    apiKeyCentral: KEY,
    locationIdCentral: LOC,
    fetchImpl: entorno.fetchImpl,
    clienteSesionWeb: crearClienteSesionWeb({ baseUrl: VTIGER, username: 'usuario_web', password: 'clave_web', fetchImpl: entorno.fetchImpl })
  });
}

console.log('\n==========================================================');
console.log(' [TEST] INTEGRACION: PUBLICADOR DE FACTURAS (vTiger + GHL)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Contrato de nombres de los campos puente');
assert(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.urlFacturaPdf] === 'URL Factura PDF', 'El campo de URL se llama "URL Factura PDF"');
assert(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.facturaNumeroOrden] === 'Factura Nº Orden', 'El campo de idempotencia se llama "Factura Nº Orden"');
assert(headersCentral(KEY).Authorization === `Bearer ${KEY}`, 'El conector usa el PIT de la cuenta destino');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Flujo completo: vTiger -> PDF -> Media Library -> contacto');
const env1 = crearEntorno();
const r1 = await publicarFacturaDeContacto({
  contactId: CONTACT_ID, orden: ORDEN, apiKeyCentral: KEY, locationIdCentral: LOC,
  fieldIds: FIELD_IDS, habilitado: true, sede: 'PALACIOS', fetchImpl: env1.fetchImpl, deps: depsDe(env1)
});
assert(r1.publicado === true, `El flujo completo termina publicado (motivo: ${r1.motivo})`);
if (!r1.publicado) console.log(`    [DIAG] motivo=${r1.motivo} detalle=${r1.detalle} llamadas=${env1.llamadas.map(l => l.metodo + ' ' + l.url).join(' | ')}`);
assert(r1.url === 'https://cdn.ghl.test/factura_G-04212158.pdf', 'Se publica la URL devuelta por la Media Library');
assert(env1.cuenta('module=Users&action=Login') === 0, 'NO se loguea en vTiger: el invoice se genera localmente (Via B)');
assert(env1.cuenta('action=ExportPDF') === 0, 'NO se descarga ningun PDF de vTiger');
assert(env1.cuenta('/medias/upload-file', 'POST') === 1, 'Se sube el PDF una vez a la Media Library');
assert(env1.cuenta(`/contacts/${CONTACT_ID}`, 'PUT') === 1, 'Se marcan los campos en el contacto');
assert(env1.cuenta(`/contacts/${CONTACT_ID}/tags`, 'POST') === 1, 'Se agrega el tag que dispara el workflow');

const put = env1.llamadas.find(l => l.metodo === 'PUT');
const camposEscritos = JSON.parse(String(put.body)).customFields;
assert(camposEscritos.find(c => c.id === 'F_URL')?.field_value === r1.url, 'El contacto queda con la URL de la factura');
assert(camposEscritos.find(c => c.id === 'F_NUM')?.field_value === 'G-04212158', 'El contacto queda con el numero de orden');
const tagsEscritos = JSON.parse(String(env1.llamadas.find(l => l.url.includes('/tags')).body)).tags;
assert(tagsEscritos.includes(TAG_FACTURA_LISTA), `El tag enviado es ${TAG_FACTURA_LISTA}`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] El PDF que llega a GHL es el invoice GENERADO por el motor');
const subida = env1.llamadas.find(l => l.url.includes('/medias/upload-file'));
const archivo = subida.body.get('file');
assert(archivo.size > 1000, `El archivo subido es un PDF con contenido real (${archivo.size} bytes)`);
assert(archivo.name === 'factura_G-04212158.pdf', 'El archivo subido tiene nombre legible');
assert(subida.body.get('name') === 'factura_G-04212158.pdf', 'El multipart incluye el campo name');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] IDEMPOTENCIA: la segunda pasada no toca nada');
const r2 = await publicarFacturaDeContacto({
  contactId: CONTACT_ID, orden: ORDEN, apiKeyCentral: KEY, locationIdCentral: LOC,
  fieldIds: FIELD_IDS, habilitado: true, fetchImpl: env1.fetchImpl, deps: depsDe(env1)
});
assert(r2.publicado === false && r2.motivo === 'YA_PUBLICADA', `Segunda pasada -> YA_PUBLICADA (recibido: ${r2.motivo})`);
assert(env1.cuenta('/medias/upload-file', 'POST') === 1, 'NO se vuelve a subir el archivo');
assert(env1.cuenta(`/contacts/${CONTACT_ID}`, 'PUT') === 1, 'NO se reescribe el contacto (el cliente no recibe 2 mensajes)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Recompra: una orden nueva si se publica');
const r3 = await publicarFacturaDeContacto({
  contactId: CONTACT_ID, orden: { id: '7x777', numeroOrden: 'G-04212160' }, apiKeyCentral: KEY,
  locationIdCentral: LOC, fieldIds: FIELD_IDS, habilitado: true, fetchImpl: env1.fetchImpl, deps: depsDe(env1)
});
assert(r3.publicado === true, 'Una orden nueva del mismo cliente se publica (recompra)');
assert(env1.cuenta('/medias/upload-file', 'POST') === 2, 'Se sube el PDF de la nueva orden');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Modos de fallo del conector (nunca lanza)');
const env2 = crearEntorno();
const rSinCred = await publicarFacturaDeContacto({ contactId: CONTACT_ID, orden: ORDEN, apiKeyCentral: '', locationIdCentral: '', habilitado: true, fetchImpl: env2.fetchImpl, deps: depsDe(env2) });
assert(rSinCred.motivo === 'CUENTA_EMPRESA_NO_CONFIGURADA', 'Sin credenciales de la Empresa -> CUENTA_EMPRESA_NO_CONFIGURADA');
assert(env2.llamadas.length === 0, 'Sin credenciales no se toca la red');

const env3 = crearEntorno({ contactoStatus: 404 });
const rIlegible = await publicarFacturaDeContacto({ contactId: CONTACT_ID, orden: ORDEN, apiKeyCentral: KEY, locationIdCentral: LOC, fieldIds: FIELD_IDS, habilitado: true, fetchImpl: env3.fetchImpl, deps: depsDe(env3) });
assert(rIlegible.motivo === 'CONTACTO_ILEGIBLE', 'Contacto inexistente -> CONTACTO_ILEGIBLE (no se publica a ciegas)');
assert(env3.cuenta('action=ExportPDF') === 0, 'Si el contacto no existe, ni siquiera se descarga el PDF');

const env4 = crearEntorno();
const rApagado = await publicarFacturaDeContacto({ contactId: CONTACT_ID, orden: ORDEN, apiKeyCentral: KEY, locationIdCentral: LOC, fieldIds: FIELD_IDS, habilitado: false, fetchImpl: env4.fetchImpl, deps: depsDe(env4) });
assert(rApagado.motivo === 'DESACTIVADO', 'Con el flag apagado no se publica');
assert(env4.cuenta('action=ExportPDF') === 0, 'Flag apagado: cero llamadas a vTiger');
const getContacto = env4.llamadas.filter(l => l.metodo === 'GET' && l.url.includes(`/contacts/${CONTACT_ID}`)).length;
assert(getContacto === 1, 'Con el flag apagado solo se lee el contacto (no se escribe nada)');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
