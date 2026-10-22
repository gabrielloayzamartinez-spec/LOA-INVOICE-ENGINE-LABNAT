/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL REPORTE DIARIO DE ORDENES VERIFICADAS
 * ==============================================================================
 * Prueba:
 *   1. Formateo y normalizacion de fechas.
 *   2. Generacion del reporte con ordenes verificadas simuladas.
 *   3. Desglose correcto por sede y calculo de metricas.
 *   4. Cruce con traza de pipeline (estados PUBLICADA, ENVIADO, PENDIENTE).
 *   5. Formateo de salida Markdown y persistencia en disco.
 *   6. Fail-safe: sin ordenes, vTiger con error, parametros invalidos.
 *
 * Ejecucion:  node tests/test_daily_report.js
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { generarReporteDiario, fechaYmd } from '../src/core/daily_report.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const DIR_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-report-'));

console.log('\n==========================================================');
console.log(' [TEST] REPORTE DIARIO DE ORDENES VERIFICADAS');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Formateo de fechas (fechaYmd)');
assert(fechaYmd('2026-10-21') === '2026-10-21', 'Conserva string YYYY-MM-DD');
assert(fechaYmd(new Date('2026-10-21T15:30:00Z')) === '2026-10-21', 'Normaliza objeto Date');
assert(/^\d{4}-\d{2}-\d{2}$/.test(fechaYmd()), 'Fecha por defecto tiene formato YYYY-MM-DD');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Generacion con vTiger simulado y cruce de pipeline');

const ORDENES_SIMULADAS = [
  {
    id: '6x2850637',
    salesorder_no: 'S-97487',
    contact_id: '12x2668524',
    createdtime: '2026-10-21 12:37:46',
    hdnGrandTotal: '150.00000000',
    cf_882: 'VERIFICADA',
    cf_1006: '4085496811',
    cf_856: 'BRAULIO',
    cf_858: 'ALVARADO',
    cf_3127: 'PALACIOS'
  },
  {
    id: '6x2850711',
    salesorder_no: 'S-97489',
    contact_id: '12x2826020',
    createdtime: '2026-10-21 13:51:03',
    hdnGrandTotal: '120.00000000',
    cf_882: 'VERIFICADA',
    cf_1006: '8629003832',
    cf_856: 'FELIX',
    cf_858: 'GUALPA',
    cf_3127: 'BENAVIDES'
  }
];

const vtigerSimulado = {
  consultas: [],
  async consultar(sql) {
    this.consultas.push(sql);
    return ORDENES_SIMULADAS;
  }
};

// Creamos un pipeline de prueba
const rutaPipeline = path.join(DIR_TEMP, 'pipeline.jsonl');
fs.writeFileSync(rutaPipeline, [
  JSON.stringify({ ts: '2026-10-21T13:00:00Z', orden: '6x2850637', numeroOrden: 'S-97487', sede: 'PALACIOS', estado: 'ENVIADO', url: 'https://cdn.ghl.test/invoice1.pdf' }),
  JSON.stringify({ ts: '2026-10-21T14:00:00Z', orden: '6x2850711', numeroOrden: 'S-97489', sede: 'BENAVIDES', estado: 'DETECTADA' })
].join('\n'), 'utf8');

const r = await generarReporteDiario({
  clienteVtiger: vtigerSimulado,
  fecha: '2026-10-21',
  pipelineArchivo: rutaPipeline,
  dirReportes: DIR_TEMP,
  guardar: true
});

assert(r.ok === true, 'Genera el reporte exitosamente');
assert(r.stats.totalVerificadas === 2, 'Contabiliza 2 ordenes verificadas');
assert(r.stats.publicadas === 1, 'Contabiliza 1 publicada (S-97487 en estado ENVIADO)');
assert(r.stats.enviadasSms === 1, 'Contabiliza 1 enviada por SMS');
assert(r.stats.pendientes === 1, 'Contabiliza 1 pendiente (S-97489 en estado DETECTADA)');
assert(r.stats.desgloseSede.PALACIOS.verificadas === 1, 'Desglose sede PALACIOS correcto');
assert(r.stats.desgloseSede.BENAVIDES.verificadas === 1, 'Desglose sede BENAVIDES correcto');
assert(r.items.length === 2, 'Devuelve el detalle de las 2 ordenes');
assert(r.items[0].cliente === 'BRAULIO ALVARADO', 'Nombre del cliente extraido de la orden');
assert(r.items[0].urlFactura === 'https://cdn.ghl.test/invoice1.pdf', 'URL del PDF asociada correctamente');
assert(typeof r.reporteMd === 'string' && r.reporteMd.includes('REPORTE DIARIO'), 'Genera el texto Markdown');
assert(fs.existsSync(r.rutaGuardada), 'Guarda el archivo Markdown en disco');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Filtro estricto de fecha en consulta SQL de vTiger');
const sqlEjecutado = vtigerSimulado.consultas[0];
assert(sqlEjecutado.includes("cf_882 = 'VERIFICADA'"), "Filtra por cf_882 = 'VERIFICADA'");
assert(sqlEjecutado.includes("createdtime >= '2026-10-21 00:00:00'"), 'Filtra inicio del dia');
assert(sqlEjecutado.includes("createdtime <= '2026-10-21 23:59:59'"), 'Filtra fin del dia');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Fail-safe');
try {
  await generarReporteDiario({});
  assert(false, 'Debe lanzar TypeError si falta clienteVtiger');
} catch (e) {
  assert(e instanceof TypeError, 'Lanza TypeError si no hay clienteVtiger');
}

const vtigerError = {
  async consultar() { throw new Error('Conexion perdida con vTiger'); }
};
try {
  await generarReporteDiario({ clienteVtiger: vtigerError, fecha: '2026-10-21', dirReportes: DIR_TEMP });
  assert(false, 'Debe lanzar Error si vTiger falla');
} catch (e) {
  assert(e.message.includes('Error consultando ordenes verificadas'), 'Captura y describe el error de vTiger');
}

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exit(1);
