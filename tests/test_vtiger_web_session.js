/**
 * ==============================================================================
 * LOA ENGINE - SUITE DE LA SESION WEB DE VTIGER (descarga del PDF oficial)
 * ==============================================================================
 * Se prueba la MECANICA COMPLETA con un `fetch` simulado: CSRF, cookies,
 * single-flight del login, cache de sesion, renovacion por sesion caida,
 * descubrimiento del `folderid` y validacion de los bytes %PDF.
 *
 * Cero red, cero vTiger real, cero credenciales: el doble de prueba reproduce
 * el HTML y las cabeceras REALES ya inspeccionados del servidor.
 *
 * Ejecucion:  node tests/test_vtiger_web_session.js
 * ==============================================================================
 */

import {
  crearClienteSesionWeb, assertAccionWebPermitida, extraerDatosFormularioLogin,
  esPantallaDeLogin, extraerSetCookie, aplicarCookies, construirCabeceraCookie,
  extraerFolderIdsPdf, esPdf, getVtigerWebConfigStatus, VtigerWebActionViolation,
  normalizarRecordExportPdf
} from '../src/connectors/vtiger_web_session.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const BASE = 'https://vtiger.ejemplo.test';

// HTML REAL de la pantalla de login (vTiger 7: form POST a index.php + __vtrftk).
const HTML_LOGIN = `
<html><body>
  <form class="form-horizontal" method="POST" action="index.php">
    <input type="hidden" name="__vtrftk" value="sid:9c113824abcdef:1234567890">
    <input type="hidden" name="module" value="Users">
    <input type="hidden" name="action" value="Login">
    <input type="text" name="username" id="username" placeholder="Username">
    <input type="password" name="password" id="password" placeholder="Password">
  </form>
  <form class="form-horizontal" action="forgotPassword.php" method="POST">
    <input type="hidden" name="__vtrftk" value="sid:9c113824abcdef:1234567890">
    <input type="text" name="username" id="fusername">
  </form>
</body></html>`;

// Pagina interna (sesion activa): NO debe tener input de contrasena.
const HTML_INTERNO = `<html><body><div id="app"><a href="index.php?module=Users&action=Logout">Logout</a>
  <span>Home</span></div></body></html>`;

const PDF_MINIMO = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

function respuesta(cuerpo, { status = 200, setCookies = [], tipo = 'text/html; charset=UTF-8' } = {}) {
  const headers = new Headers({ 'content-type': tipo });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(cuerpo, { status, headers });
}

/** Doble de prueba de vTiger: reproduce el ciclo login -> detalle -> ExportPDF. */
function crearVtigerFalso({ pdfTrasLoginCaido = false } = {}) {
  const llamadas = [];
  let loginsGet = 0;
  let pdfConFolder = 0;
  let pdfSinFolder = 0;
  let exportTrasCaida = 0;
  let sesionCaida = false;

  const fetchImpl = async (url, init = {}) => {
    llamadas.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), cookie: init.headers?.Cookie || '', body: init.body || null });

    if (/module=Users&action=Login/.test(url)) {
      loginsGet++;
      return respuesta(HTML_LOGIN, { setCookies: ['PHPSESSID=abc123; path=/', 'vtiger_language=es; path=/'] });
    }
    if (/module=Home&action=index/.test(url)) return respuesta(HTML_INTERNO);
    if (/view=Detail/.test(url)) return respuesta(`<html><a href="index.php?module=SalesOrder&action=ExportPDF&record=6x35385&folderid=7">PDF</a></html>`);

    if (/action=ExportPDF/.test(url)) {
      if (sesionCaida && pdfTrasLoginCaido && exportTrasCaida === 0) {
        exportTrasCaida++;
        return respuesta(HTML_LOGIN); // sesion expirada a mitad de camino
      }
      // El PDF OFICIAL sale cuando la URL lleva `app` (como la usa la interfaz).
      if (/app=MARKETING/.test(url)) { pdfConFolder++; return respuesta(new Uint8Array(PDF_MINIMO), { tipo: 'application/pdf' }); }
      if (/folderid=7/.test(url)) { pdfConFolder++; return respuesta(new Uint8Array(PDF_MINIMO), { tipo: 'application/pdf' }); }
      pdfSinFolder++;
      return respuesta('<html>No PDF template</html>');
    }

    if (init.method === 'POST') return respuesta('', { status: 302, setCookies: ['PHPSESSID=abc123; path=/'] });
    return respuesta('<html>?</html>', { status: 404 });
  };

  return {
    fetchImpl, llamadas,
    contar: () => ({ loginsGet, pdfConFolder, pdfSinFolder, exportTrasCaida }),
    marcarSesionCaida: () => { sesionCaida = true; }
  };
}

console.log('\n==========================================================');
console.log(' [TEST] SESION WEB DE VTIGER (PDF oficial de factura)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Candado de solo lectura del canal web (allow-list cerrada)');
for (const ok of ['Login', 'ExportPDF', 'Detail', 'index', 'login', 'EXPORTPDF']) {
  let paso = true;
  try { assertAccionWebPermitida(ok); } catch { paso = false; }
  assert(paso, `Permite la accion de lectura '${ok}'`);
}
for (const prohibida of ['Save', 'Edit', 'Delete', 'MassEdit', 'Import', 'update']) {
  let lanzo = false;
  try { assertAccionWebPermitida(prohibida); } catch (e) { lanzo = e instanceof VtigerWebActionViolation; }
  assert(lanzo, `BLOQUEA la accion de escritura '${prohibida}' antes de tocar la red`);
}

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Parseo del formulario de login real');
const form = extraerDatosFormularioLogin(HTML_LOGIN);
assert(form.tieneFormulario === true, 'Detecta el formulario de login');
assert(form.method === 'POST', 'Lee el metodo POST');
assert(form.action === 'index.php', 'Lee el action index.php');
assert(form.ocultos.__vtrftk === 'sid:9c113824abcdef:1234567890', 'Extrae el token CSRF __vtrftk');
assert(form.ocultos.module === 'Users' && form.ocultos.action === 'Login', 'Extrae los campos ocultos module/action');
assert(extraerDatosFormularioLogin('<html>sin formulario</html>').tieneFormulario === false, 'Sin formulario no inventa datos');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Deteccion de pantalla de login (sesion caida)');
assert(esPantallaDeLogin(HTML_LOGIN) === true, 'El HTML de login se detecta como login');
assert(esPantallaDeLogin(HTML_INTERNO) === false, 'Una pagina interna NO se confunde con el login');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Manejo de cookies (jar)');
const jar = new Map();
aplicarCookies(jar, respuesta('', { setCookies: ['PHPSESSID=abc123; path=/', 'vtiger_language=es; Path=/; HttpOnly'] }));
assert(jar.get('PHPSESSID') === 'abc123', 'Guarda PHPSESSID');
assert(jar.get('vtiger_language') === 'es', 'Guarda la segunda cookie');
assert(construirCabeceraCookie(jar) === 'PHPSESSID=abc123; vtiger_language=es', 'Construye la cabecera Cookie');
aplicarCookies(jar, respuesta('', { setCookies: ['PHPSESSID=nuevo999; path=/'] }));
assert(jar.get('PHPSESSID') === 'nuevo999', 'Reemplaza el valor si el servidor rota la sesion');
aplicarCookies(jar, respuesta('', { setCookies: ['vtiger_language=; path=/'] }));
assert(!jar.has('vtiger_language'), 'Una cookie vacia se elimina del jar');
assert(extraerSetCookie({}).length === 0, 'Una respuesta sin Set-Cookie no rompe');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Descubrimiento de plantillas PDF y validacion de bytes');
assert(extraerFolderIdsPdf('<a href="x&folderid=7">a</a><a href="y&folderid=9">b</a>').join(',') === '7,9', 'Extrae los folderid encontrados');
assert(extraerFolderIdsPdf('<a href="x&folderid=7">a</a><a href="y&folderid=7">b</a>').length === 1, 'Elimina folderid duplicados');
assert(extraerFolderIdsPdf('<html>sin plantillas</html>').length === 0, 'Sin folderid devuelve lista vacia');
assert(esPdf(PDF_MINIMO) === true, 'Reconoce los bytes %PDF-');
assert(esPdf(Buffer.from('<html>login</html>')) === false, 'Un HTML no pasa como PDF');
assert(esPdf(null) === false, 'Un buffer nulo no rompe');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Login + descarga del PDF de punta a punta (vTiger simulado)');
const falso = crearVtigerFalso();
const cliente = crearClienteSesionWeb({ baseUrl: BASE, username: 'usuario_web', password: 'clave_web', fetchImpl: falso.fetchImpl });

const descarga = await cliente.descargarPdfAuto({ record: '6x35385', modulo: 'SalesOrder' });
const conteo = falso.contar();
assert(descarga.ok === true, 'Descarga el PDF oficial');
assert(esPdf(descarga.buf) === true, 'El archivo descargado es un PDF valido');
assert(descarga.folderId === '7', `Usa el folderid descubierto (recibido: ${descarga.folderId})`);
assert(conteo.loginsGet === 1, `Se loguea UNA sola vez (recibido: ${conteo.loginsGet})`);
assert(conteo.pdfSinFolder === 0, 'No pierde llamadas probando sin folderid cuando ya lo encontro');
assert(conteo.pdfConFolder === 1, 'Descarga exactamente un PDF');

const post = falso.llamadas.find(l => l.method === 'POST');
assert(Boolean(post), 'Se envio el POST de login');
assert(/__vtrftk=/.test(String(post.body)), 'El POST incluye el token CSRF');
assert(/username=usuario_web/.test(String(post.body)), 'El POST incluye el usuario web');
assert(!/clave_web/.test(String(post.body).replace(/password=[^&]*/, '')), 'La contrasena solo viaja en el campo password');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Sesion cacheada y single-flight (no hay un login por factura)');
const antes = falso.contar().loginsGet;
await Promise.all([cliente.asegurarSesion(), cliente.asegurarSesion(), cliente.asegurarSesion()]);
assert(falso.contar().loginsGet === antes, 'Con la sesion vigente NO se vuelve a loguear (cache)');
assert(cliente.sesionVigente() === true, 'La sesion se reporta vigente');

const cliente2 = crearClienteSesionWeb({ baseUrl: BASE, username: 'u', password: 'p', fetchImpl: falso.fetchImpl });
const antes2 = falso.contar().loginsGet;
await Promise.all([cliente2.asegurarSesion(), cliente2.asegurarSesion(), cliente2.asegurarSesion()]);
assert(falso.contar().loginsGet === antes2 + 1, `3 llamadas concurrentes producen 1 solo login (recibido: ${falso.contar().loginsGet - antes2})`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 8] Renovacion automatica cuando la sesion cae a mitad de camino');
const falso2 = crearVtigerFalso({ pdfTrasLoginCaido: true });
falso2.marcarSesionCaida(); // vTiger devolvera el login en el primer ExportPDF
const cliente3 = crearClienteSesionWeb({ baseUrl: BASE, username: 'u', password: 'p', fetchImpl: falso2.fetchImpl });
const r3 = await cliente3.descargarPdf({ record: '6x35385', modulo: 'SalesOrder', folderId: '7' });
assert(r3.ok === true, 'Si vTiger devuelve el login, se renueva la sesion y se reintenta');
assert(falso2.contar().loginsGet === 2, `Se reloguea exactamente una vez (recibido: ${falso2.contar().loginsGet})`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 9] Fail-safe sin credenciales (no rompe el motor)');
const estado = getVtigerWebConfigStatus();
assert(typeof estado.configurado === 'boolean', 'El estado de configuracion se reporta sin lanzar excepcion');
assert(Array.isArray(estado.faltantes), 'Lista las variables faltantes');
const sinCredenciales = crearClienteSesionWeb({ baseUrl: BASE, username: '', password: '' , fetchImpl: falso.fetchImpl });
let errorCred = null;
try { await sinCredenciales.asegurarSesion(); } catch (e) { errorCred = e; }
assert(errorCred?.code === 'WEB_CREDENTIALS_MISSING', `Sin credenciales falla con WEB_CREDENTIALS_MISSING (recibido: ${errorCred?.code})`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 10] Credenciales incorrectas se detectan (no se cree logueado)');
const falso3 = crearVtigerFalso();
const falsoRechaza = async (url, init = {}) => {
  if (/module=Home&action=index/.test(url)) return respuesta(HTML_LOGIN); // el servidor devuelve el login
  return falso3.fetchImpl(url, init);
};
const cliente4 = crearClienteSesionWeb({ baseUrl: BASE, username: 'malo', password: 'mala', fetchImpl: falsoRechaza });
let errorLogin = null;
try { await cliente4.asegurarSesion(); } catch (e) { errorLogin = e; }
assert(errorLogin?.code === 'WEB_LOGIN_REJECTED', `Credenciales rechazadas -> WEB_LOGIN_REJECTED (recibido: ${errorLogin?.code})`);
assert(cliente4.sesionVigente() === false, 'No se marca la sesion como vigente tras un login rechazado');

// ------------------------------------------------------------------------------
console.log('\n[TEST 11] DESCARGA DEL DOCUMENTO OFICIAL (Opcion A: el PDF de vTiger)');
const falsoDoc = crearVtigerFalso();
const clienteDoc = crearClienteSesionWeb({ baseUrl: BASE, username: 'u', password: 'p', fetchImpl: falsoDoc.fetchImpl });
const rDoc = await clienteDoc.descargarDocumentoOficial({ record: '6x35385', modulo: 'SalesOrder', app: 'MARKETING' });
assert(rDoc.ok === true && esPdf(rDoc.buf) === true, 'Descarga el PDF oficial del documento');
assert(rDoc.bytes === PDF_MINIMO.length, 'Devuelve los bytes del PDF oficial');
const urlDoc = falsoDoc.llamadas.find(l => /action=ExportPDF/.test(l.url))?.url || '';
assert(/action=ExportPDF/.test(urlDoc) && /record=35385\b/.test(urlDoc), 'ExportPDF recibe el CRMID numerico (sin el prefijo "6x")');
assert(/app=MARKETING/.test(urlDoc), 'Incluye el parametro `app` (sin el, vTiger devuelve HTML en lugar del PDF)');
assert(!/folderid=/.test(urlDoc), 'No inventa un folderid: usa la URL exacta de la interfaz');
assert(normalizarRecordExportPdf('6x2855909') === '2855909', 'normalizarRecordExportPdf quita el prefijo de modulo');
assert(normalizarRecordExportPdf('2855909') === '2855909', 'normalizarRecordExportPdf deja intacto un id numerico');
assert(normalizarRecordExportPdf('') === '', 'normalizarRecordExportPdf tolera vacio');

const falsoDocMalo = crearVtigerFalso();
const fetchSinPdf = async (url, init = {}) => {
  if (/action=ExportPDF/.test(url)) return respuesta('<html>vista en HTML, no PDF</html>');
  return falsoDocMalo.fetchImpl(url, init);
};
const clienteDocMalo = crearClienteSesionWeb({ baseUrl: BASE, username: 'u', password: 'p', fetchImpl: fetchSinPdf });
const rDocMalo = await clienteDocMalo.descargarDocumentoOficial({ record: '6x1' });
assert(rDocMalo.ok === false && rDocMalo.motivo === 'EXPORT_PDF_NO_DEVOLVIO_PDF', 'Si vTiger no devuelve un PDF, lo reporta (no publica HTML como si fuera factura)');
const rSinRecord = await clienteDoc.descargarDocumentoOficial({ record: '' });
assert(rSinRecord.ok === false && rSinRecord.motivo === 'SIN_RECORD', 'Sin registro no llama a la red');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
