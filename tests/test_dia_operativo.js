import {
  obtenerDiaOperativo,
  perteneceAlDiaOperativo,
  clausulaSqlDiaOperativo,
  verificarCambioDia,
  formatearFechaIsoLocal
} from '../src/core/dia_operativo.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] GESTOR DE DÍA OPERATIVO Y CALENDARIO');
console.log('==========================================================\n');

// 1. Obtención de Día Operativo con fecha fija
console.log('[TEST 1] Construcción de metadatos de calendario');
const d1 = obtenerDiaOperativo('2026-10-23T15:30:00Z', 'America/New_York');
assert(d1.fecha === '2026-10-23', 'Calcula la fecha YYYY-MM-DD correctamente');
assert(d1.anio === 2026, 'Año 2026');
assert(d1.mes === 10, 'Mes 10 (Octubre)');
assert(d1.dia === 23, 'Día 23');
assert(d1.nombreMes === 'Octubre', 'Nombre del mes Octubre');
assert(d1.diaSemana === 'Viernes', 'Día de la semana Viernes');
assert(d1.esFinDeSemana === false, 'Viernes no es fin de semana');
assert(d1.inicioDia === '2026-10-23 00:00:00', 'Hora inicio: 12:00:00 AM exacta');
assert(d1.finDia === '2026-10-23 23:59:59', 'Hora fin: 11:59:59 PM exacta');

// 2. Comprobación de pertenencia al día operativo
console.log('\n[TEST 2] Validación estricta de pertenencia al Día Operativo');
const opHoy = obtenerDiaOperativo('2026-10-23');
assert(perteneceAlDiaOperativo('2026-10-23 09:15:00', opHoy) === true, 'Compra de hoy a las 9:15 AM pertenece a hoy');
assert(perteneceAlDiaOperativo('2026-10-23 23:58:00', opHoy) === true, 'Compra de hoy a las 11:58 PM pertenece a hoy');
assert(perteneceAlDiaOperativo('2026-10-23 00:01:00', opHoy) === true, 'Compra de hoy a las 12:01 AM pertenece a hoy');
assert(perteneceAlDiaOperativo('2026-10-22 23:59:59', opHoy) === false, 'Compra de ayer a las 11:59:59 PM NO pertenece a hoy (bloqueada)');
assert(perteneceAlDiaOperativo('2026-10-24 00:00:01', opHoy) === false, 'Compra de mañana NO pertenece a hoy');
assert(perteneceAlDiaOperativo('', opHoy) === false, 'Timestamp vacío rechazado');

// 3. Generación de cláusula SQL para vTiger
console.log('\n[TEST 3] Generación de cláusula SQL de vTiger');
const sqlClausula = clausulaSqlDiaOperativo(opHoy, 'createdtime');
assert(sqlClausula === "createdtime >= '2026-10-23 00:00:00' AND createdtime <= '2026-10-23 23:59:59'", 'Genera el rango completo 12:00 AM a 11:59 PM en SQL');

// 4. Detección de cambio de día a medianoche
console.log('\n[TEST 4] Rollover y cambio de día a medianoche');
const checkMismoDia = verificarCambioDia('2026-10-23', 'America/New_York');
assert(checkMismoDia.cambio === false, 'Misma fecha no reporta cambio de día');

const checkDiaPasado = verificarCambioDia('2026-10-22', 'America/New_York');
assert(checkDiaPasado.cambio === true, 'Fecha de ayer sí reporta cambio de día');
assert(checkDiaPasado.fechaActual === '2026-10-23', 'Indica la nueva fecha operativa');

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
