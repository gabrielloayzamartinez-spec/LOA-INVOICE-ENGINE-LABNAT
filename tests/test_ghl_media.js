/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE LA MEDIA LIBRARY DE GHL (publicacion del PDF)
 * ==============================================================================
 * Prueba la subida del PDF con un `fetch` simulado: multipart correcto, lectura
 * de la URL publica, y TODOS los modos de fallo (401 token invalido, 403 scope
 * faltante, 5xx, respuesta sin URL, caida de red, parametros incompletos).
 *
 * Cero red real: no se sube nada a GHL.
 *
 * Ejecucion:  node src/tests/test_ghl_media.js
 * ==============================================================================
 */

import {
  subirPdfAMediaLibrary, verificarAccesoMedia, headersMedia, construirFormDataPdf,
  extraerUrlDeRespuestaMedia, MOTIVOS_MEDIA, GHL_API_VERSION
} from '../src/connectors/ghl_media.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const LOC = 'ATPYNnsfZ1W8sd6WgWIV';
const KEY = 'pit-de-prueba';

function respuestaGhl(cuerpo, { status = 200, tipo = 'application/json' } = {}) {
  return new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': tipo }
  });
}

/** Doble de prueba que registra cada peticion. */
function fetchFalso(responder) {
  const llamadas = [];
  const impl = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), method: (opciones.method || 'GET').toUpperCase(), headers: opciones.headers || {}, body: opciones.body || null });
    return responder(String(url), opciones);
  };
  return { impl, llamadas };
}

console.log('\n==========================================================');
console.log(' [TEST] MEDIA LIBRARY DE GHL (publicacion del PDF)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Cabeceras de la API v2');
const h = headersMedia(KEY);
assert(h.Authorization === `Bearer ${KEY}`, 'Envia el PIT como Bearer');
assert(h.Version === GHL_API_VERSION, `Declara la version ${GHL_API_VERSION}`);
assert(h['Content-Type'] === undefined, 'NO fuerza Content-Type (el multipart pone su boundary)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Construccion del multipart');
const form = construirFormDataPdf({ nombreArchivo: 'factura_G-04212158.pdf', contenido: PDF });
assert(form instanceof FormData, 'Devuelve un FormData');
const archivo = form.get('file');
assert(archivo && archivo.name === 'factura_G-04212158.pdf', 'El archivo conserva el nombre (no queda como "blob")');
assert(archivo && archivo.type === 'application/pdf', 'Declara el tipo application/pdf');
assert(archivo && archivo.size === PDF.length, 'Adjunta el contenido completo del PDF');
assert(form.get('name') === 'factura_G-04212158.pdf', 'Envia tambien el campo name');
let lanzo = false;
try { construirFormDataPdf({ nombreArchivo: '', contenido: null }); } catch (e) { lanzo = e instanceof TypeError; }
assert(lanzo, 'Sin contenido/nombre lanza TypeError (error de programacion)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Lectura tolerante de la respuesta de GHL');
assert(extraerUrlDeRespuestaMedia({ url: 'https://cdn/x.pdf' }).url === 'https://cdn/x.pdf', 'Lee {url}');
assert(extraerUrlDeRespuestaMedia({ fileId: 'f1', url: 'https://cdn/y.pdf' }).fileId === 'f1', 'Lee {fileId}');
assert(extraerUrlDeRespuestaMedia({ meta: { url: 'https://cdn/z.pdf' } }).url === 'https://cdn/z.pdf', 'Lee la forma anidada {meta.url}');
assert(extraerUrlDeRespuestaMedia(null).url === null, 'Una respuesta nula devuelve url null (no rompe)');
assert(extraerUrlDeRespuestaMedia('texto plano').url === null, 'Una respuesta no-objeto devuelve url null');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Subida exitosa');
const ok = fetchFalso(() => respuestaGhl({ fileId: 'file_123', url: 'https://cdn.ghl.test/factura_G-04212158.pdf' }));
const rOk = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'factura_G-04212158.pdf', contenido: PDF, apiKey: KEY, fetchImpl: ok.impl });
assert(rOk.ok === true, 'La subida se reporta OK');
assert(rOk.url === 'https://cdn.ghl.test/factura_G-04212158.pdf', 'Devuelve la URL publica del PDF');
assert(rOk.fileId === 'file_123', 'Devuelve el fileId');
assert(rOk.motivo === MOTIVOS_MEDIA.OK, 'El motivo es OK');
const pet = ok.llamadas[0];
assert(pet.method === 'POST', 'Usa POST');
assert(pet.url.includes('/medias/upload-file') && pet.url.includes(`locationId=${LOC}`), 'Llama al endpoint correcto con el locationId');
assert(pet.headers.Authorization === `Bearer ${KEY}`, 'Autentica con el PIT de la cuenta destino');
assert(pet.body instanceof FormData, 'Envia el cuerpo como multipart');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Modos de fallo (fail-safe: nunca lanza)');
const f401 = fetchFalso(() => respuestaGhl({ statusCode: 401, message: 'Invalid Private Integration token' }, { status: 401 }));
const r401 = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: f401.impl });
assert(r401.ok === false && r401.motivo === MOTIVOS_MEDIA.TOKEN_INVALIDO, 'Un 401 se diagnostica como TOKEN_INVALIDO');
assert(r401.status === 401, 'Reporta el status HTTP');

const f403 = fetchFalso(() => respuestaGhl({ statusCode: 403, message: 'Forbidden' }, { status: 403 }));
const r403 = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: f403.impl });
assert(r403.ok === false && r403.motivo === MOTIVOS_MEDIA.SCOPE_FALTANTE, 'Un 403 se diagnostica como SCOPE_FALTANTE (medias.write)');

const f500 = fetchFalso(() => respuestaGhl({ message: 'boom' }, { status: 500 }));
const r500 = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: f500.impl });
assert(r500.ok === false && r500.motivo === MOTIVOS_MEDIA.RECHAZADO, 'Un 5xx se diagnostica como RECHAZADO');
assert(String(r500.detalle).includes('boom'), 'Conserva el detalle del error para la auditoria');

const fSinUrl = fetchFalso(() => respuestaGhl({ fileId: 'x' }));
const rSinUrl = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: fSinUrl.impl });
assert(rSinUrl.ok === false && rSinUrl.motivo === MOTIVOS_MEDIA.RESPUESTA_SIN_URL, 'Una respuesta sin URL se rechaza (no se publica un enlace vacio)');

const fRed = fetchFalso(() => { throw new Error('ECONNRESET'); });
const rRed = await subirPdfAMediaLibrary({ locationId: LOC, nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: fRed.impl });
assert(rRed.ok === false && rRed.motivo === MOTIVOS_MEDIA.ERROR_RED, 'Una caida de red se reporta como ERROR_RED sin lanzar');

const fNada = fetchFalso(() => respuestaGhl({}));
const rParams = await subirPdfAMediaLibrary({ locationId: '', nombreArchivo: 'f.pdf', contenido: PDF, apiKey: KEY, fetchImpl: fNada.impl });
assert(rParams.ok === false && rParams.motivo === MOTIVOS_MEDIA.PARAMS, 'Parametros incompletos -> PARAMS_INCOMPLETOS');
assert(fNada.llamadas.length === 0, 'Con parametros incompletos NO se toca la red');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Verificacion de acceso (diagnostico de scopes)');
const fOk = fetchFalso(() => respuestaGhl({ files: [] }));
const vOk = await verificarAccesoMedia({ locationId: LOC, apiKey: KEY, fetchImpl: fOk.impl });
assert(vOk.ok === true, 'Con scope medias.read el acceso se verifica OK');
assert(fOk.llamadas[0].method === 'GET', 'La verificacion es de solo lectura (GET)');
assert(/type=file/.test(fOk.llamadas[0].url), 'La verificacion incluye el parametro obligatorio `type` (GHL responde 422 sin el)');
const fNo = fetchFalso(() => respuestaGhl({ statusCode: 401 }, { status: 401 }));
const vNo = await verificarAccesoMedia({ locationId: LOC, apiKey: KEY, fetchImpl: fNo.impl });
assert(vNo.ok === false && vNo.motivo === MOTIVOS_MEDIA.TOKEN_INVALIDO, 'Con token invalido lo reporta sin romper');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
