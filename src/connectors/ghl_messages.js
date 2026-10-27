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
import { recordAuditEvent } from '../core/audit.js';
import { SEDES_ATENCION, normalizarSede, obtenerAtencionSede } from '../core/sedes.js';
import { verificarEnlaceSincronizado } from '../core/link_validator.js';

export { SEDES_ATENCION, normalizarSede, obtenerAtencionSede };

export const MOTIVOS_MENSAJE = {
  OK: 'OK',
  PARAMS_INCOMPLETOS: 'PARAMS_INCOMPLETOS',
  TOKEN_INVALIDO: 'TOKEN_INVALIDO',
  DESACTIVADO: 'DESACTIVADO',
  ERROR_RED: 'ERROR_RED',
  RECHAZADO: 'RECHAZADO_POR_GHL',
  ENLACE_NO_SINCRONIZADO: 'ENLACE_NO_SINCRONIZADO',
  SMS_DIRECTO_PROHIBIDO: 'SMS_DIRECTO_PROHIBIDO'
};

/**
 * Formatea un nombre y apellido combinados de forma elegante.
 */
export function formatearNombreCompleto(nombre = '', apellido = '') {
  const partes = [nombre, apellido].filter(Boolean).map(p => String(p).trim()).filter(Boolean);
  const crudo = partes.join(' ').trim();
  if (!crudo) return '';
  // Si viene en MAYUSCULAS SOSTENIDAS (ej: "ROSALINDA VALDEZ"), lo pasa a Title Case: "Rosalinda Valdez"
  if (crudo === crudo.toUpperCase() && crudo.length > 2) {
    return crudo
      .toLowerCase()
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return crudo;
}

export const PLANTILLA_SMS_DEFECTO = 'Hola {nombreCompleto}, gracias por tu compra en Laboratorios Naturales. Aquí puedes ver y descargar tu factura oficial: {urlPdf}\nPara cualquier consulta o atención al cliente, puedes comunicarte al {telefonoAtencion}.';

export function headersCentral(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/**
 * Construye el texto del mensaje a partir de la plantilla y asigna el teléfono de atención de la sede.
 */
export function construirTextoMensaje({
  nombre = '',
  apellido = '',
  nombreCompleto = '',
  numeroOrden = '',
  urlPdf = '',
  sede = '',
  telefonoAtencion = '',
  plantilla = ''
} = {}) {
  const atencion = obtenerAtencionSede(sede);
  const tel = String(telefonoAtencion || atencion.telefono).trim();
  const patron = plantilla || process.env.INVOICE_SMS_TEMPLATE || PLANTILLA_SMS_DEFECTO;

  const clienteFinal = (nombreCompleto ? String(nombreCompleto).trim() : null)
    || formatearNombreCompleto(nombre, apellido)
    || String(nombre || 'estimado cliente').trim();

  const incluyeApellidoToken = /\{apellido\}/i.test(patron);
  const nombreParaToken = incluyeApellidoToken
    ? (String(nombre).trim() || clienteFinal.split(' ')[0] || 'cliente')
    : clienteFinal;

  return patron
    .replace(/\{nombreCompleto\}/gi, clienteFinal)
    .replace(/\{nombre\}/gi, nombreParaToken)
    .replace(/\{apellido\}/gi, String(apellido || '').trim())
    .replace(/\{numeroOrden\}/gi, String(numeroOrden || '').trim())
    .replace(/\{urlPdf\}/gi, String(urlPdf || '').trim())
    .replace(/\{telefonoAtencion\}/gi, tel)
    .replace(/\{telefonoSede\}/gi, tel)
    .replace(/\{customerServicePhone\}/gi, tel)
    .replace(/\{sede\}/gi, atencion.nombre);
}

/**
 * Envia el SMS al contacto a traves de la API de conversaciones de GHL.
 */
export async function enviarMensajeFacturaGhl({
  contactId,
  mensaje,
  apiKey,
  tipo = 'SMS',
  validarEnlace = false,
  urlAValidar = null,
  fetchImpl = null,
  caller = 'InvoiceMessenger'
} = {}) {
  const cfg = configFactura();
  const key = apiKey || cfg.ghl.apiKeyCentral;
  const vacio = { ok: false, messageId: null, status: 0, motivo: null, detalle: null };

  if (!contactId || !mensaje || !key) {
    return { ...vacio, motivo: MOTIVOS_MENSAJE.PARAMS_INCOMPLETOS, detalle: 'Faltan contactId, mensaje o apiKey.' };
  }

  // CANDADO ESTRICTO DE CALIDAD: si se solicita validar enlace, comprobar que el documento esté sincronizado
  if (validarEnlace) {
    let urlDestino = urlAValidar;
    if (!urlDestino) {
      const match = /https?:\/\/[^\s]+/i.exec(mensaje);
      if (match) urlDestino = match[0].replace(/[.,;:)]+$/, '');
    }
    if (urlDestino) {
      const verif = await verificarEnlaceSincronizado(urlDestino);
      if (!verif.sincronizado) {
        recordAuditEvent({
          type: 'INVOICE_SMS_BLOQUEADO_DOCUMENTO_NO_SINCRONIZADO',
          severity: 'warn',
          message: `Envio de SMS para contacto ${contactId} bloqueado: el enlace ${urlDestino} no tiene el documento sincronizado (${verif.detalle}).`
        });
        return {
          ...vacio,
          status: verif.status || 404,
          motivo: MOTIVOS_MENSAJE.ENLACE_NO_SINCRONIZADO,
          detalle: `CANDADO DE CALIDAD: El documento en ${urlDestino} no esta sincronizado (${verif.detalle}). Envio bloqueado.`
        };
      }
    }
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
