/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DE CONFIGURACION
 * ==============================================================================
 * Prueba el parser de `.env` propio (sin dependencias), los helpers de entorno,
 * la validacion fail-safe y que el resumen NUNCA exponga secretos.
 *
 * Ejecucion:  node tests/test_config.js
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { cargarEnv, env, envBool, envInt, validarConfig, resumenConfig, configFactura } from '../src/config.js';
import { normalizarNombreCampo, NOMBRES_CAMPOS_FACTURA } from '../src/core/invoice_publisher.js';
import { CLAVES_PUENTE_FACTURA } from '../src/core/invoice_bridge.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] CONFIGURACION DEL MOTOR INDEPENDIENTE');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Parser de .env propio (sin dependencias)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-env-'));
const archivo = path.join(dir, '.env');
fs.writeFileSync(archivo, [
  '# un comentario',
  '',
  'TEST_LOA_TEXTO=hola',
  'TEST_LOA_NUM=42',
  'TEST_LOA_BOOL=true',
  'TEST_LOA_COMILLAS="con espacios"',
  'TEST_LOA_SIMPLES=\'otro valor\'',
  'TEST_LOA_VACIA=',
  'TEST_LOA_ESPACIOS=   recortado   '
].join('\n'), 'utf8');

const carga = cargarEnv(archivo);
assert(carga.cargado === true, 'Carga el archivo .env');
assert(env('TEST_LOA_TEXTO') === 'hola', 'Lee un valor simple');
assert(env('TEST_LOA_NUM') === '42', 'Lee un numero como texto');
assert(envInt('TEST_LOA_NUM') === 42, 'envInt convierte a entero');
assert(envBool('TEST_LOA_BOOL') === true, 'envBool interpreta true');
assert(env('TEST_LOA_COMILLAS') === 'con espacios', 'Quita comillas dobles');
assert(env('TEST_LOA_SIMPLES') === 'otro valor', 'Quita comillas simples');
assert(env('TEST_LOA_ESPACIOS') === 'recortado', 'Recorta espacios alrededor');
assert(env('TEST_LOA_VACIA', 'defecto') === 'defecto', 'Una variable vacia usa el valor por defecto');
assert(env('TEST_LOA_INEXISTENTE', 'x') === 'x', 'Una variable ausente usa el valor por defecto');

process.env.TEST_LOA_TEXTO = 'previo';
cargarEnv(archivo);
assert(process.env.TEST_LOA_TEXTO === 'previo', 'NO sobreescribe variables ya definidas en el entorno');
assert(cargarEnv(path.join(dir, 'no-existe.env')).cargado === false, 'Un archivo inexistente no rompe (fail-safe)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Validacion fail-safe de la configuracion');
const cfgVacio = {
  vtiger: { url: '', username: '', accessKey: '', webUsername: '', webPassword: '' },
  ghl: { apiKeyCentral: '', locationIdCentral: '' }
};
const vVacio = validarConfig(cfgVacio);
assert(vVacio.ok === false, 'Una configuracion vacia NO es valida');
for (const clave of ['VTIGER_URL', 'VTIGER_USERNAME', 'VTIGER_ACCESS_KEY', 'VTIGER_WEB_USERNAME', 'VTIGER_WEB_PASSWORD', 'GHL_API_KEY_CENTRAL', 'GHL_LOCATION_ID_CENTRAL']) {
  assert(vVacio.faltantes.includes(clave), `Reporta la falta de ${clave}`);
}
assert(validarConfig(cfgVacio, { webservice: false, sesionWeb: false, ghl: false }).ok === true, 'Sin requisitos, la validacion pasa (no exige de mas)');
assert(validarConfig(cfgVacio, { webservice: false, sesionWeb: false, ghl: true }).faltantes.length === 2, 'Solo exige lo que la operacion necesita');

const cfgOk = {
  vtiger: { url: 'https://x.test', username: 'u', accessKey: 'k', webUsername: 'w', webPassword: 'p' },
  ghl: { apiKeyCentral: 'pit-x', locationIdCentral: 'loc1' }
};
assert(validarConfig(cfgOk).ok === true, 'Una configuracion completa es valida');
assert(configFactura().escaneo.lote >= 1, 'configFactura() devuelve el bloque de escaneo');
assert(configFactura().habilitado === false || configFactura().habilitado === true, 'El interruptor se resuelve a booleano');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] El resumen nunca expone secretos');
const resumen = resumenConfig({
  habilitado: false,
  vtiger: { url: 'https://vtiger.test', username: 'u', accessKey: 'ACCESS_KEY_SECRETA', webUsername: 'w', webPassword: 'PASS_SECRETA' },
  ghl: { apiKeyCentral: 'PIT_SECRETO_123', locationIdCentral: 'ATPYNnsfZ1W8sd6WgWIV' },
  escaneo: { sede: 'PALACIOS', dias: 7, lote: 25, intervaloMinutos: 15 }
});
const serializado = JSON.stringify(resumen);
assert(!serializado.includes('PIT_SECRETO_123'), 'No expone el PIT de la cuenta empresa');
assert(!serializado.includes('ACCESS_KEY_SECRETA'), 'No expone el access key de vTiger');
assert(!serializado.includes('PASS_SECRETA'), 'No expone la contrasena web');
assert(resumen.cuentaEmpresa.locationIdSufijo === 'gWIV', 'Muestra solo el sufijo del locationId (auditable)');
assert(resumen.vtigerHost === 'vtiger.test', 'Muestra el host de vTiger');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Resolucion de nombres de campos (tolerante a acentos y simbolos)');
assert(normalizarNombreCampo('URL Factura PDF') === 'url factura pdf', 'Normaliza un nombre simple');
assert(normalizarNombreCampo('Factura Nº Orden') === 'factura n orden', 'Neutraliza el simbolo º');
assert(normalizarNombreCampo('  Factura   N°  Orden  ') === normalizarNombreCampo('Factura Nº Orden'), 'Colapsa espacios y simbolos');
assert(normalizarNombreCampo('FACTURA_Nº_ORDEN') === 'factura n orden', 'Trata guiones bajos como separadores');
assert(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.urlFacturaPdf] === 'URL Factura PDF', 'El nombre canonico del campo de URL es el acordado');
assert(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.facturaNumeroOrden] === 'Factura Nº Orden', 'El nombre canonico del campo de idempotencia es el acordado');

// ------------------------------------------------------------------------------
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
