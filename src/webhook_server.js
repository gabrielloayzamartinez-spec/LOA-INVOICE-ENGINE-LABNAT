/**
 * ==============================================================================
 * LOA INVOICE ENGINE - ENDPOINT DE EVENTOS (DISPARADOR UNICO POR WEBHOOK)
 * ==============================================================================
 * Servidor HTTP minimo (node:http, cero dependencias) que recibe UN evento de
 * compra y publica ESA factura. Reemplaza al barrido: no recorre la base.
 *
 * RUTAS:
 *   GET  /salud            -> verificacion de vida (para el CRM o el cron).
 *   POST /evento/compra    -> evento de venta efectuada (requiere token).
 *
 * SEGURIDAD:
 *   - Token compartido en el header `x-loa-token` (o `?token=`).
 *     Se configura con INVOICE_WEBHOOK_TOKEN. Sin token, el endpoint NO existe
 *     funcionalmente: responde 401 y no procesa nada.
 *   - Limite de tamaño del payload (evita que un cuerpo enorme tumbe el proceso).
 *   - NUNCA se registra el payload completo en la auditoria (puede traer datos
 *     personales): solo el resultado.
 *
 * CODIGOS DE RESPUESTA (pensados para que el CRM reintente bien):
 *   200 -> la factura se publico (o ya estaba publicada: idempotente).
 *   422 -> el evento no permite publicar todavia (orden/contacto faltante).
 *   503 -> fallo temporal de GHL/vTiger: REINTENTAR tiene sentido.
 *   401 -> token invalido.  400 -> JSON invalido.  413 -> payload grande.
 * ==============================================================================
 */

import http from 'node:http';
import { recordAuditEvent } from './core/audit.js';

const LIMITE_BYTES = 64 * 1024;

/** Motivos que ameritan que el emisor reintente (503) o no (200/422). */
const EXITO = new Set(['PUBLICADA']);
const FALLO_TEMPORAL = new Set(['MEDIA_NO_DISPONIBLE', 'ESCRITURA_FALLIDA', 'PDF_NO_DISPONIBLE', 'DEPS_INCOMPLETAS']);
const OMISION_DEFINITIVA = new Set(['YA_PUBLICADA', 'DESACTIVADO']);

/** Traduce el resultado del caso de uso a un codigo HTTP. */
export function codigoHttpParaResultado(motivo = '') {
  if (EXITO.has(motivo)) return 200;                // publicada: exito
  if (OMISION_DEFINITIVA.has(motivo)) return 200;   // idempotente: no reintentar
  if (FALLO_TEMPORAL.has(motivo)) return 503;       // reintentar sirve
  return 422;                                        // datos incompletos
}

/**
 * Crea el servidor de eventos.
 * @param {object}   args
 * @param {Function} args.atender  (payload) => resultado de atenderEventoCompra
 * @param {string}   args.token    Token compartido obligatorio.
 */
export function crearServidorEventos({ atender, token } = {}) {
  if (typeof atender !== 'function') throw new TypeError('crearServidorEventos requiere atender(payload).');

  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const responder = (code, obj) => {
      const cuerpo = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(cuerpo) });
      res.end(cuerpo);
    };

    // ---------------------------------------------------------------- SALUD
    if (req.method === 'GET' && url.pathname === '/salud') {
      return responder(200, { ok: true, servicio: 'loa-invoice-engine', ts: new Date().toISOString() });
    }

    // ------------------------------------------------- EVENTO DE COMPRA
    if (req.method === 'POST' && url.pathname === '/evento/compra') {
      const recibido = String(req.headers['x-loa-token'] || url.searchParams.get('token') || '');
      if (!token || recibido !== token) {
        recordAuditEvent({ type: 'INVOICE_WEBHOOK_RECHAZADO', severity: 'warn', message: 'Evento rechazado: token ausente o invalido.' });
        return responder(401, { ok: false, motivo: 'NO_AUTORIZADO' });
      }

      const trozos = [];
      let bytes = 0;
      let abortado = false;

      req.on('data', c => {
        if (abortado) return;
        bytes += c.length;
        if (bytes > LIMITE_BYTES) {
          abortado = true;
          responder(413, { ok: false, motivo: 'PAYLOAD_DEMASIADO_GRANDE' });
          req.destroy();
          return;
        }
        trozos.push(c);
      });

      req.on('end', async () => {
        if (abortado) return;
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}');
        } catch {
          return responder(400, { ok: false, motivo: 'JSON_INVALIDO' });
        }

        try {
          const r = await atender(payload);
          return responder(codigoHttpParaResultado(r?.motivo), {
            ok: Boolean(r?.ok),
            motivo: r?.motivo || 'SIN_RESULTADO',
            numeroOrden: r?.orden?.numeroOrden || null,
            url: r?.resultado?.url || null,
            detalle: r?.detalle || null
          });
        } catch (e) {
          recordAuditEvent({ type: 'INVOICE_WEBHOOK_ERROR', severity: 'error', message: `Error atendiendo el evento: ${e.message}` });
          return responder(500, { ok: false, motivo: 'ERROR_INTERNO' });
        }
      });

      req.on('error', () => { if (!abortado) responder(400, { ok: false, motivo: 'ERROR_DE_LECTURA' }); });
      return;
    }

    return responder(404, { ok: false, motivo: 'RUTA_DESCONOCIDA' });
  });
}

/**
 * Levanta el servidor y devuelve la URL real (puerto efectivo si se pidio 0).
 */
export function iniciarServidorEventos({ puerto = 3100, host = '0.0.0.0', atender, token } = {}) {
  const server = crearServidorEventos({ atender, token });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(puerto, host, () => {
      const dir = server.address();
      resolve({ server, puerto: dir.port, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${dir.port}` });
    });
  });
}
