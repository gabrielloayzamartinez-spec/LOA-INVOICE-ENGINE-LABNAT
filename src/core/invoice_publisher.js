/**
 * ==============================================================================
 * LOA INVOICE ENGINE - PUBLICADOR (CABLEADO REAL DE DEPENDENCIAS)
 * ==============================================================================
 * Une el caso de uso con las implementaciones REALES:
 *   descargarPdf     -> sesion web de vTiger (`vtiger_web_session.js`)
 *   subirPdf         -> Media Library de GHL (`ghl_media.js`)
 *   escribirContacto -> custom fields (PUT /contacts/:id) + tags
 *                       (POST /contacts/:id/tags)
 *
 * Tambien resuelve los IDs de los campos puente POR NOMBRE contra la location
 * destino, de modo que el motor no dependa de IDs hardcodeados: si el campo se
 * llama distinto, el flujo se detiene en seco en lugar de escribir en otro lado.
 * ==============================================================================
 */

import { configFactura } from '../config.js';
import { ghlFetch } from '../connectors/ghl_client.js';
import { crearClienteSesionWeb } from '../connectors/vtiger_web_session.js';
import { subirPdfAMediaLibrary, baseGhl } from '../connectors/ghl_media.js';
import { entregarFacturaDeOrden } from './invoice_delivery.js';
import { CLAVES_PUENTE_FACTURA, TAG_FACTURA_ENVIADA } from './invoice_bridge.js';
import { generarFacturaPdf, contactoParaInvoice, EMPRESA_POR_DEFECTO } from './invoice_render.js';
import { enviarMensajeFacturaGhl, construirTextoMensaje } from '../connectors/ghl_messages.js';
import { recordAuditEvent } from './audit.js';

/** Nombres EXACTOS de los campos puente en GHL. */
export const NOMBRES_CAMPOS_FACTURA = {
  [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: 'URL Factura PDF',
  [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: 'Factura Nº Orden',
  [CLAVES_PUENTE_FACTURA.sedeAsignada]: 'Sede Asignada',
  [CLAVES_PUENTE_FACTURA.vtigerSede]: 'vTiger Sede / Tienda Compra'
};

/** Normaliza un nombre para comparar (minusculas, sin acentos ni simbolos). */
export function normalizarNombreCampo(nombre = '') {
  return String(nombre)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita acentos
    .replace(/[º°#]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Cabeceras para la API v2 de GHL con el PIT de la location destino. */
export function headersCentral(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/** Wrapper de red: `fetchImpl` en pruebas, `ghlFetch` (timeout + 429) en produccion. */
function enviarCon(fetchImpl, caller) {
  return fetchImpl
    ? (url, opciones) => fetchImpl(url, opciones)
    : (url, opciones) => ghlFetch(url, opciones, 1, caller);
}

/**
 * Resuelve los IDs de los campos puente por NOMBRE en la location destino.
 * Se apoya en el endpoint de campos personalizados de GHL.
 */
export async function resolverCamposPuente(locationId, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  const enviar = enviarCon(fetchImpl, caller);
  const res = await enviar(`${baseGhl()}/locations/${encodeURIComponent(locationId)}/customFields`, { method: 'GET', headers });
  const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
  if (!res.ok) throw new Error(`No se pudieron leer los campos personalizados (HTTP ${res.status}): ${String(texto).slice(0, 160)}`);

  let cuerpo = null;
  try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }
  const campos = cuerpo?.customFields || cuerpo?.fields || [];

  const buscar = (nombreBuscado) => {
    const objetivo = normalizarNombreCampo(nombreBuscado);
    const encontrado = campos.find(c => normalizarNombreCampo(c.name || c.fieldKey || '') === objetivo);
    return encontrado?.id || null;
  };

  return {
    [CLAVES_PUENTE_FACTURA.urlFacturaPdf]: buscar(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.urlFacturaPdf]),
    [CLAVES_PUENTE_FACTURA.facturaNumeroOrden]: buscar(NOMBRES_CAMPOS_FACTURA[CLAVES_PUENTE_FACTURA.facturaNumeroOrden])
  };
}

/** Lee el contacto en GHL (estado puente / idempotencia). */
export async function leerContactoGhl(contactId, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${baseGhl()}/contacts/${encodeURIComponent(contactId)}`, { method: 'GET', headers });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    if (!res.ok) return { ok: false, status: res.status, contacto: null, detalle: String(texto).slice(0, 180) };
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }
    return { ok: true, status: res.status, contacto: cuerpo?.contact || cuerpo || null, detalle: null };
  } catch (e) {
    return { ok: false, status: 0, contacto: null, detalle: e.message };
  }
}

/** Escribe los custom fields del puente (una sola llamada). */
export async function escribirCamposPuente(contactId, customFields, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  if (!contactId || !Array.isArray(customFields) || !customFields.length) {
    return { ok: false, skipped: true, detalle: 'sin campos' };
  }
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${baseGhl()}/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ customFields })
    });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    return { ok: res.ok, status: res.status, detalle: res.ok ? null : String(texto).slice(0, 180) };
  } catch (e) {
    return { ok: false, status: 0, detalle: e.message };
  }
}

/** Agrega tags al contacto (dispara el workflow en GHL). */
export async function agregarTagsContacto(contactId, tags, { headers, fetchImpl = null, caller = 'InvoicePublisher' } = {}) {
  if (!contactId || !Array.isArray(tags) || !tags.length) return { ok: false, skipped: true, detalle: 'sin tags' };
  const enviar = enviarCon(fetchImpl, caller);
  try {
    const res = await enviar(`${baseGhl()}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags })
    });
    const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    return { ok: res.ok, status: res.status, detalle: res.ok ? null : String(texto).slice(0, 180) };
  } catch (e) {
    return { ok: false, status: 0, detalle: e.message };
  }
}

/** Construye las dependencias REALES del caso de uso. */
export function crearDepsFactura({ apiKeyCentral, locationIdCentral, fetchImpl = null, clienteSesionWeb = null, empresa = {}, pdf = null } = {}) {
  const headers = headersCentral(apiKeyCentral);
  const cfg = configFactura();
  const opcionesPdf = pdf || cfg.pdf || { fuente: 'vtiger', app: 'MARKETING', fallbackPropio: true };
  const cliente = clienteSesionWeb || crearClienteSesionWeb(fetchImpl ? { fetchImpl } : {});

  /** Genera el PDF con la plantilla propia (via de respaldo). */
  const generarPropio = async ({ orden, contacto }) => {
    const clienteDoc = contactoParaInvoice({ contacto, orden });
    const buf = await generarFacturaPdf({ orden, contacto: clienteDoc, empresa: { ...EMPRESA_POR_DEFECTO, ...empresa } });
    return { ok: true, buf, generado: true };
  };

  return {
    // ORIGEN DEL PDF (INVOICE_PDF_SOURCE):
    //   'vtiger' -> PDF OFICIAL de vTiger (accion ExportPDF). Trae el logo, la tabla
    //               completa de productos y los totales ya aprobados. Es UNA peticion
    //               por factura y la sesion web se reutiliza (single-flight), por lo
    //               que NO satura la API de vTiger.
    //   'propio' -> plantilla del motor (respaldo, sin depender del canal web).
    descargarPdf: async ({ orden, contacto }) => {
      if (opcionesPdf.fuente === 'vtiger') {
        try {
          const r = await cliente.descargarDocumentoOficial({ record: orden.id, modulo: 'SalesOrder', app: opcionesPdf.app });
          if (r.ok) return { ok: true, buf: r.buf, oficial: true, bytes: r.bytes };
          if (!opcionesPdf.fallbackPropio) return { ok: false, motivo: 'PDF_OFICIAL_NO_DISPONIBLE', detalle: r.motivo };
        } catch (e) {
          if (!opcionesPdf.fallbackPropio) return { ok: false, motivo: 'PDF_OFICIAL_FALLIDO', detalle: e.message };
        }
      }
      try {
        return await generarPropio({ orden, contacto });
      } catch (e) {
        return { ok: false, motivo: 'GENERACION_PDF_FALLIDA', detalle: e.message };
      }
    },

    subirPdf: async ({ nombreArchivo, contenido }) => subirPdfAMediaLibrary({
      locationId: locationIdCentral,
      nombreArchivo,
      contenido,
      apiKey: apiKeyCentral,
      fetchImpl
    }),

    escribirContacto: async ({ contactId, customFields, tags, orden, url, contactoGhl }) => {
      const campos = await escribirCamposPuente(contactId, customFields, { headers, fetchImpl });
      if (!campos.ok) return { ok: false, detalle: `customFields: ${campos.detalle || campos.status}` };
      const etiquetas = await agregarTagsContacto(contactId, tags, { headers, fetchImpl });
      if (!etiquetas.ok) return { ok: false, detalle: `tags: ${etiquetas.detalle || etiquetas.status}` };

      // Envio directo por API de GHL (si esta configurado INVOICE_AUTO_SEND_SMS=true)
      const cfgActual = configFactura();
      if (cfgActual.mensaje?.autoEnviar && url) {
        const nombre = contactoGhl?.firstName || contactoGhl?.contactName || contactoGhl?.name || 'cliente';
        const texto = construirTextoMensaje({
          nombre,
          numeroOrden: orden?.numeroOrden || '',
          urlPdf: url,
          sede: orden?.sede || '',
          plantilla: cfgActual.mensaje.plantilla
        });
        const msgRes = await enviarMensajeFacturaGhl({
          contactId,
          mensaje: texto,
          apiKey: apiKeyCentral,
          tipo: cfgActual.mensaje.tipo || 'SMS',
          fetchImpl
        });
        if (msgRes.ok) {
          await agregarTagsContacto(contactId, [TAG_FACTURA_ENVIADA], { headers, fetchImpl });
          try {
            recordAuditEvent({
              type: 'INVOICE_SMS_ENVIADO',
              severity: 'info',
              message: `SMS de factura ${orden?.numeroOrden || ''} enviado al cliente (messageId: ${msgRes.messageId})`
            });
          } catch {}
        } else {
          try {
            recordAuditEvent({
              type: 'INVOICE_SMS_FALLIDO',
              severity: 'warn',
              message: `Fallo envio directo de SMS para ${orden?.numeroOrden || ''}: ${msgRes.detalle || msgRes.motivo}`
            });
          } catch {}
        }
      }

      return { ok: true, detalle: null };
    }
  };
}

/**
 * Publica la factura de UNA orden para UN contacto de la Cuenta Empresa.
 * Devuelve siempre un objeto (nunca lanza).
 */
export async function publicarFacturaDeContacto({
  contactId,
  orden,
  apiKeyCentral = null,
  locationIdCentral = null,
  fieldIds = null,
  sede = null,
  habilitado = null,
  fetchImpl = null,
  deps = null,
  estadoLogisticoRequerido = null,
  fechaMinima = null,
  montoMinimo = null,
  asuntosPermitidos = null,
  dominioMarca = null,
  rutaLinks = null
} = {}) {
  const cfg = configFactura();
  const apiKey = apiKeyCentral || cfg.ghl.apiKeyCentral;
  const locationId = locationIdCentral || cfg.ghl.locationIdCentral;
  const estadoLogistico = estadoLogisticoRequerido ?? cfg.escaneo?.triggerStatus;
  const fechaCorte = fechaMinima ?? cfg.escaneo?.fechaMinima;
  const montoMin = montoMinimo ?? cfg.escaneo?.montoMinimo;
  const asuntos = asuntosPermitidos ?? cfg.escaneo?.asuntosPermitidos;
  const dominioEfectivo = dominioMarca !== null ? dominioMarca : cfg.marca?.dominio;
  const linksEfectivos = rutaLinks !== null ? rutaLinks : cfg.marca?.linksPath;

  if (!contactId) return { publicado: false, motivo: 'SIN_CONTACTO', url: null, numeroOrden: null, fileId: null, detalle: null, pasos: [] };
  if (!apiKey || !locationId) {
    return { publicado: false, motivo: 'CUENTA_EMPRESA_NO_CONFIGURADA', url: null, numeroOrden: null, fileId: null, detalle: 'Faltan GHL_API_KEY_CENTRAL / GHL_LOCATION_ID_CENTRAL', pasos: [] };
  }

  const headers = headersCentral(apiKey);

  // 1. Estado actual del contacto (fuente de verdad de la idempotencia).
  const lectura = await leerContactoGhl(contactId, { headers, fetchImpl });
  if (!lectura.ok || !lectura.contacto) {
    return { publicado: false, motivo: 'CONTACTO_ILEGIBLE', url: null, numeroOrden: null, fileId: null, detalle: `${lectura.status || 0} ${lectura.detalle || 'respuesta sin contacto'}`.trim(), pasos: [] };
  }

  // 2. IDs de los campos puente (por nombre). Se pueden inyectar ya resueltos.
  let ids = fieldIds;
  if (!ids) {
    try {
      ids = await resolverCamposPuente(locationId, { headers, fetchImpl });
    } catch (e) {
      return { publicado: false, motivo: 'CAMPOS_NO_RESUELTOS', url: null, numeroOrden: null, fileId: null, detalle: e.message, pasos: [] };
    }
  }

  // 3. Caso de uso (deps reales o inyectadas en pruebas).
  const depsEfectivas = deps || crearDepsFactura({ apiKeyCentral: apiKey, locationIdCentral: locationId, fetchImpl });
  return entregarFacturaDeOrden({
    orden,
    contactoGhl: lectura.contacto,
    contactId,
    fieldIds: ids,
    deps: depsEfectivas,
    habilitado,
    sede,
    estadoLogisticoRequerido: estadoLogistico,
    fechaMinima: fechaCorte,
    montoMinimo: montoMin,
    asuntosPermitidos: asuntos,
    dominioMarca: dominioEfectivo,
    rutaLinks: linksEfectivos
  });
}
