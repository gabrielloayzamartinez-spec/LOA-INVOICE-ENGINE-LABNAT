/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DE MENSAJES GHL (CONVERSATIONS API)
 * ==============================================================================
 * Verifica la construccion de texto de mensaje y la llamada segura a la API
 * de conversaciones de GHL sin dependencias de red.
 *
 * Ejecucion:  node tests/test_ghl_messages.js
 * ==============================================================================
 */

import {
  construirTextoMensaje,
  enviarMensajeFacturaGhl,
  MOTIVOS_MENSAJE,
  PLANTILLA_SMS_DEFECTO
} from '../src/connectors/ghl_messages.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

console.log('\n==========================================================');
console.log(' [TEST] CONECTOR DE MENSAJES GHL (CONVERSATIONS API)');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Construccion del texto del mensaje');
const msg = construirTextoMensaje({
  nombre: 'Daniel Ramirez',
  numeroOrden: 'S-97413',
  urlPdf: 'https://cdn.ghl.test/factura.pdf'
});
assert(msg.includes('Daniel Ramirez'), 'Reemplaza el nombre');
assert(msg.includes('S-97413'), 'Reemplaza el numero de orden');
assert(msg.includes('https://cdn.ghl.test/factura.pdf'), 'Reemplaza la URL del PDF');
assert(!msg.includes('Canal automático de notificaciones'), 'Omite el aviso de no responder canal automatico');

// Test de asignacion de telefonos por sede:
const msgPalacios = construirTextoMensaje({ nombre: 'Juan', numeroOrden: 'S-1', urlPdf: 'https://url', sede: 'PALACIOS' });
assert(msgPalacios.includes('888-297-4325'), 'Palacios asigna 888-297-4325');

const msgBenavides = construirTextoMensaje({ nombre: 'Maria', numeroOrden: 'S-2', urlPdf: 'https://url', sede: 'BENAVIDES' });
assert(msgBenavides.includes('888-720-0078'), 'Benavides asigna 888-720-0078');

const msgRoosevelt = construirTextoMensaje({ nombre: 'Pedro', numeroOrden: 'S-3', urlPdf: 'https://url', sede: 'ROOSEVELT' });
assert(msgRoosevelt.includes('888-513-0310'), 'Roosevelt asigna 888-513-0310');

const msgPiura = construirTextoMensaje({ nombre: 'Ana', numeroOrden: 'S-4', urlPdf: 'https://url', sede: 'PIURA' });
assert(msgPiura.includes('661-242-5576'), 'Piura asigna 661-242-5576');

const msgCustom = construirTextoMensaje({
  nombre: 'Carlos',
  numeroOrden: 'ORD-1',
  urlPdf: 'https://test.com',
  plantilla: 'Estimado {nombre}, orden {numeroOrden} en {urlPdf}'
});
assert(msgCustom === 'Estimado Carlos, orden ORD-1 en https://test.com', 'Respeta plantilla personalizada');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Envio con parametros incompletos: fail-safe');
const r1 = await enviarMensajeFacturaGhl({ contactId: '', mensaje: 'hola', apiKey: 'key' });
assert(r1.ok === false && r1.motivo === MOTIVOS_MENSAJE.PARAMS_INCOMPLETOS, 'Falta contactId');

const r2 = await enviarMensajeFacturaGhl({ contactId: 'c1', mensaje: '', apiKey: 'key' });
assert(r2.ok === false && r2.motivo === MOTIVOS_MENSAJE.PARAMS_INCOMPLETOS, 'Falta mensaje');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Envio exitoso simulado');
let peticionCapturada = null;
const fetchMock = async (url, opts) => {
  peticionCapturada = { url, opts, body: JSON.parse(opts.body) };
  return {
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ messageId: 'msg-12345' })
  };
};

const rOk = await enviarMensajeFacturaGhl({
  contactId: 'contact-abc',
  mensaje: 'Tu factura esta lista',
  apiKey: 'pit-test',
  fetchImpl: fetchMock
});

assert(rOk.ok === true, 'Envio exitoso devuelve ok: true');
assert(rOk.messageId === 'msg-12345', 'Retorna el messageId');
assert(peticionCapturada.body.type === 'SMS', 'Tipo por defecto es SMS');
assert(peticionCapturada.body.contactId === 'contact-abc', 'Envia el contactId correcto');
assert(peticionCapturada.body.message === 'Tu factura esta lista', 'Envia el mensaje correcto');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Fallo de servidor de GHL');
const fetchError = async () => ({
  ok: false,
  status: 500,
  text: async () => JSON.stringify({ message: 'Internal Server Error' })
});

const rError = await enviarMensajeFacturaGhl({
  contactId: 'contact-abc',
  mensaje: 'hola',
  apiKey: 'pit-test',
  fetchImpl: fetchError
});
assert(rError.ok === false, 'Maneja error de GHL');
assert(rError.status === 500, 'Registra el status HTTP');
assert(rError.motivo === MOTIVOS_MENSAJE.RECHAZADO, 'Motivo rechazado');

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exit(1);
