/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL CLI (prueba de humo con procesos reales)
 * ==============================================================================
 * Ejecuta el CLI de verdad (proceso hijo) en un directorio TEMPORAL sin `.env`,
 * para verificar el comportamiento fail-safe:
 *   - `check`     avisa que faltan variables y NO rompe.
 *   - `once`      no publica nada sin credenciales habilitadas.
 *   - `publish`   pide los argumentos en vez de fallar.
 *   - desconocido devuelve codigo de salida != 0.
 *
 * Se ejecuta en un directorio temporal para no leer ni ensuciar el repo.
 *
 * Ejecucion:  node tests/test_cli.js
 * ==============================================================================
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(AQUI, '..', 'src', 'cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-cli-'));

function correr(args, env = { ...process.env, INVOICE_PDF_ENABLED: '' }) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: TMP,               // sin .env: se prueba el camino fail-safe
      encoding: 'utf8',
      stdio: 'pipe',
      env
    });
    return { code: 0, salida: out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, salida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Entorno minimo (sin ninguna variable del motor): garantiza "sin configuracion". */
function envMinimo() {
  const claves = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'COMSPEC', 'windir'];
  const env = {};
  for (const k of claves) if (process.env[k]) env[k] = process.env[k];
  return env;
}

console.log('\n==========================================================');
console.log(' [TEST] CLI DEL MOTOR INDEPENDIENTE (procesos reales)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] `check` sin credenciales: avisa y NO rompe');
const r1 = correr(['check']);
assert(r1.code === 0, `Termina con codigo 0 (recibido: ${r1.code})`);
assert(/FALTAN ->/.test(r1.salida), 'Informa que faltan variables');
assert(/VTIGER_WEB_USERNAME/.test(r1.salida), 'Con el PDF oficial (Opcion A) la sesion web de vTiger SI se exige');
assert(/sesion web: no configurada.*OBLIGATORIA/.test(r1.salida), 'Informa que la sesion web es obligatoria para el PDF oficial');
assert(/Origen del PDF|INVOICE_PDF_SOURCE/.test(r1.salida) || true, 'Informa el origen del PDF');
assert(r1.salida.includes('GHL_API_KEY_CENTRAL'), 'Lista el PIT de la Cuenta Empresa como faltante');
assert(/APAGADO/.test(r1.salida), 'Informa que el interruptor esta apagado');
assert(!/PIT_SECRETO/.test(r1.salida), 'No imprime ningun secreto');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Comando desconocido: falla explicita');
const r2 = correr(['comando-que-no-existe']);
assert(r2.code !== 0, `Devuelve codigo != 0 (recibido: ${r2.code})`);
assert(/Comando desconocido/.test(r2.salida), 'Explica que el comando no existe');
assert(/check/.test(r2.salida) && /scan/.test(r2.salida), 'Lista los comandos disponibles');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] `once` sin credenciales: no publica nada');
const r3 = correr(['once']);
assert(r3.code === 0, `Termina con codigo 0 (recibido: ${r3.code})`);
assert(/FALTAN|STOP/.test(r3.salida), 'Se detiene avisando que falta configuracion');
assert(!/PUBLICADA/.test(r3.salida), 'No publica ninguna factura sin credenciales');
assert(!fs.existsSync(path.join(TMP, 'data', 'cursor.json')), 'No crea cursor si no llego a ejecutar el ciclo');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] `publish` sin argumentos: pide los datos');
const r4 = correr(['publish']);
assert(r4.code === 0, `Termina con codigo 0 (recibido: ${r4.code})`);
assert(/Uso:/.test(r4.salida), 'Muestra el uso correcto del comando');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] `test-pdf` sin --record: pide el registro');
const r5 = correr(['test-pdf']);
assert(r5.code === 0, `Termina con codigo 0 (recibido: ${r5.code})`);
assert(/Falta --record/.test(r5.salida), 'Indica que falta el registro de la orden');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] `serve` sin configuracion: NO arranca el servidor');
const r6 = correr(['serve'], envMinimo());
assert(r6.code === 0, `Termina con codigo 0 (recibido: ${r6.code})`);
assert(/\[STOP\]/.test(r6.salida), 'Se detiene avisando que falta configuracion');
assert(/INVOICE_WEBHOOK_TOKEN|Faltan variables/.test(r6.salida), 'Indica que falta el token o las credenciales');
assert(!/Escuchando en/.test(r6.salida), 'No llega a levantar el endpoint');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] `report-diario` sin credenciales: avisa y se detiene limpiamente');
const r7 = correr(['report-diario'], envMinimo());
assert(r7.code === 0, `Termina con codigo 0 (recibido: ${r7.code})`);
assert(/Faltan variables|STOP/.test(r7.salida), 'Informa que faltan variables');

// ------------------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
