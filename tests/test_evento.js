/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL DISPARADOR UNICO (EVENTO POR WEBHOOK)
 * ==============================================================================
 * Verifica el camino SIN barrido:
 *   1. Normalizacion del payload del evento (formas reales de CRM/sync).
 *   2. Atencion de UN evento: resuelve la orden y publica ESA factura.
 *   3. Idempotencia: evento duplicado -> YA_PUBLICADA sin republicar.
 *   4. Eventos invalidos: sin datos, orden inexistente, contacto inexistente.
 *   5. Codigos HTTP (para que el CRM reintente solo cuando corresponde).
 *   6. Servidor HTTP REAL: salud, token obligatorio, evento valido, errores.
 *
 * Ejecucion:  node tests/test_evento.js
 * ==============================================================================
 */

import { atenderEventoCompra, normalizarEventoCompra, MOTIVOS_EVENTO } from '../src/jobs/atender_evento.js';
import { crearServidorEventos, iniciarServidorEventos, codigoHttpParaResultado } from '../src/webhook_server.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const TOKEN = 'token-de-prueba';
const ORDEN = { id: '6x1', salesorder_no: 'S-96567', contact_id: '12x1', createdtime: '2026-10-03 10:00:00', hdnGrandTotal: '210', sostatus: '', cf_1069: 'Artritis', cf_3156: 'CELULAS MADRES 60 CAPS', cf_3298: '4' };

/** vTiger simulado: responde ordenes y contactos. */
function crearVtigerFalso({ ordenes = { '6x1': [ORDEN] }, contactos = { '12x1': { id: '12x1', phone: '4076935971' } } } = {}) {
  const consultas = [];
  return {
    consultas,
    async consultar(sql) {
      consultas.push(sql);
      if (/FROM SalesOrder/i.test(sql)) {
        const mId = /id = '([^']+)'/.exec(sql);
        if (mId) return ordenes[mId[1]] || [];
        const mNum = /salesorder_no = '([^']+)'/.exec(sql);
        if (mNum) return Object.values(ordenes).flat().filter(o => o.salesorder_no === mNum[1]);
        return [];
      }
      if (/FROM Contacts/i.test(sql)) {
        const m = /id = '([^']+)'/.exec(sql);
        return (m && contactos[m[1]]) ? [contactos[m[1]]] : [];
      }
      return [];
    }
  };
}

/** Publicador simulado con una cola de motivos. */
function crearPublicar(motivos = []) {
  const llamadas = [];
  return {
    llamadas,
    fn: async ({ contactId, orden, sede }) => {
      llamadas.push({ contactId, numeroOrden: orden.numeroOrden, sede });
      const motivo = motivos.shift() || 'PUBLICADA';
      return motivo === 'PUBLICADA'
        ? { publicado: true, motivo, url: `https://cdn.ghl.test/INVOICE_${orden.numeroOrden}.pdf`, numeroOrden: orden.numeroOrden }
        : { publicado: false, motivo, url: null, detalle: null, numeroOrden: orden.numeroOrden };
    }
  };
}

console.log('\n==========================================================');
console.log(' [TEST] DISPARADOR UNICO: EVENTO DE COMPRA POR WEBHOOK');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Normalizacion del payload del evento');
assert(normalizarEventoCompra({ salesorder_id: '6x1' }).ordenId === '6x1', 'Lee salesorder_id');
assert(normalizarEventoCompra({ record: '6x1' }).ordenId === '6x1', 'Lee record (formato vTiger)');
assert(normalizarEventoCompra({ salesorder_no: 'S-96567' }).numeroOrden === 'S-96567', 'Lee salesorder_no');
assert(normalizarEventoCompra({ numero: 'S-1' }).numeroOrden === 'S-1', 'Lee numero');
assert(normalizarEventoCompra({ event: 'vtiger.entity.aftersave', data: { salesorder_id: '6x9', phone: '+1305' } }).ordenId === '6x9', 'Desanida el payload de vTiger (data)');
assert(normalizarEventoCompra({ data: { salesorder_id: '6x9' } }).telefono === '', 'No inventa el telefono si no viene');
assert(normalizarEventoCompra({}).ordenId === '' && normalizarEventoCompra({}).numeroOrden === '', 'Un payload vacio no rompe');
assert(normalizarEventoCompra({ ghlContactId: 'abc' }).ghlContactId === 'abc', 'Lee un contactId de GHL ya resuelto');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Un evento = una factura (sin barrido)');
const vt1 = crearVtigerFalso();
const pub1 = crearPublicar();
const r1 = await atenderEventoCompra({
  payload: { salesorder_id: '6x1' }, clienteVtiger: vt1, publicar: pub1.fn,
  buscarContactoGhl: async () => 'contacto-ghl-1', sede: 'PALACIOS'
});
assert(r1.ok === true && r1.motivo === 'PUBLICADA', `Publica la factura del evento (motivo: ${r1.motivo})`);
assert(pub1.llamadas.length === 1, 'Se publica exactamente UNA vez');
assert(pub1.llamadas[0].contactId === 'contacto-ghl-1', 'Publica en el contacto resuelto');
assert(pub1.llamadas[0].numeroOrden === 'S-96567', 'Publica la orden correcta');
assert(!vt1.consultas.some(s => /cf_994/.test(s)), 'NO barre compradores: no hay consulta de listado');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Idempotencia: un evento repetido no republica');
const pub2 = crearPublicar(['YA_PUBLICADA']);
const r2 = await atenderEventoCompra({
  payload: { salesorder_id: '6x1' }, clienteVtiger: crearVtigerFalso(), publicar: pub2.fn,
  buscarContactoGhl: async () => 'contacto-ghl-1'
});
assert(r2.ok === false && r2.motivo === 'YA_PUBLICADA', 'El evento duplicado se detecta como YA_PUBLICADA');
assert(codigoHttpParaResultado(r2.motivo) === 200, 'Un duplicado responde 200 (el CRM no debe reintentar)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Eventos invalidos con motivo explicito');
const rVacio = await atenderEventoCompra({ payload: {}, clienteVtiger: crearVtigerFalso(), publicar: crearPublicar().fn });
assert(rVacio.motivo === MOTIVOS_EVENTO.EVENTO_INCOMPLETO, 'Sin id ni numero -> EVENTO_INCOMPLETO');
assert(codigoHttpParaResultado(rVacio.motivo) === 422, 'Un evento incompleto responde 422');

const rSinOrden = await atenderEventoCompra({ payload: { salesorder_id: '6x999' }, clienteVtiger: crearVtigerFalso(), publicar: crearPublicar().fn });
assert(rSinOrden.motivo === MOTIVOS_EVENTO.ORDEN_NO_ENCONTRADA, 'Orden inexistente -> ORDEN_NO_ENCONTRADA');

const rSinContacto = await atenderEventoCompra({
  payload: { salesorder_id: '6x1' }, clienteVtiger: crearVtigerFalso({ contactos: {} }),
  publicar: crearPublicar().fn, buscarContactoGhl: async () => null
});
assert(rSinContacto.motivo === MOTIVOS_EVENTO.CONTACTO_NO_ENCONTRADO, 'Sin telefono/contacto -> CONTACTO_NO_ENCONTRADO');
assert(rSinContacto.orden?.numeroOrden === 'S-96567', 'Informa la orden aunque no pueda publicar (auditable)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] El evento puede traer el contacto ya resuelto');
const vt5 = crearVtigerFalso();
const pub5 = crearPublicar();
const r5 = await atenderEventoCompra({
  payload: { salesorder_id: '6x1', ghlContactId: 'contacto-directo' }, clienteVtiger: vt5, publicar: pub5.fn
});
assert(r5.ok === true && pub5.llamadas[0].contactId === 'contacto-directo', 'Usa el contactId del evento sin buscarlo');
const consultasContacto = vt5.consultas.filter(s => /FROM Contacts/i.test(s));
assert(consultasContacto.length === 1, 'Consulta el contacto UNA vez para la sede real, aunque el contactId ya venga');
assert(/cf_3451/.test(consultasContacto[0] || ''), 'Pide la sede (cf_3451) para el monitor por sede');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Codigos HTTP por tipo de resultado');
assert(codigoHttpParaResultado('PUBLICADA') === 200, 'Publicada -> 200');
assert(codigoHttpParaResultado('YA_PUBLICADA') === 200, 'Idempotente -> 200');
assert(codigoHttpParaResultado('MEDIA_NO_DISPONIBLE') === 503, 'Fallo temporal de GHL -> 503 (reintentar sirve)');
assert(codigoHttpParaResultado('ESCRITURA_FALLIDA') === 503, 'Escritura fallida -> 503');
assert(codigoHttpParaResultado('CONTACTO_NO_ENCONTRADO') === 422, 'Datos que aun no estan -> 422');
assert(codigoHttpParaResultado('EVENTO_INCOMPLETO') === 422, 'Evento incompleto -> 422');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Servidor HTTP real: salud, token y evento');
const vt7 = crearVtigerFalso();
const pub7 = crearPublicar();
const atender = (payload) => atenderEventoCompra({
  payload, clienteVtiger: vt7, publicar: pub7.fn, buscarContactoGhl: async () => 'contacto-ghl-7'
});
const { server, url } = await iniciarServidorEventos({ puerto: 0, atender, token: TOKEN });

const salud = await fetch(`${url}/salud`);
assert(salud.status === 200 && (await salud.json()).ok === true, 'GET /salud responde 200');

const sinToken = await fetch(`${url}/evento/compra`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ salesorder_id: '6x1' }) });
assert(sinToken.status === 401, 'Sin token responde 401');
const tokenMalo = await fetch(`${url}/evento/compra`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loa-token': 'malo' }, body: JSON.stringify({ salesorder_id: '6x1' }) });
assert(tokenMalo.status === 401, 'Con token invalido responde 401');
assert(pub7.llamadas.length === 0, 'Una peticion no autorizada NO publica nada');

const ok = await fetch(`${url}/evento/compra`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loa-token': TOKEN }, body: JSON.stringify({ salesorder_id: '6x1' }) });
const cuerpoOk = await ok.json();
assert(ok.status === 200 && cuerpoOk.ok === true, `Evento valido -> 200 y publicado (motivo: ${cuerpoOk.motivo})`);
assert(String(cuerpoOk.url).includes('INVOICE_S-96567.pdf'), 'La respuesta informa la URL publicada');
assert(pub7.llamadas.length === 1, 'El evento valido publica exactamente una vez');

const duplicado = await fetch(`${url}/evento/compra`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loa-token': TOKEN }, body: JSON.stringify({ salesorder_id: '6x1' }) });
assert(duplicado.status === 200, 'Reenvio del mismo evento sigue respondiendo 200 (idempotente)');

const jsonMalo = await fetch(`${url}/evento/compra`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loa-token': TOKEN }, body: '{no es json' });
assert(jsonMalo.status === 400, 'JSON invalido -> 400');

const noExiste = await fetch(`${url}/otra-ruta`);
assert(noExiste.status === 404, 'Ruta desconocida -> 404');

const porQuery = await fetch(`${url}/evento/compra?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ salesorder_no: 'S-96567' }) });
assert([200, 503].includes(porQuery.status), 'Acepta el token por query string (util para CRMs que no mandan headers)');

await new Promise(r => server.close(r));

// ------------------------------------------------------------------------------
console.log('\n[TEST 8] El servidor no se crea sin funcion de atencion');
let lanzo = false;
try { crearServidorEventos({ token: TOKEN }); } catch (e) { lanzo = e instanceof TypeError; }
assert(lanzo, 'Sin atender() lanza TypeError (error de programacion, no de runtime)');

// ------------------------------------------------------------------------------
console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
