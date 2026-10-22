/**
 * ==============================================================================
 * LOA INVOICE ENGINE - ENVIO DE MENSAJES GHL (CONVERSATIONS API)
 * ==============================================================================
 * Permite enviar el mensaje con la factura directamente al cliente por SMS/WhatsApp
 * a traves de la API v2 de GHL (POST /conversations/messages), o de forma complementaria
 * al workflow de GHL disparado por el tag `FACTURA_LISTA`.
 *
 * NUNCA lanza: devuelve `{ ok, messageId, motivo, status, detalle }`.
 * ==============================================================================
 */

import { ghlFetch } from './ghl_client.js';
import { configFactura } from '../config.js';
import { headersCentral } from '../core/invoice_publisher.js';
import { recordAuditEvent } from '../core/audit.js';

export const MOTIVOS_MENSAJE = {
  OK: 'OK',
  PARAMS_INCOMPLETOS: 'PARAMS_INCOMPLETOS',
  TOKEN_INVALIDO: 'TOKEN_INVALIDO',
  DESACTIVADO: 'DESACTIVADO',
  ERROR_RED: 'ERROR_RED',
  RECHAZADO: 'RECHAZADO_POR_GHL'
};

export const PLANTILLA_SMS_DEFECTO = 'Hola {nombre}, gracias por tu compra en Laboratorios Naturales. Aquí puedes ver y descargar tu factura oficial de la orden {numeroOrden}: {urlPdf}';

/**
 * Construye el texto del mensaje a partir de la plantilla.
 */
export function construirTextoMensaje({ nombre = 'cliente', numeroOrden = '', urlPdf = '', plantilla = '' } = {}) {
  const patron = plantilla || process.env.INVOICE_SMS_TEMPLATE || PLANTILLA_SMS_DEFECTO;
  return patron
    .replace(/\{nombre\}/gi, String(nombre || 'estimado cliente').trim())
    .replace(/\{numeroOrden\}/gi, String(numeroOrden || '').trim())
    .replace(/\{urlPdf\}/gi, String(urlPdf || '').trim());
}

/**
 * Envia el SMS al contacto a traves de la API de conversaciones de GHL.
 */
export async function enviarMensajeFacturaGhl({
  contactId,
  mensaje,
  apiKey,
  tipo = 'SMS',
  fetchImpl = null,
  caller = 'InvoiceMessenger'
} = {}) {
  const cfg = configFactura();
  const key = apiKey || cfg.ghl.apiKeyCentral;
  const vacio = { ok: false, messageId: null, status: 0, motivo: null, detalle: null };

  if (!contactId || !mensaje || !key) {
    return { ...vacio, motivo: MOTIVOS_MENSAJE.PARAMS_INCOMPLETOS, detalle: 'Faltan contactId, mensaje o apiKey.' };
  }

  const enviar = fetchImpl || ((url, opciones) => ghlFetch(url, opciones, 1, caller));
  const url = `${cfg.ghl.baseUrl}/conversations/messages`;

  const headers = headersCentral(key);
  const payload = {
    type: tipo,
    contactId: String(contactId).trim(),
    message: String(mensaje).trim()
  };
  const remitente = cfg.mensaje?.fromNumber;
  if (remitente) payload.fromNumber = remitente;

  try {
    const res = await enviar(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }

    if (!res.ok) {
      const detalle = cuerpo?.message || String(texto).slice(0, 180) || `HTTP ${res.status}`;
      const motivo = res.status === 401 ? MOTIVOS_MENSAJE.TOKEN_INVALIDO : MOTIVOS_MENSAJE.RECHAZADO;
      return { ...vacio, status: res.status, motivo, detalle };
    }

    const messageId = cuerpo?.messageId || cuerpo?.id || cuerpo?.msgId || 'OK';
    return { ok: true, messageId, status: res.status, motivo: MOTIVOS_MENSAJE.OK, detalle: null };
  } catch (e) {
    return { ...vacio, motivo: MOTIVOS_MENSAJE.ERROR_RED, detalle: e.message };
  }
}
