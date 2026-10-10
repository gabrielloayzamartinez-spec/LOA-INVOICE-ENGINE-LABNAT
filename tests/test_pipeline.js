/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL PIPELINE DE COMPRA (monitor por sede)
 * ==============================================================================
 * Verifica las funciones PURAS del registro por etapa:
 *   - Indice de etapa (para saber si avanza o se atasca).
 *   - Registro JSONL y lectura tolerante.
 *   - Reduccion al ULTIMO estado por orden.
 *   - Resumen por sede: total, exito del motor, enviadas, en proceso y fallas.
 *   - Deteccion de atascadas.
 *
 * Ejecucion:  node tests/test_pipeline.js
 * ==============================================================================
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ETAPAS_PIPELINE, ETAPAS_FALLO, indiceEtapa,
  registrarPipeline, leerPipeline, ultimoEstadoPorOrden,
  resumenPipeline, atascadas, formatearResumen
} from '../src/core/pipeline.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-pipe-'));
const ARCHIVO = path.join(TMP, 'pipeline.jsonl');

console.log('\n==========================================================');
console.log(' [TEST] PIPELINE DE COMPRA (traza por etapa, monitor por sede)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Etapas consecutivas');
assert(JSON.stringify(ETAPAS_PIPELINE) === JSON.stringify(['DETECTADA', 'ORDEN_RESUELTA', 'PDF_OBTENIDO', 'PUBLICADO', 'MARCADO', 'ENVIADO']), 'Las 6 etapas de exito estan en orden');
assert(indiceEtapa('DETECTADA') === 0 && indiceEtapa('MARCADO') === 4 && indiceEtapa('ENVIADO') === 5, 'El indice refleja el orden');
assert(indiceEtapa('FALLO_SUBIDA') === null, 'Un fallo no tiene indice de avance');
assert(ETAPAS_FALLO.has('OMITIDO') && ETAPAS_FALLO.has('FALLO_DESCARGA'), 'Los estados de bloqueo estan definidos');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Registro JSONL y lectura tolerante');
registrarPipeline(ARCHIVO, { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'DETECTADA' });
registrarPipeline(ARCHIVO, { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'MARCADO' });
let filas = leerPipeline(ARCHIVO);
assert(filas.length === 2, 'Guarda una fila por transicion');
assert(filas[1].estado === 'MARCADO', 'Lee las transiciones en orden');
fs.appendFileSync(ARCHIVO, 'linea corrupta no json\n');
assert(leerPipeline(ARCHIVO).length === 2, 'Una linea corrupta se ignora (no rompe el reporte)');
assert(leerPipeline(path.join(TMP, 'no-existe.jsonl')).length === 0, 'Un archivo inexistente devuelve lista vacia');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Reduccion al ultimo estado por orden');
filas = [
  { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'DETECTADA', ts: '2026-10-10T10:00:00Z' },
  { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'MARCADO', ts: '2026-10-10T10:00:03Z' },
  { orden: '6x2', numeroOrden: 'S-2', sede: 'BENAVIDES', estado: 'PUBLICADO', ts: '2026-10-10T10:01:00Z' }
];
const finales = ultimoEstadoPorOrden(filas);
assert(finales.length === 2, 'Reduce a una fila por orden');
assert(finales.find(f => f.orden === '6x1').estado === 'MARCADO', 'Conserva el ULTIMO estado (no el primero)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Resumen por sede');
filas = [
  { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'MARCADO', ts: '2026-10-10T10:00:00Z' },
  { orden: '6x2', numeroOrden: 'S-2', sede: 'PALACIOS', estado: 'ENVIADO', ts: '2026-10-10T10:01:00Z' },
  { orden: '6x3', numeroOrden: 'S-3', sede: 'PALACIOS', estado: 'FALLO_SUBIDA', ts: '2026-10-10T10:02:00Z' },
  { orden: '6x4', numeroOrden: 'S-4', sede: 'BENAVIDES', estado: 'PDF_OBTENIDO', ts: '2026-10-10T10:03:00Z' }
];
const porSede = resumenPipeline(filas);
assert(porSede.PALACIOS.total === 3, 'Palacios: 3 compras');
assert(porSede.PALACIOS.exitoMotor === 2, 'Palacios: 2 llegaron a exito del motor (MARCADO + ENVIADO)');
assert(porSede.PALACIOS.enviadas === 1, 'Palacios: 1 con SMS confirmado');
assert(porSede.PALACIOS.fallidas === 1, 'Palacios: 1 fallo');
assert(porSede.BENAVIDES.total === 1 && porSede.BENAVIDES.enProceso === 1, 'Benavides: 1 en proceso');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Atascadas (etapa intermedia hace mas de N minutos)');
const ahora = Date.parse('2026-10-10T11:00:00Z');
const filasAtascadas = [
  { orden: '6x1', numeroOrden: 'S-1', sede: 'PALACIOS', estado: 'PUBLICADO', ts: '2026-10-10T09:00:00Z' }, // 2h: atascada
  { orden: '6x2', numeroOrden: 'S-2', sede: 'PALACIOS', estado: 'PDF_OBTENIDO', ts: '2026-10-10T10:55:00Z' }, // 5min: no
  { orden: '6x3', numeroOrden: 'S-3', sede: 'PALACIOS', estado: 'MARCADO', ts: '2026-10-10T09:00:00Z' }      // final: no cuenta
];
const atasc = atascadas(filasAtascadas, { minutos: 60, ahora });
assert(atasc.length === 1 && atasc[0].numeroOrden === 'S-1', 'Detecta solo la compra atascada > 60 min en etapa intermedia');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Tabla legible');
const tabla = formatearResumen(porSede);
assert(tabla.includes('SEDE') && tabla.includes('PALACIOS') && tabla.includes('BENAVIDES'), 'La tabla lista las sedes');
assert(tabla.includes('OK-MOTOR') && tabla.includes('ENVIADAS') && tabla.includes('FALLAS'), 'Incluye las columnas de medicion');
assert(formatearResumen({}).includes('sin compras'), 'Sin datos no rompe');

// ------------------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
