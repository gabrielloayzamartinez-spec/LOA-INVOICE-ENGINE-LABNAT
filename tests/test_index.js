/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL API PUBLICO
 * ==============================================================================
 * Verifica que TODOS los exports de `src/index.js` existan y funcionen, y que
 * los candados de solo lectura sigan activos a traves del punto de entrada.
 *
 * Esta suite atrapa la clase de error mas silenciosa: un rename interno que deja
 * un export inexistente (import roto en produccion, no en los tests unitarios).
 *
 * Ejecucion:  node tests/test_index.js
 * ==============================================================================
 */

import * as API from '../src/index.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] API PUBLICA DEL MOTOR INDEPENDIENTE');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Todos los exports declarados existen');
const esperados = {
  // Configuracion
  cargarEnv: 'function', configFactura: 'function', validarConfig: 'function', resumenConfig: 'function',
  env: 'function', envBool: 'function', envInt: 'function',
  // Auditoria
  recordAuditEvent: 'function', leerAuditoria: 'function', configurarAuditoria: 'function',
  // Contrato
  TAG_FACTURA_LISTA: 'string', TAG_FACTURA_ENVIADA: 'string', CLAVES_PUENTE_FACTURA: 'object', MOTIVOS_PUBLICACION: 'object',
  decidirPublicacion: 'function', construirPuenteFactura: 'function', construirCierreEnvio: 'function',
  leerEstadoPuenteFactura: 'function', nombreArchivoFactura: 'function',
  // Caso de uso
  entregarFacturaDeOrden: 'function', facturaPdfHabilitada: 'function', MOTIVOS_ENTREGA: 'object',
  // Conector
  publicarFacturaDeContacto: 'function', crearDepsFactura: 'function', resolverCamposPuente: 'function',
  normalizarNombreCampo: 'function', headersCentral: 'function', NOMBRES_CAMPOS_FACTURA: 'object',
  leerContactoGhl: 'function', escribirCamposPuente: 'function', agregarTagsContacto: 'function',
  // Conectores externos
  crearClienteSesionWeb: 'function', getVtigerWebConfigStatus: 'function', esPdf: 'function', assertAccionWebPermitida: 'function',
  crearClienteVtiger: 'function', assertSentenciaSoloLectura: 'function', assertOperacionPermitida: 'function', escaparValor: 'function',
  subirPdfAMediaLibrary: 'function', verificarAccesoMedia: 'function', MOTIVOS_MEDIA: 'object', ghlFetch: 'function',
  // Deteccion
  detectarComprasNuevas: 'function', cargarCursor: 'function', guardarCursor: 'function', claveCursor: 'function',
  normalizarOrden: 'function', ORDEN_SELECT: 'object'
};

let faltantes = 0;
for (const [nombre, tipo] of Object.entries(esperados)) {
  const valor = API[nombre];
  const ok = typeof valor === tipo || (tipo === 'object' && Array.isArray(valor));
  if (!ok) { faltantes++; console.error(`    [FALTA] ${nombre} (esperado ${tipo}, recibido ${typeof valor})`); }
}
assert(faltantes === 0, `Los ${Object.keys(esperados).length} exports esperados existen con su tipo correcto`);
assert(API.TAG_FACTURA_LISTA === 'FACTURA_LISTA', 'El tag disparador es FACTURA_LISTA (contrato con GHL)');
assert(API.TAG_FACTURA_ENVIADA === 'FACTURA_ENVIADA', 'El tag de cierre es FACTURA_ENVIADA');
assert(API.ORDEN_SELECT.includes('hdnGrandTotal') && !API.ORDEN_SELECT.includes('total'), 'La consulta de ordenes usa hdnGrandTotal (el campo `total` esta denegado en vTiger)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Los candados de solo lectura siguen activos por el API publico');
for (const sql of ['DELETE FROM Contacts', 'UPDATE Contacts SET phone=1', 'DROP TABLE Contacts', 'INSERT INTO Contacts (id) VALUES (1)']) {
  let bloqueado = false;
  try { API.assertSentenciaSoloLectura(sql); } catch { bloqueado = true; }
  assert(bloqueado, `Bloquea la sentencia: ${sql.slice(0, 28)}`);
}
let permitido = true;
try { API.assertSentenciaSoloLectura("SELECT id FROM Contacts WHERE cf_3451 = 'PALACIOS'"); } catch { permitido = false; }
assert(permitido, 'Permite una consulta SELECT legitima');

for (const accion of ['Save', 'Edit', 'Delete', 'MassEdit']) {
  let bloqueado = false;
  try { API.assertAccionWebPermitida(accion); } catch { bloqueado = true; }
  assert(bloqueado, `Bloquea la accion web: ${accion}`);
}
let exportOk = true;
try { API.assertAccionWebPermitida('ExportPDF'); } catch { exportOk = false; }
assert(exportOk, 'Permite la accion ExportPDF');

let opBloqueada = false;
try { API.assertOperacionPermitida('create'); } catch { opBloqueada = true; }
assert(opBloqueada, 'Bloquea la operacion `create` de la Webservice API');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Funciones clave a traves del punto de entrada');
assert(API.esPdf(Buffer.from('%PDF-1.4\n...')) === true, 'esPdf reconoce un PDF');
assert(API.esPdf(Buffer.from('<html>')) === false, 'esPdf rechaza un HTML');
assert(API.normalizarOrden({ id: '6x1', salesorder_no: 'G-1', hdnGrandTotal: '99' }).numeroOrden === 'G-1', 'normalizarOrden funciona');
assert(API.claveCursor({ id: '6x1', numeroOrden: 'G-1' }) === '6x1|G-1', 'claveCursor funciona');
assert(API.nombreArchivoFactura('G-1') === 'factura_G-1.pdf', 'nombreArchivoFactura funciona');
assert(API.facturaPdfHabilitada({ INVOICE_PDF_ENABLED: 'false' }) === false, 'El interruptor respeta INVOICE_PDF_ENABLED=false');
assert(API.facturaPdfHabilitada({ INVOICE_PDF_ENABLED: 'true' }) === true, 'El interruptor respeta INVOICE_PDF_ENABLED=true');
assert(API.decidirPublicacion({ orden: { id: '1', numeroOrden: 'G-1' }, estadoActual: {}, urlPdf: 'x' }).publicar === true, 'decidirPublicacion publica una compra nueva');
assert(API.decidirPublicacion({ orden: { id: '1', numeroOrden: 'G-1' }, estadoActual: { facturaNumeroOrden: 'G-1' }, urlPdf: 'x' }).motivo === 'YA_PUBLICADA', 'decidirPublicacion bloquea la repetida');
assert(API.leerEstadoPuenteFactura(null).facturaNumeroOrden === '', 'leerEstadoPuenteFactura tolera un contacto nulo (blindaje)');
assert(API.getVtigerWebConfigStatus().configurado === false || API.getVtigerWebConfigStatus().configurado === true, 'getVtigerWebConfigStatus no lanza sin credenciales');
assert(typeof API.crearDepsFactura({ apiKeyCentral: 'x', locationIdCentral: 'y' }).descargarPdf === 'function', 'crearDepsFactura construye las dependencias reales');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] El resumen de configuracion no expone secretos');
const resumen = API.resumenConfig({
  habilitado: false,
  vtiger: { url: 'https://v.test', username: 'u', accessKey: 'CLAVE_SECRETA_XYZ', webUsername: 'w', webPassword: 'PASS_XYZ' },
  ghl: { apiKeyCentral: 'PIT_SECRETO_XYZ', locationIdCentral: 'ATPYNnsfZ1W8sd6WgWIV' },
  escaneo: { sede: 'PALACIOS', dias: 7, lote: 25, intervaloMinutos: 15 }
});
const texto = JSON.stringify(resumen);
assert(!texto.includes('PIT_SECRETO_XYZ') && !texto.includes('CLAVE_SECRETA_XYZ') && !texto.includes('PASS_XYZ'), 'No filtra PIT, access key ni contrasena web');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
