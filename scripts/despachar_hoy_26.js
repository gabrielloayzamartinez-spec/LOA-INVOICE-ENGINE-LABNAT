import fs from 'fs';
import { cargarEnv, configFactura } from '../src/config.js';
import { headersCentral, resolverCamposPuente, escribirCamposPuente, agregarTagsContacto } from '../src/core/invoice_publisher.js';
import { enviarMensajeFacturaGhl, construirTextoMensaje, formatearNombreCompleto } from '../src/connectors/ghl_messages.js';
import { normalizarSede, obtenerAtencionSede } from '../src/core/sedes.js';
import { verificarEnlaceSincronizado } from '../src/core/link_validator.js';
import { recordAuditEvent } from '../src/core/audit.js';
import { crearClienteVtiger } from '../src/connectors/vtiger_webservice.js';
import { normalizarOrden } from '../src/jobs/detectar_compras_nuevas.js';
import { subirPdfAMediaLibrary } from '../src/connectors/ghl_media.js';
import { generarFacturaPdf, contactoParaInvoice, EMPRESA_POR_DEFECTO } from '../src/core/invoice_render.js';
import { guardarEnlaceFactura, cargarEnlaces } from '../src/core/short_links.js';

cargarEnv();
const cfg = configFactura();
const headers = headersCentral(cfg.ghl.apiKeyCentral);
const loc = cfg.ghl.locationIdCentral;
const vt = crearClienteVtiger(cfg.vtiger);

const CAMPOS_CONSULTA = [
  'id', 'salesorder_no', 'subject', 'hdnGrandTotal', 'sostatus',
  'cf_882', 'cf_3127', 'cf_1006', 'cf_856', 'cf_858',
  'cf_1069', 'cf_3156', 'quantity', 'cf_870', 'cf_872', 'cf_876', 'cf_1053',
  'contact_id', 'createdtime'
];

function normalizarTelefonoE164(tel = '') {
  let limpio = String(tel || '').replace(/\D+/g, '');
  if (!limpio) return '';
  if (limpio.length === 10) return `+1${limpio}`;
  if (limpio.length === 11 && limpio.startsWith('1')) return `+${limpio}`;
  return `+${limpio}`;
}

async function buscarOCrearContactoGhl({ telefonoE164, nombre, apellido, sede }) {
  if (!telefonoE164) return null;

  try {
    const urlDup = `${cfg.ghl.baseUrl}/contacts/search/duplicate?locationId=${loc}&number=${encodeURIComponent(telefonoE164)}`;
    const rDup = await fetch(urlDup, { headers });
    if (rDup.ok) {
      const dataDup = await rDup.json().catch(() => null);
      if (dataDup?.contact?.id) return dataDup.contact;
    }
  } catch {}

  try {
    const urlQuery = `${cfg.ghl.baseUrl}/contacts/?locationId=${loc}&query=${encodeURIComponent(telefonoE164)}`;
    const rQuery = await fetch(urlQuery, { headers });
    if (rQuery.ok) {
      const dataQuery = await rQuery.json().catch(() => null);
      if (Array.isArray(dataQuery?.contacts) && dataQuery.contacts.length > 0) {
        return dataQuery.contacts[0];
      }
    }
  } catch {}

  try {
    const atencion = obtenerAtencionSede(sede);
    const bodyCreate = {
      firstName: nombre || 'Cliente',
      lastName: apellido || '',
      name: [nombre, apellido].filter(Boolean).join(' ').trim(),
      phone: telefonoE164,
      locationId: loc,
      tags: ['vtiger', `sede_${atencion.clave.toLowerCase()}`]
    };
    const rCreate = await fetch(`${cfg.ghl.baseUrl}/contacts/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyCreate)
    });
    if (rCreate.ok) {
      const dataCreate = await rCreate.json().catch(() => null);
      return dataCreate?.contact || null;
    }
  } catch {}

  return null;
}

async function registrarEnlaceEnRender(numeroOrden, cdnUrl) {
  try {
    const res = await fetch('https://facturas.labnaturales.com/enlace/registrar', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loa-token': cfg.webhook.token
      },
      body: JSON.stringify({
        numeroOrden,
        urlDestino: cdnUrl
      })
    });
    if (res.ok) {
      return true;
    }
    console.warn(`  [WARN] Registro en Render devolvió HTTP ${res.status}`);
  } catch (e) {
    console.warn(`  [WARN] Falló llamada a Render /enlace/registrar: ${e.message}`);
  }
  return false;
}

async function asegurarPdfYEnlace(ord) {
  const links = cargarEnlaces('data/links.json');
  if (links[ord.numeroOrden]?.url) {
    const urlExistente = links[ord.numeroOrden].url;
    await registrarEnlaceEnRender(ord.numeroOrden, urlExistente);
    return { ok: true, urlCdn: urlExistente, reutilizado: true };
  }

  console.log(`  -> Generando PDF oficial con PDFKit para ${ord.numeroOrden}...`);
  const contactoDoc = contactoParaInvoice({
    contacto: {
      firstname: ord.nombreCliente,
      lastname: ord.apellidoCliente,
      phone: ord.telefono,
      cf_870: ord.direccion,
      cf_872: ord.zip,
      cf_876: ord.ciudad,
      cf_1053: ord.estadoEnvio
    },
    orden: ord
  });

  let bufPdf = null;
  try {
    const resPdf = await generarFacturaPdf({
      orden: ord,
      contacto: contactoDoc,
      empresa: EMPRESA_POR_DEFECTO,
      modo: 'etiqueta'
    });
    bufPdf = Buffer.isBuffer(resPdf) ? resPdf : resPdf?.buf;
  } catch (e) {
    return { ok: false, motivo: 'GENERACION_PDF_FALLIDA', detalle: e.message };
  }

  if (!bufPdf || bufPdf.length === 0) {
    return { ok: false, motivo: 'GENERACION_PDF_FALLIDA', detalle: 'Buffer vacío' };
  }

  console.log(`  -> Subiendo PDF (${bufPdf.length} bytes) a GHL Media Library...`);
  const nombreArchivo = `Factura_${ord.numeroOrden}.pdf`;
  const subida = await subirPdfAMediaLibrary({
    locationId: loc,
    nombreArchivo,
    contenido: bufPdf,
    apiKey: cfg.ghl.apiKeyCentral
  });

  if (!subida.ok || !subida.url) {
    return { ok: false, motivo: 'SUBIDA_MEDIA_FALLIDA', detalle: subida.motivo };
  }

  // Guardar en links.json local
  guardarEnlaceFactura({
    numeroOrden: ord.numeroOrden,
    urlDestino: subida.url,
    ruta: 'data/links.json'
  });

  // Notificar a Render en tiempo real
  await registrarEnlaceEnRender(ord.numeroOrden, subida.url);

  return { ok: true, urlCdn: subida.url, nuevo: true };
}

async function main() {
  console.log('================================================================================');
  console.log(' DESPACHO OFICIAL DE FACTURAS VERIFICADAS: LUNES 26 DE OCTUBRE');
  console.log('================================================================================\n');

  // 1. Obtener órdenes comerciales verificadas de hoy
  const sql = `SELECT ${CAMPOS_CONSULTA.join(', ')} FROM SalesOrder WHERE createdtime >= '2026-10-26 00:00:00' AND createdtime <= '2026-10-26 23:59:59' ORDER BY createdtime ASC LIMIT 100`;
  const rawHoy = await vt.consultar(sql);
  const normHoy = rawHoy.map(normalizarOrden);

  const comerciales = normHoy.filter(o =>
    String(o.asunto || '').trim().toUpperCase() === 'VENTA' &&
    Number(o.total || 0) >= 1.00 &&
    (String(o.estadoLogistico || '').toUpperCase().includes('VERIFICADA') || String(o.estadoLogistico || '').toUpperCase().includes('ENVIADA'))
  );

  console.log(`Total órdenes de venta VERIFICADAS hoy a despachar: ${comerciales.length}\n`);
  if (!comerciales.length) {
    console.log('No hay órdenes verificadas pendientes para procesar hoy.');
    return;
  }

  // 2. Resolver campos puente en GHL
  const idsPuente = await resolverCamposPuente(loc, { headers });
  console.log('Campos puente GHL resueltos:', idsPuente);

  const resultados = [];

  for (let i = 0; i < comerciales.length; i++) {
    const ord = comerciales[i];
    const atencion = obtenerAtencionSede(ord.sede);
    const nombreCompleto = formatearNombreCompleto(ord.nombreCliente, ord.apellidoCliente);
    const telE164 = normalizarTelefonoE164(ord.telefono);
    const urlBranded = `https://facturas.labnaturales.com/${ord.numeroOrden}`;

    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`▶ [${i+1}/${comerciales.length}] ORDEN: ${ord.numeroOrden} | SEDE: ${atencion.nombre} | CLIENTE: ${nombreCompleto} (${telE164}) | TOTAL: $${ord.total}`);
    console.log(`--------------------------------------------------------------------------------`);

    // A. BUSCAR O CREAR CONTACTO EN GHL
    console.log(`  1. Buscando contacto en GHL Central...`);
    const contacto = await buscarOCrearContactoGhl({
      telefonoE164: telE164,
      nombre: ord.nombreCliente,
      apellido: ord.apellidoCliente,
      sede: ord.sede
    });

    if (!contacto?.id) {
      console.error(`  ❌ No se pudo resolver el contacto en GHL para ${telE164}.`);
      resultados.push({ orden: ord.numeroOrden, ok: false, motivo: 'CONTACTO_NO_RESUELTO' });
      continue;
    }
    const contactId = contacto.id;
    console.log(`  -> Contacto resuelto: ${contactId}`);

    // Verificación de idempotencia
    const tagsContacto = Array.isArray(contacto.tags) ? contacto.tags.map(t => String(t).toUpperCase()) : [];
    if (tagsContacto.includes('FACTURA_ENVIADA')) {
      console.log(`  ℹ [OMITIDO] La factura ${ord.numeroOrden} ya fue entregada previamente (tag FACTURA_ENVIADA).`);
      resultados.push({ orden: ord.numeroOrden, ok: true, omitido: true, motivo: 'YA_ENVIADA' });
      continue;
    }

    // B. ASEGURAR PDF Y ENLACE EN GHL Y RENDER
    console.log(`  2. Asegurando PDF en Media Library y registro en Render...`);
    const resDoc = await asegurarPdfYEnlace(ord);
    if (!resDoc.ok) {
      console.error(`  ❌ Error asegurando documento: ${resDoc.motivo} - ${resDoc.detalle}`);
      resultados.push({ orden: ord.numeroOrden, ok: false, motivo: resDoc.motivo });
      continue;
    }
    console.log(`  -> PDF disponible en CDN: ${resDoc.urlCdn}`);

    // C. PRE-FLIGHT VALIDATION (Probar que el enlace corto responda HTTP 200/302 con PDF)
    console.log(`  3. Verificando pre-vuelo: ${urlBranded}...`);
    let verif = await verificarEnlaceSincronizado(urlBranded);
    if (!verif.sincronizado) {
      // Reintentar brevemente por si Render tardó unos segundos en refrescar
      console.log('     Esperando 5s para que Render confirme el enlace...');
      await new Promise(r => setTimeout(r, 5000));
      verif = await verificarEnlaceSincronizado(urlBranded);
    }

    if (!verif.sincronizado) {
      console.error(`  ❌ [BLOQUEADO] Pre-vuelo falló: ${verif.detalle}. No se enviará SMS.`);
      resultados.push({ orden: ord.numeroOrden, ok: false, motivo: 'PRE_VUELO_FALLIDO' });
      continue;
    }
    console.log(`  -> Pre-vuelo OK: Enlace activo y entregando PDF validado.`);

    // D. ACTUALIZAR CAMPOS Y TAGS EN GHL
    console.log(`  4. Actualizando campos puente y etiquetas en GHL...`);
    const customFields = [];
    if (idsPuente.urlFacturaPdf) customFields.push({ id: idsPuente.urlFacturaPdf, field_value: urlBranded });
    if (idsPuente.facturaNumeroOrden) customFields.push({ id: idsPuente.facturaNumeroOrden, field_value: ord.numeroOrden });
    if (idsPuente.sedeAsignada) customFields.push({ id: idsPuente.sedeAsignada, field_value: atencion.nombre });
    if (idsPuente.vtigerSede) customFields.push({ id: idsPuente.vtigerSede, field_value: atencion.clave });

    await escribirCamposPuente(contactId, customFields, { headers });
    await agregarTagsContacto(contactId, ['FACTURA_LISTA', `SEDE_${atencion.clave}`], { headers });

    // E. CONSTRUIR TEXTO DEL SMS
    const textoSms = construirTextoMensaje({
      nombre: ord.nombreCliente,
      apellido: ord.apellidoCliente,
      nombreCompleto,
      numeroOrden: ord.numeroOrden,
      urlPdf: urlBranded,
      sede: ord.sede
    });

    console.log(`  5. Enviando SMS oficial desde ${cfg.ghl.smsFromNumber}...`);

    // F. DISPARAR SMS
    const resSms = await enviarMensajeFacturaGhl({
      contactId,
      mensaje: textoSms,
      apiKey: cfg.ghl.apiKeyCentral,
      tipo: 'SMS',
      validarEnlace: true,
      urlAValidar: urlBranded
    });

    if (resSms.ok) {
      console.log(`  ✅ [ÉXITO] SMS entregado correctamente en GHL. MessageId: ${resSms.messageId}`);
      await agregarTagsContacto(contactId, ['FACTURA_ENVIADA'], { headers });
      recordAuditEvent({
        type: 'INVOICE_SMS_ENVIADO',
        severity: 'info',
        sede: atencion.clave,
        message: `Factura ${ord.numeroOrden} despachada a ${nombreCompleto} (${telE164}) - MsgId: ${resSms.messageId}`
      });
      resultados.push({ orden: ord.numeroOrden, cliente: nombreCompleto, tel: telE164, ok: true, msgId: resSms.messageId });
    } else {
      console.error(`  ❌ [FALLO SMS] ${resSms.motivo}: ${resSms.detalle}`);
      resultados.push({ orden: ord.numeroOrden, ok: false, motivo: resSms.motivo });
    }

    // G. PAUSA DE CADENCIA (20 segundos entre contactos)
    if (i < comerciales.length - 1) {
      console.log(`\n  ⏳ Pausa de seguridad de 20 segundos antes del siguiente contacto...`);
      await new Promise(r => setTimeout(r, 20000));
    }
  }

  console.log('\n================================================================================');
  console.log(' RESUMEN FINAL DEL DESPACHO DE HOY LUNES 26 DE OCTUBRE');
  console.log('================================================================================');
  const exitosos = resultados.filter(r => r.ok && !r.omitido).length;
  const omitidos = resultados.filter(r => r.omitido).length;
  const fallidos = resultados.filter(r => !r.ok).length;
  console.log(` Total evaluadas: ${comerciales.length}`);
  console.log(` ✅ Enviadas con éxito: ${exitosos}`);
  console.log(` ℹ Omitidas (ya enviadas): ${omitidos}`);
  console.log(` ❌ Fallidas: ${fallidos}`);
  console.log('================================================================================\n');
}

main().catch(console.error);
