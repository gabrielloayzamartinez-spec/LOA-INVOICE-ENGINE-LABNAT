/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL PUENTE DE FACTURA PDF (idempotencia del envio)
 * ==============================================================================
 * Blinda la decision MAS PELIGROSA del flujo: publicar (y por lo tanto disparar
 * el workflow que manda un WhatsApp/SMS REAL al cliente) o NO publicar.
 *
 * Lo que se prueba aqui es logica PURA: cero red, cero vTiger, cero GHL.
 *   1. Compra nueva -> se publica.
 *   2. La MISMA orden repetida -> NO se publica (idempotencia).
 *   3. Recompra (numero distinto) -> SI se publica.
 *   4. Sin PDF, sin numero o sin id -> NO se publica, con motivo explicito.
 *   5. Payload: campos con IDs resueltos + tag disparador.
 *   6. Fail-safe: un ID no resuelto no se manda inventado.
 *   7. Nombre de archivo seguro.
 *   8. Ciclo completo: publicar -> releer el contacto -> no volver a publicar.
 *
 * Ejecucion:  node tests/test_invoice_bridge.js
 * ==============================================================================
 */

import {
  decidirPublicacion, construirPuenteFactura, construirCierreEnvio,
  leerEstadoPuenteFactura, nombreArchivoFactura,
  TAG_FACTURA_LISTA, TAG_FACTURA_ENVIADA, CLAVES_PUENTE_FACTURA, MOTIVOS_PUBLICACION
} from '../src/core/invoice_bridge.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] PUENTE DE FACTURA PDF (idempotencia del envio)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
const ORDEN = { id: '6x35385', numeroOrden: 'G-04212158', total: '160.00000000' };
const URL_PDF = 'https://cdn.example.com/factura_G-04212158.pdf';
const FIELD_IDS = { [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'F_URL', [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: 'F_NUM' };

// ------------------------------------------------------------------------------
console.log('[TEST 1] Compra nueva: se publica');
const d1 = decidirPublicacion({ orden: ORDEN, estadoActual: {}, urlPdf: URL_PDF });
assert(d1.publicar === true, 'Una compra nueva se publica');
assert(d1.motivo === MOTIVOS_PUBLICACION.COMPRA_NUEVA, `El motivo es COMPRA_NUEVA (recibido: ${d1.motivo})`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Idempotencia: la MISMA orden no se republica');
const estadoPublicado = { facturaNumeroOrden: 'G-04212158', urlFacturaPdf: URL_PDF, tags: [TAG_FACTURA_LISTA] };
const d2 = decidirPublicacion({ orden: ORDEN, estadoActual: estadoPublicado, urlPdf: URL_PDF });
assert(d2.publicar === false, 'La misma orden NO se vuelve a publicar');
assert(d2.motivo === MOTIVOS_PUBLICACION.YA_PUBLICADA, `El motivo es YA_PUBLICADA (recibido: ${d2.motivo})`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Recompra: numero de orden distinto SI se publica');
const recompra = { id: '7x99999', numeroOrden: 'G-04212159' };
const d3 = decidirPublicacion({ orden: recompra, estadoActual: estadoPublicado, urlPdf: URL_PDF });
assert(d3.publicar === true, 'Una orden nueva del mismo cliente se publica (recompra)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Bloqueos por datos faltantes (motivo explicito)');
const sinPdf = decidirPublicacion({ orden: ORDEN, estadoActual: {}, urlPdf: '' });
assert(sinPdf.publicar === false && sinPdf.motivo === MOTIVOS_PUBLICACION.SIN_PDF, 'Sin PDF no se publica (SIN_PDF)');
const sinNumero = decidirPublicacion({ orden: { id: '6x1', numeroOrden: '' }, estadoActual: {}, urlPdf: URL_PDF });
assert(sinNumero.publicar === false && sinNumero.motivo === MOTIVOS_PUBLICACION.ORDEN_SIN_NUMERO, 'Sin numero de orden no se publica (ORDEN_SIN_NUMERO)');
const sinId = decidirPublicacion({ orden: { id: '', numeroOrden: 'G-1' }, estadoActual: {}, urlPdf: URL_PDF });
assert(sinId.publicar === false && sinId.motivo === MOTIVOS_PUBLICACION.ORDEN_SIN_ID, 'Sin id de orden no se publica (ORDEN_SIN_ID)');

console.log('\n[TEST 4b] Corte temprano: decidir ANTES de descargar el PDF');
const corteNuevo = decidirPublicacion({ orden: ORDEN, estadoActual: {}, urlPdf: '', requerirPdf: false });
assert(corteNuevo.publicar === true, 'Orden nueva sin PDF aun: se permite continuar (no exige la URL en el corte temprano)');
const corteYa = decidirPublicacion({ orden: ORDEN, estadoActual: estadoPublicado, urlPdf: '', requerirPdf: false });
assert(corteYa.publicar === false && corteYa.motivo === MOTIVOS_PUBLICACION.YA_PUBLICADA, 'Orden ya publicada: se bloquea ANTES de descargar y subir el PDF (ahorra trabajo)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Payload del puente: campos resueltos + tag disparador');
const puente = construirPuenteFactura({ urlPdf: URL_PDF, numeroOrden: ORDEN.numeroOrden, fieldIds: FIELD_IDS });
assert(puente.customFields.length === 2, 'Se envian los 2 campos puente');
assert(puente.customFields.find(f => f.id === 'F_URL')?.field_value === URL_PDF, 'El campo URL lleva la URL publica');
assert(puente.customFields.find(f => f.id === 'F_NUM')?.field_value === 'G-04212158', 'El campo numero lleva el numero de orden (idempotencia)');
assert(puente.tags.includes(TAG_FACTURA_LISTA), `El payload dispara el workflow con el tag ${TAG_FACTURA_LISTA}`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Fail-safe: un ID no resuelto NO se manda inventado');
const puenteParcial = construirPuenteFactura({ urlPdf: URL_PDF, numeroOrden: 'G-1', fieldIds: { [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'F_URL' } });
assert(puenteParcial.customFields.length === 1, 'Solo se envia el campo cuyo ID fue resuelto');
assert(puenteParcial.customFields[0].id === 'F_URL', 'El campo enviado es el resuelto');
let lanzo = false;
try { construirPuenteFactura({ urlPdf: '', numeroOrden: '', fieldIds: FIELD_IDS }); } catch (e) { lanzo = e instanceof TypeError; }
assert(lanzo, 'Faltando URL/numero lanza TypeError (error de programacion, no se envia nada)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Nombre de archivo seguro');
assert(nombreArchivoFactura('G-04212158') === 'factura_G-04212158.pdf', 'Conserva el numero de orden limpio');
assert(nombreArchivoFactura('G 0421/2158') === 'factura_G_0421_2158.pdf', 'Neutraliza espacios y barras (URL-safe)');
assert(nombreArchivoFactura('') === 'factura_sin-numero.pdf', 'Sin numero usa un nombre generico seguro');

// ------------------------------------------------------------------------------
console.log('\n[TEST 8] Lectura del estado puente desde GHL');
const contactoGhl = {
  customFields: [
    { id: 'F_URL', value: URL_PDF },
    { key: 'contact.factura_numero_orden', field_value: 'G-04212158' }
  ],
  tags: [TAG_FACTURA_LISTA, 'otro-tag']
};
const estado = leerEstadoPuenteFactura(contactoGhl, FIELD_IDS);
assert(estado.urlFacturaPdf === URL_PDF, 'Lee el valor por id (forma value)');
assert(estado.facturaNumeroOrden === 'G-04212158', 'Lee el valor por key (forma field_value)');
assert(estado.tags.includes(TAG_FACTURA_LISTA), 'Devuelve los tags del contacto');
const estadoVacio = leerEstadoPuenteFactura({}, FIELD_IDS);
assert(estadoVacio.facturaNumeroOrden === '' && estadoVacio.urlFacturaPdf === '', 'Un contacto sin campos devuelve estado vacio (no rompe)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 9] Ciclo completo: publicar -> releer -> NO republicar');
// 1) Primera pasada con un contacto recien creado (sin campos puente).
let contacto = { customFields: [], tags: [] };
let estadoCiclo = leerEstadoPuenteFactura(contacto, FIELD_IDS);
const primera = decidirPublicacion({ orden: ORDEN, estadoActual: estadoCiclo, urlPdf: URL_PDF });
assert(primera.publicar === true, 'Primera pasada: se publica');

// 2) GHL aplica el payload: el contacto queda con los campos y el tag.
const payload = construirPuenteFactura({ urlPdf: URL_PDF, numeroOrden: ORDEN.numeroOrden, fieldIds: FIELD_IDS });
contacto = {
  customFields: payload.customFields.map(f => ({ id: f.id, value: f.field_value })),
  tags: [...payload.tags]
};

// 3) Segunda pasada (el scheduler vuelve a pasar por el mismo contacto).
estadoCiclo = leerEstadoPuenteFactura(contacto, FIELD_IDS);
const segunda = decidirPublicacion({ orden: ORDEN, estadoActual: estadoCiclo, urlPdf: URL_PDF });
assert(segunda.publicar === false, 'Segunda pasada: NO se republica (el cliente no recibe 2 mensajes)');
assert(segunda.motivo === MOTIVOS_PUBLICACION.YA_PUBLICADA, 'El bloqueo queda auditado con motivo YA_PUBLICADA');

// ------------------------------------------------------------------------------
console.log('\n[TEST 10] Cierre del envio: marca enviada y limpia el disparador');
const cierre = construirCierreEnvio();
assert(cierre.agregar.includes(TAG_FACTURA_ENVIADA), `Agrega ${TAG_FACTURA_ENVIADA}`);
assert(cierre.quitar.includes(TAG_FACTURA_LISTA), `Quita ${TAG_FACTURA_LISTA} (evita re-disparo del workflow)`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 11] Candados de seguridad: status no verificado, total cero y fecha anterior');
const noVerificada = decidirPublicacion({
  orden: { ...ORDEN, estadoLogistico: 'CONFIRMADA' },
  estadoActual: {},
  urlPdf: URL_PDF,
  estadoLogisticoRequerido: 'VERIFICADA'
});
assert(noVerificada.publicar === false && noVerificada.motivo === MOTIVOS_PUBLICACION.ORDEN_NO_VERIFICADA, 'Rechaza orden no verificada (ORDEN_NO_VERIFICADA)');

const totalCero = decidirPublicacion({
  orden: { ...ORDEN, total: '0.00' },
  estadoActual: {},
  urlPdf: URL_PDF
});
assert(totalCero.publicar === false && totalCero.motivo === MOTIVOS_PUBLICACION.ORDEN_TOTAL_INVALIDO, 'Rechaza orden con total <= 0 (ORDEN_TOTAL_INVALIDO)');

const fechaVieja = decidirPublicacion({
  orden: { ...ORDEN, fecha: '2026-10-15' },
  estadoActual: {},
  urlPdf: URL_PDF,
  fechaMinima: '2026-10-21'
});
assert(fechaVieja.publicar === false && fechaVieja.motivo === MOTIVOS_PUBLICACION.ORDEN_ANTERIOR_A_FECHA_CORTE, 'Rechaza orden anterior a fechaMinima (ORDEN_ANTERIOR_A_FECHA_CORTE)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 12] Candado de monto comercial: ordenes <= $1.00 de Customer Service');
const ordenUnDolar = decidirPublicacion({
  orden: { ...ORDEN, total: '1.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  montoMinimo: 1.00
});
assert(ordenUnDolar.publicar === false && ordenUnDolar.motivo === MOTIVOS_PUBLICACION.ORDEN_MONTO_NO_COMERCIAL, 'Omite orden de $1.00 de CS (ORDEN_MONTO_NO_COMERCIAL)');

const ordenCentavos = decidirPublicacion({
  orden: { ...ORDEN, total: '0.99' },
  estadoActual: {},
  urlPdf: URL_PDF,
  montoMinimo: 1.00
});
assert(ordenCentavos.publicar === false && ordenCentavos.motivo === MOTIVOS_PUBLICACION.ORDEN_MONTO_NO_COMERCIAL, 'Omite orden de $0.99 (ORDEN_MONTO_NO_COMERCIAL)');

const ordenValida = decidirPublicacion({
  orden: { ...ORDEN, total: '1.50' },
  estadoActual: {},
  urlPdf: URL_PDF,
  montoMinimo: 1.00
});
assert(ordenValida.publicar === true, 'Permite orden comercial > $1.00');

// ------------------------------------------------------------------------------
console.log('\n[TEST 13] Candado de Asunto: solo VENTA autorizada (omite CUSTOMER, MUESTRA GRATIS, CHARGEBACK)');
const ordenVenta = decidirPublicacion({
  orden: { ...ORDEN, asunto: 'VENTA', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  asuntosPermitidos: ['VENTA']
});
assert(ordenVenta.publicar === true, 'Permite orden con asunto VENTA');

const ordenCustomer = decidirPublicacion({
  orden: { ...ORDEN, asunto: 'CUSTOMER', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  asuntosPermitidos: ['VENTA']
});
assert(ordenCustomer.publicar === false && ordenCustomer.motivo === MOTIVOS_PUBLICACION.ORDEN_ASUNTO_NO_FACTURABLE, 'Omite orden con asunto CUSTOMER');

const ordenMuestra = decidirPublicacion({
  orden: { ...ORDEN, asunto: 'MUESTRA GRATIS', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  asuntosPermitidos: ['VENTA']
});
assert(ordenMuestra.publicar === false && ordenMuestra.motivo === MOTIVOS_PUBLICACION.ORDEN_ASUNTO_NO_FACTURABLE, 'Omite orden con asunto MUESTRA GRATIS');

const ordenChargeback = decidirPublicacion({
  orden: { ...ORDEN, asunto: 'CHARGEBACK', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  asuntosPermitidos: ['VENTA']
});
assert(ordenChargeback.publicar === false && ordenChargeback.motivo === MOTIVOS_PUBLICACION.ORDEN_ASUNTO_NO_FACTURABLE, 'Omite orden con asunto CHARGEBACK');

// ------------------------------------------------------------------------------
console.log('\n[TEST 14] Candado de Día Operativo: solo compras del día en curso (00:00:00 a 23:59:59)');
const ordenAyer = decidirPublicacion({
  orden: { ...ORDEN, createdtime: '2026-10-22 23:59:59', fecha: '2026-10-22', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  soloDiaOperativo: true,
  diaOperativo: '2026-10-23'
});
assert(ordenAyer.publicar === false && ordenAyer.motivo === MOTIVOS_PUBLICACION.ORDEN_FUERA_DE_DIA_OPERATIVO, 'Bloquea orden de día anterior cuando soloDiaOperativo está activo');

const ordenHoyMismoDia = decidirPublicacion({
  orden: { ...ORDEN, createdtime: '2026-10-23 11:30:00', fecha: '2026-10-23', total: '150.00' },
  estadoActual: {},
  urlPdf: URL_PDF,
  soloDiaOperativo: true,
  diaOperativo: '2026-10-23'
});
assert(ordenHoyMismoDia.publicar === true, 'Permite orden del Día Operativo en curso');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;

