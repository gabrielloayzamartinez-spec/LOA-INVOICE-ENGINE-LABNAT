/**
 * ==============================================================================
 * LOA INVOICE ENGINE - MEDIA LIBRARY DE GHL (PUBLICACION DEL PDF)
 * ==============================================================================
 * Sube el PDF de la factura a la Media Library de la Cuenta Empresa y devuelve
 * su URL PUBLICA, que es lo unico que el workflow de GHL necesita para enviarla.
 *
 * NUNCA lanza: devuelve `{ ok, motivo, detalle }`. Una caida de GHL no debe
 * tumbar el ciclo de facturacion.
 *
 * SCOPES REQUERIDOS en el PIT: medias.read (verificar), medias.write (subir).
 * 401 = token invalido | 403 = scope faltante.
 * ==============================================================================
 */

import { ghlFetch } from './ghl_client.js';
import { configFactura } from '../config.js';

export const GHL_API_VERSION = '2021-07-28';

/** Base de GHL (configurable: permite proxy o servidor de pruebas HTTP real). */
export function baseGhl() {
  return configFactura().ghl.baseUrl;
}

/** Motivos de resultado (observabilidad / auditoria). */
export const MOTIVOS_MEDIA = {
  OK: 'OK',
  PARAMS: 'PARAMS_INCOMPLETOS',
  TOKEN_INVALIDO: 'TOKEN_INVALIDO',
  SCOPE_FALTANTE: 'SCOPE_FALTANTE',
  RESPUESTA_SIN_URL: 'RESPUESTA_SIN_URL',
  RECHAZADO: 'RECHAZADO_POR_GHL',
  ERROR_RED: 'ERROR_RED'
};

/** Cabeceras para la API v2 de GHL. */
export function headersMedia(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    Accept: 'application/json'
  };
}

/**
 * Construye el multipart con el PDF.
 * El nombre viaja como tercer argumento: sin el, GHL guardaria el archivo como
 * "blob" y la URL no diria nada al cliente.
 */
export function construirFormDataPdf({ nombreArchivo, contenido, tipoMime = 'application/pdf' } = {}) {
  if (!contenido || !nombreArchivo) {
    throw new TypeError('construirFormDataPdf requiere contenido y nombreArchivo.');
  }
  const form = new FormData();
  form.append('file', new Blob([contenido], { type: tipoMime }), String(nombreArchivo));
  form.append('name', String(nombreArchivo));
  return form;
}

/** Extrae la URL publica y el fileId de la respuesta de GHL (formas toleradas). */
export function extraerUrlDeRespuestaMedia(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return { url: null, fileId: null };
  const url = cuerpo.url || cuerpo.fileUrl || cuerpo.meta?.url || null;
  const fileId = cuerpo.fileId || cuerpo.id || cuerpo.meta?.fileId || null;
  return { url: url ? String(url) : null, fileId: fileId ? String(fileId) : null };
}

function motivoPorStatus(status) {
  if (status === 401) return MOTIVOS_MEDIA.TOKEN_INVALIDO;
  if (status === 403) return MOTIVOS_MEDIA.SCOPE_FALTANTE;
  return MOTIVOS_MEDIA.RECHAZADO;
}

/**
 * Sube el PDF a la Media Library de una location.
 * @returns {Promise<{ok: boolean, motivo: string, status: number, url: string|null, fileId: string|null, detalle: string|null}>}
 */
export async function subirPdfAMediaLibrary({ locationId, nombreArchivo, contenido, apiKey, fetchImpl = null, caller = 'InvoiceMedia' } = {}) {
  const vacio = { ok: false, status: 0, url: null, fileId: null, detalle: null };

  if (!locationId || !nombreArchivo || !contenido || !apiKey) {
    return { ...vacio, motivo: MOTIVOS_MEDIA.PARAMS, detalle: 'Faltan locationId, nombreArchivo, contenido o apiKey.' };
  }

  const enviar = fetchImpl || ((url, opciones) => ghlFetch(url, opciones, 1, caller));
  const url = `${baseGhl()}/medias/upload-file?locationId=${encodeURIComponent(locationId)}`;

  let res;
  try {
    res = await enviar(url, {
      method: 'POST',
      headers: headersMedia(apiKey),
      body: construirFormDataPdf({ nombreArchivo, contenido })
    });
  } catch (e) {
    return { ...vacio, motivo: MOTIVOS_MEDIA.ERROR_RED, detalle: e.message };
  }

  const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = null; }

  if (!res.ok) {
    const detalle = cuerpo?.message || String(texto).slice(0, 180) || `HTTP ${res.status}`;
    return { ok: false, motivo: motivoPorStatus(res.status), status: res.status, url: null, fileId: null, detalle };
  }

  const { url: urlPublica, fileId } = extraerUrlDeRespuestaMedia(cuerpo);
  if (!urlPublica) {
    return { ok: false, motivo: MOTIVOS_MEDIA.RESPUESTA_SIN_URL, status: res.status, url: null, fileId, detalle: String(texto).slice(0, 180) || null };
  }

  return { ok: true, motivo: MOTIVOS_MEDIA.OK, status: res.status, url: urlPublica, fileId, detalle: null };
}

/** Verifica (solo lectura) que el PIT puede acceder a la Media Library. */
export async function verificarAccesoMedia({ locationId, apiKey, fetchImpl = null, caller = 'InvoiceMedia' } = {}) {
  if (!locationId || !apiKey) return { ok: false, motivo: MOTIVOS_MEDIA.PARAMS, status: 0, detalle: 'Faltan locationId o apiKey.' };

  const enviar = fetchImpl || ((url, opciones) => ghlFetch(url, opciones, 1, caller));
  // GHL exige el parametro `type` (verificado contra la cuenta real: sin el
  // responde 422 "type must be a string / type should not be empty").
  const url = `${baseGhl()}/medias/files?locationId=${encodeURIComponent(locationId)}&type=file&limit=1`;

  try {
    const res = await enviar(url, { method: 'GET', headers: headersMedia(apiKey) });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    if (res.ok) return { ok: true, motivo: MOTIVOS_MEDIA.OK, status: res.status, detalle: null };
    return { ok: false, motivo: motivoPorStatus(res.status), status: res.status, detalle: String(texto).slice(0, 180) };
  } catch (e) {
    return { ok: false, motivo: MOTIVOS_MEDIA.ERROR_RED, status: 0, detalle: e.message };
  }
}
