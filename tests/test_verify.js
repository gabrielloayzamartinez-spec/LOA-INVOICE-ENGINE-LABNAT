/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DE LA VERIFICACION CONTRA VTIGER
 * ==============================================================================
 * El instrumento de control debe distinguir tres situaciones distintas:
 *   1. El invoice coincide con vTiger            -> consistente.
 *   2. Los datos NO coinciden                    -> DIFERENTE (error a corregir).
 *   3. vTiger NO entrego el dato (permisos)      -> FALTA EN VTIGER (no es "OK").
 *
 * El caso 3 es el real: el rol de API no permite leer cf_870 y el invoice saldria
 * sin direccion. Si el verificador lo diera por bueno, el control no serviria.
 *
 * Ejecucion:  node tests/test_verify.js
 * ==============================================================================
 */

import { compararInvoiceConVtiger, formatearVerificacion } from '../src/core/invoice_verify.js';
import { construirModeloInvoice } from '../src/core/invoice_render.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const ORDEN = {
  id: '6x35385', numeroOrden: 'S-96567', fecha: '2026-10-03', total: '210.00000000',
  producto: 'CELULAS MADRES 60 CAPS', cantidad: '4,00'
};
const CONTACTO = {
  firstname: 'ELIZABETH', lastname: 'CRUZ', phone: '4076935971',
  cf_870: 'PO BOX 229', cf_872: '33848', cf_876: 'INTERCESSION CITY', cf_1053: 'FL-Florida'
};

console.log('\n==========================================================');
console.log(' [TEST] VERIFICACION DEL INVOICE CONTRA VTIGER');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Invoice consistente con vTiger');
const modeloOk = construirModeloInvoice({ orden: ORDEN, contacto: CONTACTO });
const rOk = compararInvoiceConVtiger({ orden: ORDEN, contacto: CONTACTO, modelo: modeloOk });
assert(rOk.consistente === true, 'Con datos completos el invoice es CONSISTENTE');
assert(rOk.diferencias.length === 0, 'No reporta diferencias');
assert(rOk.faltantesEnVtiger.length === 0, 'No reporta datos faltantes en vTiger');
assert(rOk.campos.length >= 7, `Compara todos los campos relevantes (${rOk.campos.length})`);
const nombres = rOk.campos.map(c => c.campo);
for (const esperado of ['Numero de invoice', 'Fecha', 'Total', 'Nombre del cliente', 'Producto', 'Cantidad', 'Direccion de envio', 'Telefono']) {
  assert(nombres.includes(esperado), `Compara el campo: ${esperado}`);
}

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Un total distinto se detecta como DIFERENTE');
const ordenMala = { ...ORDEN, total: '999.00' };
const modeloMalo = construirModeloInvoice({ orden: ordenMala, contacto: CONTACTO });
const rMalo = compararInvoiceConVtiger({ orden: ordenMala, contacto: CONTACTO, modelo: modeloMalo });
assert(rMalo.consistente === true, 'Si vTiger y el invoice dicen lo MISMO, la verificacion pasa (compara, no adivina)');
const campoTotal = rMalo.campos.find(c => c.campo === 'Total');
assert(campoTotal.enVtiger === '999,00' && campoTotal.enInvoice === '999,00' && campoTotal.ok === true, 'Si el modelo se genero con el mismo dato, el total coincide (el modelo es la fuente del PDF)');

const rDesfasado = compararInvoiceConVtiger({ orden: ORDEN, contacto: CONTACTO, modelo: modeloMalo });
assert(rDesfasado.consistente === false, 'Si vTiger cambio y el invoice quedo viejo, la verificacion lo detecta');
assert(rDesfasado.diferencias.includes('Total'), 'Nombre la diferencia: Total');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] vTiger no entrega un dato (permisos) -> FALTA EN VTIGER, no OK');
const contactoSinDireccion = { firstname: 'ELIZABETH', lastname: 'CRUZ', phone: '4076935971' }; // cf_870 denegado
const modeloSinDireccion = construirModeloInvoice({ orden: ORDEN, contacto: contactoSinDireccion });
const rSinDir = compararInvoiceConVtiger({ orden: ORDEN, contacto: contactoSinDireccion, modelo: modeloSinDireccion });
assert(rSinDir.consistente === false, 'No se declara consistente cuando falta un dato');
assert(rSinDir.faltantesEnVtiger.includes('Direccion de envio'), 'Reporta la direccion como FALTA EN VTIGER');
assert(!rSinDir.diferencias.includes('Direccion de envio'), 'No la cuenta como diferencia (vTiger simplemente no la dio)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Numero de invoice distinto (orden equivocada)');
const modeloOtro = construirModeloInvoice({ orden: { ...ORDEN, numeroOrden: 'S-00000' }, contacto: CONTACTO });
const rOtro = compararInvoiceConVtiger({ orden: ORDEN, contacto: CONTACTO, modelo: modeloOtro });
assert(rOtro.diferencias.includes('Numero de invoice'), 'Detecta que el invoice es de otra orden');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] La tabla de verificacion es legible');
const tabla = formatearVerificacion(rOk);
assert(tabla.includes('CAMPO') && tabla.includes('VTIGER') && tabla.includes('INVOICE'), 'Incluye encabezados');
assert(tabla.includes('Numero de invoice') && tabla.includes('OK'), 'Muestra cada campo con su estado');
const tablaFalta = formatearVerificacion(rSinDir);
assert(tablaFalta.includes('FALTA EN VTIGER'), 'Marca los datos que vTiger no entrego');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Fail-safe del instrumento');
let lanzo = false;
try { compararInvoiceConVtiger({ orden: ORDEN, contacto: CONTACTO }); } catch (e) { lanzo = e instanceof TypeError; }
assert(lanzo, 'Sin modelo lanza TypeError (error de programacion)');
const vacio = compararInvoiceConVtiger({ orden: {}, contacto: {}, modelo: construirModeloInvoice({ orden: {}, contacto: {} }) });
assert(vacio.consistente === false, 'Con todo vacio NO se declara consistente (fail-safe)');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
