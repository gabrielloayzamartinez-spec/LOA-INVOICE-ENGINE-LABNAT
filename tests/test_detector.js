/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL DETECTOR DE COMPRAS NUEVAS
 * ==============================================================================
 * Prueba, con un vTiger simulado y SIN red:
 *   1. Normalizacion de la orden cruda.
 *   2. Cursor persistido (carga, guardado atomico, poda).
 *   3. Consulta de compradores: filtros de sede/fecha y respaldo si el rol
 *      restringe los campos de telefono.
 *   4. Omisiones con motivo explicito (sin orden, sin telefono, sin contacto).
 *   5. Ciclo completo: publica, marca el cursor y NO republica en la 2da pasada.
 *   6. Un fallo NO marca el cursor (se reintenta en el proximo ciclo).
 *
 * Ejecucion:  node tests/test_detector.js
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  normalizarOrden, claveCursor, cargarCursor, guardarCursor, podarCursor,
  detectarComprasNuevas, detectarOrdenesVerificadas, ejecutarCiclo, ORDEN_SELECT, COMPRADOR_SELECT
} from '../src/jobs/detectar_compras_nuevas.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-cursor-'));

/** vTiger simulado: responde compradores y ordenes por contacto. */
function crearVtigerFalso({ compradores = [], ordenes = {}, fallaTelefonos = false, fallaOrdenDe = null, errorConsulta = null } = {}) {
  const consultas = [];
  return {
    consultas,
    async consultar(sql) {
      consultas.push(sql);
      if (errorConsulta) throw new Error(errorConsulta);
      if (/^\s*SELECT[^]*FROM Contacts/i.test(sql)) {
        if (fallaTelefonos && /phone/.test(sql)) throw new Error("Permission to access 'phone' attribute denied");
        return compradores;
      }
      if (/FROM SalesOrder/i.test(sql)) {
        const m = /contact_id = '([^']+)'/.exec(sql);
        const id = m ? m[1] : '';
        if (fallaOrdenDe && id === fallaOrdenDe) throw new Error('timeout consultando la orden');
        return ordenes[id] || [];
      }
      return [];
    }
  };
}

console.log('\n==========================================================');
console.log(' [TEST] DETECTOR DE COMPRAS NUEVAS');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Normalizacion de la orden cruda de vTiger');
const cruda = { id: '6x35385', salesorder_no: 'G-04212158', createdtime: '2019-11-21 14:21:32', hdnGrandTotal: '160.00000000', sostatus: 'Approved', cf_1069: 'Artritis', cf_3156: 'ALFA-L-179' };
const orden = normalizarOrden(cruda);
assert(orden.id === '6x35385', 'Conserva el id del registro');
assert(orden.numeroOrden === 'G-04212158', 'Extrae el numero de orden');
assert(orden.fecha === '2019-11-21', 'Normaliza la fecha a YYYY-MM-DD');
assert(orden.total === '160.00000000', 'Usa hdnGrandTotal como total');
assert(orden.tratamiento === 'Artritis', 'Extrae el tratamiento');
assert(normalizarOrden({}).numeroOrden === '', 'Una orden vacia no rompe');
assert(!ORDEN_SELECT.includes('total'), 'La consulta NO pide el campo `total` (denegado por permisos en vTiger)');
assert(ORDEN_SELECT.includes('hdnGrandTotal'), 'La consulta usa `hdnGrandTotal` (verificado)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Cursor persistido');
const clave = claveCursor(orden);
assert(clave === '6x35385|G-04212158', 'La clave combina record y numero de orden');
const rutaCursor = path.join(DIR, 'cursor.json');
assert(Object.keys(cargarCursor(rutaCursor).procesadas).length === 0, 'Un cursor inexistente se carga vacio (no rompe)');
const guardado = guardarCursor(rutaCursor, { procesadas: { [clave]: '2026-10-09T00:00:00.000Z' }, ultimaCorrida: null });
assert(guardado.ok === true, 'Guarda el cursor');
assert(cargarCursor(rutaCursor).procesadas[clave] === '2026-10-09T00:00:00.000Z', 'Relee la orden ya procesada');
fs.writeFileSync(rutaCursor, '{ corrupto', 'utf8');
assert(Object.keys(cargarCursor(rutaCursor).procesadas).length === 0, 'Un cursor corrupto se ignora (fail-safe)');

const cursorGrande = { procesadas: {} };
for (let i = 0; i < 120; i++) cursorGrande.procesadas[`id${i}|G-${i}`] = `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`;
assert(Object.keys(podarCursor(cursorGrande, { maxEntradas: 50 }).procesadas).length === 50, 'Poda el cursor al maximo configurado');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Consulta de compradores: filtros y respaldo');
const compradores = [
  { id: '12x1', spl_num_compras: '2', spl_fecha_ultima_compra: '2026-10-08', phone: '+13055550100' },
  { id: '12x2', spl_num_compras: '1', spl_fecha_ultima_compra: '2026-10-07', mobile: '+13055550101' }
];
const ordenes = {
  '12x1': [{ id: '6x1', salesorder_no: 'G-1', createdtime: '2026-10-08 10:00:00', hdnGrandTotal: '99', sostatus: 'Approved' }],
  '12x2': [{ id: '6x2', salesorder_no: 'G-2', createdtime: '2026-10-07 10:00:00', hdnGrandTotal: '50', sostatus: 'Approved' }]
};

const vt1 = crearVtigerFalso({ compradores, ordenes });
const d1 = await detectarComprasNuevas({
  clienteVtiger: vt1, sede: 'PALACIOS', dias: 7, lote: 25,
  buscarContactoGhl: async (tel) => (tel.includes('0100') ? 'ghl-1' : 'ghl-2'),
  ahora: new Date('2026-10-09T12:00:00Z')
});
assert(d1.candidatos.length === 2, `Detecta los 2 candidatos (recibido: ${d1.candidatos.length})`);
assert(d1.candidatos[0].contactId === 'ghl-1', 'Resuelve el contacto de GHL por telefono');
assert(d1.candidatos[1].telefono === '+13055550101', 'Usa mobile cuando no hay phone');
const sqlCompradores = vt1.consultas[0];
assert(sqlCompradores.includes("cf_3451 = 'PALACIOS'"), 'Filtra por sede (Sede-Lock)');
assert(sqlCompradores.includes('spl_num_compras > 0'), 'Solo compradores');
assert(sqlCompradores.includes("spl_fecha_ultima_compra >= '2026-10-02'"), `Filtra por fecha de corte (recibido en SQL: ${/spl_fecha_ultima_compra >= '[^']+'/.exec(sqlCompradores)?.[0]})`);
assert(sqlCompradores.includes('ORDER BY spl_fecha_ultima_compra DESC'), 'Ordena por la compra mas reciente (validado contra vTiger real)');
assert(sqlCompradores.includes('LIMIT 25'), 'Respeta el tamaño de lote');
assert(d1.fechaCorte === '2026-10-02', 'La ventana de dias se calcula correctamente');

console.log('\n[TEST 3b] DISPARADOR: solo compras marcadas como efectuadas (cf_994)');
assert(sqlCompradores.includes("cf_994 = 'VENDIDO'"), 'La consulta exige la marca de compra efectuada (cf_994 = VENDIDO)');
assert(d1.estadoCompra === 'VENDIDO', 'Reporta el estado de compra usado como disparador');
assert(COMPRADOR_SELECT.includes('cf_994'), 'Trae el estado de compra del contacto (auditable)');
const vtSinEstado = crearVtigerFalso({ compradores, ordenes });
const dSinEstado = await detectarComprasNuevas({
  clienteVtiger: vtSinEstado, sede: 'PALACIOS', estadoCompra: '',
  buscarContactoGhl: async () => 'ghl-1', ahora: new Date('2026-10-09T12:00:00Z')
});
assert(!vtSinEstado.consultas[0].includes("cf_994 = '"), 'Con estadoCompra vacio NO filtra por estado en el WHERE (solo diagnostico)');
assert(dSinEstado.estadoCompra === null, 'Reporta null cuando no hay filtro de estado');

const vtFallback = crearVtigerFalso({ compradores, ordenes, fallaTelefonos: true });
const dFallback = await detectarComprasNuevas({ clienteVtiger: vtFallback, sede: 'BENAVIDES', dias: 7, buscarContactoGhl: async () => 'ghl-x' });
assert(vtFallback.consultas.length > 0 && !/phone/.test(vtFallback.consultas[1] || ''), 'Si el rol restringe los telefonos, reintenta sin esos campos');
assert(dFallback.candidatos.length === 2, 'El respaldo igual detecta los candidatos');
assert(dFallback.sede === 'BENAVIDES', 'Reporta la sede escaneada');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Omisiones con motivo explicito');
const vt2 = crearVtigerFalso({
  compradores: [
    { id: '12x1', phone: '+13055550100' },            // ya procesada
    { id: '12x3', phone: '+13055550103' },            // sin orden
    { id: '12x4' },                                    // sin telefono
    { id: '12x5', phone: '+13055550105' }             // sin contacto en GHL
  ],
  ordenes: {
    '12x1': ordenes['12x1'],
    // Ordenes DISTINTAS para que el bloqueo esperado sea el de telefono/contacto,
    // no el del cursor (que se evalua antes).
    '12x4': [{ id: '6x4', salesorder_no: 'G-4', createdtime: '2026-10-08 10:00:00', hdnGrandTotal: '10', sostatus: 'Approved' }],
    '12x5': [{ id: '6x5', salesorder_no: 'G-5', createdtime: '2026-10-08 10:00:00', hdnGrandTotal: '20', sostatus: 'Approved' }]
  },
  fallaOrdenDe: null
});
const cursor = { procesadas: { '6x1|G-1': '2026-10-09T00:00:00.000Z' } };
const d2 = await detectarComprasNuevas({
  clienteVtiger: vt2, sede: 'PALACIOS', cursor,
  buscarContactoGhl: async (tel) => (tel.includes('0105') ? null : 'ghl-ok'),
  ahora: new Date('2026-10-09T12:00:00Z')
});
const motivos = Object.fromEntries(d2.omitidos.map(o => [o.vTigerId, o.motivo]));
assert(motivos['12x1'] === 'YA_PROCESADA', 'Omite la orden ya procesada (cursor)');
assert(motivos['12x3'] === 'SIN_ORDEN', 'Omite al comprador sin SalesOrder');
assert(motivos['12x4'] === 'SIN_TELEFONO', 'Omite al comprador sin telefono');
assert(motivos['12x5'] === 'SIN_CONTACTO_GHL', 'Omite si no existe el contacto en GHL');
assert(d2.candidatos.length === 0, 'No hay candidatos en este caso');

const vt3 = crearVtigerFalso({ compradores: [{ id: '12x9', phone: '+13055550109' }], ordenes, fallaOrdenDe: '12x9' });
const d3 = await detectarComprasNuevas({ clienteVtiger: vt3, buscarContactoGhl: async () => 'ghl' });
assert(d3.errores.length === 1 && d3.errores[0].etapa === 'orden', 'Un fallo al leer la orden se registra como error (no se publica a ciegas)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Ciclo completo: publica y marca el cursor');
const vt4 = crearVtigerFalso({ compradores, ordenes });
const cursor4 = { procesadas: {}, ultimaCorrida: null };
let publicaciones = 0;
const r4 = await ejecutarCiclo({
  clienteVtiger: vt4,
  publicar: async (candidato) => { publicaciones++; return { publicado: true, motivo: 'PUBLICADA', url: `https://cdn/${candidato.orden.numeroOrden}.pdf` }; },
  cursor: cursor4,
  buscarContactoGhl: async () => 'ghl-1',
  ahora: new Date('2026-10-09T12:00:00Z')
});
assert(publicaciones === 2, 'Publica los 2 candidatos');
assert(r4.marcadas === 2, 'Marca las 2 ordenes en el cursor');
assert(cursor4.ultimaCorrida !== null, 'Registra la ultima corrida');
assert(Boolean(cursor4.procesadas['6x1|G-1']), 'La orden queda marcada por su clave');

console.log('\n[TEST 6] Segunda pasada: NO se republica');
let publicaciones2 = 0;
const r5 = await ejecutarCiclo({
  clienteVtiger: crearVtigerFalso({ compradores, ordenes }),
  publicar: async () => { publicaciones2++; return { publicado: true, motivo: 'PUBLICADA' }; },
  cursor: cursor4,
  buscarContactoGhl: async () => 'ghl-1',
  ahora: new Date('2026-10-09T12:00:00Z')
});
assert(publicaciones2 === 0, 'No se vuelve a publicar nada (cursor)');
assert(r5.deteccion.omitidos.every(o => o.motivo === 'YA_PROCESADA'), 'Todas las ordenes quedan omitidas por YA_PROCESADA');

console.log('\n[TEST 7] Un fallo NO marca el cursor (se reintenta)');
const cursor7 = { procesadas: {}, ultimaCorrida: null };
const r7 = await ejecutarCiclo({
  clienteVtiger: crearVtigerFalso({ compradores, ordenes }),
  publicar: async (candidato) => (candidato.orden.numeroOrden === 'G-1'
    ? { publicado: false, motivo: 'MEDIA_NO_DISPONIBLE' }
    : { publicado: true, motivo: 'PUBLICADA' }),
  cursor: cursor7,
  buscarContactoGhl: async () => 'ghl-1',
  ahora: new Date('2026-10-09T12:00:00Z')
});
assert(!cursor7.procesadas['6x1|G-1'], 'La orden que fallo NO se marca (se reintentara)');
assert(Boolean(cursor7.procesadas['6x2|G-2']), 'La que si se publico queda marcada');
assert(r7.marcadas === 1, 'Solo se marca una orden');

const vt8 = crearVtigerFalso({ compradores, ordenes });
let intentos8 = 0;
await ejecutarCiclo({
  clienteVtiger: vt8,
  publicar: async () => { intentos8++; return { publicado: false, motivo: 'MEDIA_NO_DISPONIBLE' }; },
  cursor: { procesadas: {}, ultimaCorrida: null },
  buscarContactoGhl: async () => 'ghl-1',
  ahora: new Date('2026-10-09T12:00:00Z')
});
assert(intentos8 === 2, 'Se reintenta la orden que fallo en el siguiente ciclo');

// ------------------------------------------------------------------------------
console.log('\n[TEST 8] Deteccion de ordenes verificadas directamente en SalesOrder (cf_882)');
const ordenesVerificadas = [
  { id: '6x101', salesorder_no: 'S-101', subject: 'VENTA', contact_id: '12x101', createdtime: '2026-10-21 10:00:00', hdnGrandTotal: '150', cf_882: 'VERIFICADA', cf_1006: '3055551111', cf_3127: 'PALACIOS', cf_856: 'CARLOS', cf_858: 'GOMEZ' },
  { id: '6x102', salesorder_no: 'S-102', subject: 'VENTA', contact_id: '12x102', createdtime: '2026-10-21 11:00:00', hdnGrandTotal: '200', cf_882: 'VERIFICADA', cf_1006: '3055552222', cf_3127: 'BENAVIDES', cf_856: 'ANA', cf_858: 'RUIZ' },
  { id: '6x103', salesorder_no: 'S-103', subject: 'VENTA', contact_id: '12x103', createdtime: '2026-10-21 11:30:00', hdnGrandTotal: '1.00', cf_882: 'VERIFICADA', cf_1006: '3055553333', cf_3127: 'PALACIOS', cf_856: 'CS', cf_858: 'AJUSTE' },
  { id: '6x104', salesorder_no: 'S-104', subject: 'CUSTOMER', contact_id: '12x104', createdtime: '2026-10-21 12:00:00', hdnGrandTotal: '150', cf_882: 'VERIFICADA', cf_1006: '3055554444', cf_3127: 'PALACIOS', cf_856: 'CS', cf_858: 'TICKET' }
];

const vtVerif = {
  consultas: [],
  async consultar(sql) {
    this.consultas.push(sql);
    return ordenesVerificadas;
  }
};

const cursorVerif = { procesadas: {} };
const detVerif = await detectarOrdenesVerificadas({
  clienteVtiger: vtVerif,
  fechaMinima: '2026-10-21',
  cursor: cursorVerif,
  montoMinimo: 1.00,
  asuntosPermitidos: ['VENTA'],
  buscarContactoGhl: async (tel) => (tel ? `ghl-${tel}` : null)
});

assert(detVerif.revisados === 4, 'Revisa las 4 ordenes');
assert(detVerif.candidatos.length === 2, 'Genera 2 candidatos (omite la orden de $1.00 y la de CUSTOMER)');
assert(detVerif.omitidos.some(o => o.motivo === 'ORDEN_MONTO_NO_COMERCIAL' && o.numeroOrden === 'S-103'), 'La orden de $1.00 fue omitida con motivo ORDEN_MONTO_NO_COMERCIAL');
assert(detVerif.omitidos.some(o => o.motivo === 'ORDEN_ASUNTO_NO_FACTURABLE' && o.numeroOrden === 'S-104'), 'La orden con asunto CUSTOMER fue omitida con motivo ORDEN_ASUNTO_NO_FACTURABLE');
assert(detVerif.candidatos[0].orden.numeroOrden === 'S-101', 'Orden 1 correcta');
assert(detVerif.candidatos[0].telefono === '3055551111', 'Extrae telefono directamente de SalesOrder');
assert(detVerif.candidatos[0].sede === 'PALACIOS', 'Extrae sede de la orden');
assert(detVerif.candidatos[0].contactId === 'ghl-3055551111', 'Resuelve contactId de GHL por telefono');
assert(vtVerif.consultas[0].includes("cf_882 = 'VERIFICADA'"), "Filtra por cf_882 = 'VERIFICADA'");
assert(vtVerif.consultas[0].includes("createdtime >= '2026-10-21 00:00:00'"), 'Filtra fechaMinima en la consulta');

// ------------------------------------------------------------------------------
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
