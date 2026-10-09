/**
 * ==============================================================================
 * LOA ENGINE - SUITE DEL ORQUESTADOR DE ENTREGA DE FACTURA
 * ==============================================================================
 * Prueba el caso de uso COMPLETO con dependencias simuladas (cero vTiger, cero
 * GHL): corte temprano, descarga, publicacion, validacion final, escritura del
 * puente y TODOS los modos de fallo.
 *
 * La prueba mas importante es la de IDEMPOTENCIA EXTREMO A EXTREMO: despues de
 * publicar, una segunda pasada NO debe llamar a nada (el cliente no recibe dos
 * mensajes).
 *
 * Ejecucion:  node src/tests/test_invoice_delivery.js
 * ==============================================================================
 */

import { entregarFacturaDeOrden, facturaPdfHabilitada, MOTIVOS_ENTREGA } from '../src/core/invoice_delivery.js';
import { CLAVES_PUENTE_FACTURA, TAG_FACTURA_LISTA } from '../src/core/invoice_bridge.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const PDF = Buffer.from('%PDF-1.4\ncontenido\n%%EOF\n', 'latin1');
const ORDEN = { id: '6x35385', numeroOrden: 'G-04212158' };
const FIELD_IDS = { [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'F_URL', [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: 'F_NUM' };
const CONTACT_ID = 'abc123contacto';

/** Dependencias simuladas con contadores y captura de argumentos. */
function crearDeps({ pdfOk = true, pdfLanza = false, mediaOk = true, mediaMotivo = 'TOKEN_INVALIDO', escrituraOk = true } = {}) {
  const llamadas = [];
  const capturado = {};
  return {
    llamadas, capturado,
    deps: {
      descargarPdf: async (args) => {
        llamadas.push('descargarPdf');
        capturado.descarga = args;
        if (pdfLanza) throw new Error('ECONNRESET con vTiger');
        return pdfOk ? { ok: true, buf: PDF, folderId: '7' } : { ok: false, motivo: 'WEB_LOGIN_REJECTED' };
      },
      subirPdf: async (args) => {
        llamadas.push('subirPdf');
        capturado.subida = args;
        return mediaOk
          ? { ok: true, url: 'https://cdn.ghl.test/factura_G-04212158.pdf', fileId: 'file_1' }
          : { ok: false, motivo: mediaMotivo };
      },
      escribirContacto: async (args) => {
        llamadas.push('escribirContacto');
        capturado.escritura = args;
        return escrituraOk ? { ok: true } : { ok: false, detalle: 'HTTP 400' };
      }
    }
  };
}

console.log('\n==========================================================');
console.log(' [TEST] ORQUESTADOR DE ENTREGA DE FACTURA PDF');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Interruptor general (nace apagado)');
assert(facturaPdfHabilitada({}) === false, 'Sin INVOICE_PDF_ENABLED el flujo esta APAGADO');
assert(facturaPdfHabilitada({ INVOICE_PDF_ENABLED: 'true' }) === true, 'Con INVOICE_PDF_ENABLED=true se habilita');
assert(facturaPdfHabilitada({ INVOICE_PDF_ENABLED: 'TRUE' }) === true, 'Acepta mayusculas');
const t1 = crearDeps();
const r1 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, deps: t1.deps });
assert(r1.motivo === MOTIVOS_ENTREGA.DESACTIVADO, 'Apagado -> motivo DESACTIVADO');
assert(t1.llamadas.length === 0, 'Apagado: no se toca vTiger ni GHL');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Validaciones previas');
const t2 = crearDeps();
const r2 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: '', deps: t2.deps, habilitado: true });
assert(r2.motivo === MOTIVOS_ENTREGA.SIN_CONTACTO, 'Sin contactId -> SIN_CONTACTO');
const r2b = await entregarFacturaDeOrden({ orden: { id: '6x1', numeroOrden: '' }, contactId: CONTACT_ID, deps: t2.deps, habilitado: true });
assert(r2b.motivo === MOTIVOS_ENTREGA.ORDEN_INVALIDA, 'Orden sin numero -> ORDEN_INVALIDA');
const r2c = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, deps: { descargarPdf: () => {} }, habilitado: true });
assert(r2c.motivo === MOTIVOS_ENTREGA.DEPS_INCOMPLETAS, 'Dependencias incompletas -> DEPS_INCOMPLETAS');
assert(t2.llamadas.length === 0, 'Las validaciones previas no tocan la red');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Flujo feliz: PDF -> publicacion -> puente');
const t3 = crearDeps();
const r3 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t3.deps, habilitado: true, sede: 'PALACIOS' });
assert(r3.publicado === true, 'El flujo termina publicado');
assert(r3.motivo === MOTIVOS_ENTREGA.PUBLICADA, 'Motivo PUBLICADA');
assert(r3.url === 'https://cdn.ghl.test/factura_G-04212158.pdf', 'Devuelve la URL publica');
assert(r3.numeroOrden === 'G-04212158', 'Informa el numero de orden publicado');
assert(r3.fileId === 'file_1', 'Informa el fileId de la Media Library');
assert(t3.llamadas.join('>') === 'descargarPdf>subirPdf>escribirContacto', `Orden correcto de los pasos (recibido: ${t3.llamadas.join('>')})`);
assert(t3.capturado.subida.nombreArchivo === 'factura_G-04212158.pdf', 'Sube el PDF con nombre de archivo legible');
assert(t3.capturado.subida.contenido.length === PDF.length, 'Sube los bytes del PDF descargado');
assert(t3.capturado.escritura.contactId === CONTACT_ID, 'Marca el contacto correcto');
assert(t3.capturado.escritura.customFields.find(f => f.id === 'F_URL')?.field_value === r3.url, 'Escribe la URL de la factura en el contacto');
assert(t3.capturado.escritura.customFields.find(f => f.id === 'F_NUM')?.field_value === 'G-04212158', 'Escribe el numero de orden (clave de idempotencia)');
assert(t3.capturado.escritura.tags.includes(TAG_FACTURA_LISTA), `Dispara el workflow con el tag ${TAG_FACTURA_LISTA}`);

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Idempotencia EXTREMO A EXTREMO (el cliente no recibe 2 mensajes)');
// El contacto queda como GHL lo dejo tras el flujo feliz.
const contactoPublicado = {
  customFields: t3.capturado.escritura.customFields.map(f => ({ id: f.id, value: f.field_value })),
  tags: [...t3.capturado.escritura.tags]
};
const t4 = crearDeps();
const r4 = await entregarFacturaDeOrden({ orden: ORDEN, contactoGhl: contactoPublicado, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t4.deps, habilitado: true });
assert(r4.publicado === false && r4.motivo === MOTIVOS_ENTREGA.YA_PUBLICADA, 'Segunda pasada -> YA_PUBLICADA');
assert(t4.llamadas.length === 0, 'Segunda pasada: NO se descarga, NO se sube, NO se reescribe (0 llamadas)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] Recompra: una orden nueva del mismo cliente SI se publica');
const t5 = crearDeps();
const r5 = await entregarFacturaDeOrden({ orden: { id: '7x1', numeroOrden: 'G-04212159' }, contactoGhl: contactoPublicado, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t5.deps, habilitado: true });
assert(r5.publicado === true, 'Una orden nueva (G-04212159) se publica aunque el cliente ya tenga otra factura');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Fallos de la descarga del PDF');
const t6 = crearDeps({ pdfOk: false });
const r6 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t6.deps, habilitado: true });
assert(r6.motivo === MOTIVOS_ENTREGA.PDF_NO_DISPONIBLE, 'PDF no disponible -> PDF_NO_DISPONIBLE');
assert(!t6.llamadas.includes('subirPdf') && !t6.llamadas.includes('escribirContacto'), 'Si no hay PDF, no se sube ni se marca el contacto');

const t6b = crearDeps({ pdfLanza: true });
const r6b = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t6b.deps, habilitado: true });
assert(r6b.motivo === MOTIVOS_ENTREGA.PDF_NO_DISPONIBLE, 'Una excepcion de red en la descarga no se propaga (fail-safe)');
assert(r6b.detalle === 'EXCEPCION_DESCARGA', 'El detalle identifica la excepcion para la auditoria');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Fallo de la publicacion (token/scope)');
const t7 = crearDeps({ mediaOk: false, mediaMotivo: 'TOKEN_INVALIDO' });
const r7 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t7.deps, habilitado: true });
assert(r7.motivo === MOTIVOS_ENTREGA.MEDIA_NO_DISPONIBLE, 'Sin URL publica -> MEDIA_NO_DISPONIBLE');
assert(r7.detalle === 'TOKEN_INVALIDO', 'Conserva el motivo real (TOKEN_INVALIDO) para el diagnostico');
assert(!t7.llamadas.includes('escribirContacto'), 'NO se marca el contacto si no hay URL (no se dispara el workflow)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 8] Fallo al marcar el contacto (el workflow no se dispara)');
const t8 = crearDeps({ escrituraOk: false });
const r8 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: FIELD_IDS, deps: t8.deps, habilitado: true });
assert(r8.motivo === MOTIVOS_ENTREGA.ESCRITURA_FALLIDA, 'Escritura fallida -> ESCRITURA_FALLIDA');
assert(r8.publicado === false, 'No se reporta publicado');
assert(r8.url === 'https://cdn.ghl.test/factura_G-04212158.pdf', 'Conserva la URL para poder reintentar sin volver a subir el archivo');

// ------------------------------------------------------------------------------
console.log('\n[TEST 9] Trazabilidad de pasos');
assert(Array.isArray(r3.pasos) && r3.pasos.includes('pdf_ok') && r3.pasos.includes('media_ok') && r3.pasos.includes('escritura_ok'), 'El resultado exitoso lista sus pasos');
assert(r6.pasos.includes('pdf_fallido'), 'El fallo de PDF queda trazado');
assert(r7.pasos.includes('media_fallida'), 'El fallo de publicacion queda trazado');

// ------------------------------------------------------------------------------
console.log('\n[TEST 10] Fail-safe de campos no resueltos');
const t10 = crearDeps();
const r10 = await entregarFacturaDeOrden({ orden: ORDEN, contactId: CONTACT_ID, fieldIds: {}, deps: t10.deps, habilitado: true });
assert(r10.motivo === MOTIVOS_ENTREGA.DEPS_INCOMPLETAS, 'Sin campos puente resueltos NO se escribe nada (no se dispara el workflow a ciegas)');
assert(!t10.llamadas.includes('escribirContacto'), 'No se llama a la escritura sin campos');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
