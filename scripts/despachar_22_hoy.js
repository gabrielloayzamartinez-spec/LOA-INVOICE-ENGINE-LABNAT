import { cargarEnv, configFactura } from '../src/config.js';
import { headersCentral, resolverCamposPuente, escribirCamposPuente, agregarTagsContacto } from '../src/core/invoice_publisher.js';
import { enviarMensajeFacturaGhl, construirTextoMensaje, formatearNombreCompleto } from '../src/connectors/ghl_messages.js';
import { normalizarSede, obtenerAtencionSede } from '../src/core/sedes.js';
import { verificarEnlaceSincronizado } from '../src/core/link_validator.js';
import { recordAuditEvent } from '../src/core/audit.js';
import { crearClienteVtiger } from '../src/connectors/vtiger_webservice.js';
import { ORDEN_SELECT, normalizarOrden } from '../src/jobs/detectar_compras_nuevas.js';

cargarEnv();
const cfg = configFactura();
const headers = headersCentral(cfg.ghl.apiKeyCentral);
const loc = cfg.ghl.locationIdCentral;
const vt = crearClienteVtiger(cfg.vtiger);

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

async function esperarDespliegueRender(urlTest, maxIntentos = 30) {
  console.log(`Verificando sincronización del servidor Render (${urlTest})...`);
  for (let i = 1; i <= maxIntentos; i++) {
    const v = await verificarEnlaceSincronizado(urlTest);
    if (v.sincronizado) {
      console.log(`✅ Servidor Render actualizado y enlace verificado (HTTP ${v.status}, PDF confirmado: ${v.esPdf})`);
      return true;
    }
    console.log(`  [Intento ${i}/${maxIntentos}] Esperando despliegue de Render (10s)... Estado: ${v.detalle}`);
    await new Promise(r => setTimeout(r, 10000));
  }
  return false;
}

async function main() {
  console.log('================================================================================');
  console.log(' DESPACHO CONTROLADO Y PAUSADO: FACTURAS DE HOY (23 DE OCTUBRE)');
  console.log('================================================================================\n');

  // 1. Obtener órdenes comerciales válidas de hoy
  const qHoy = "SELECT " + ORDEN_SELECT.join(', ') + " FROM SalesOrder WHERE createdtime >= '2026-10-23 00:00:00' ORDER BY createdtime ASC";
  const rawHoy = await vt.consultar(qHoy);
  const normHoy = rawHoy.map(normalizarOrden);

  const comerciales = normHoy.filter(o =>
    String(o.asunto || '').trim().toUpperCase() === 'VENTA' &&
    Number(o.total || 0) >= 1.00 &&
    (String(o.estadoLogistico || '').toUpperCase().includes('VERIFICADA') || String(o.estadoLogistico || '').toUpperCase().includes('ENVIADA'))
  );

  console.log(`Total órdenes comerciales verificadas hoy a procesar: ${comerciales.length}\n`);

  if (!comerciales.length) {
    console.log('No hay órdenes para procesar hoy.');
    return;
  }

  // 2. Probar pre-vuelo en Render con la primera orden
  const primerEnlace = `https://facturas.labnaturales.com/${comerciales[0].numeroOrden}`;
  const renderListo = await esperarDespliegueRender(primerEnlace);
  if (!renderListo) {
    console.error('❌ Render aún no refleja los enlaces de hoy tras varios intentos. Deteniendo para proteger calidad.');
    process.exit(1);
  }

  // 3. Resolver campos puente en GHL
  const idsPuente = await resolverCamposPuente(loc, { headers });
  console.log('\nCampos puente GHL resueltos:', idsPuente);

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

    // A. PRE-FLIGHT VALIDATION
    console.log(`  1. Verificando pre-vuelo: ${urlBranded}...`);
    const verif = await verificarEnlaceSincronizado(urlBranded);
    if (!verif.sincronizado) {
      console.error(`  ❌ [BLOQUEADO] Pre-vuelo falló: ${verif.detalle}. No se enviará SMS.`);
      resultados.push({ orden: ord.numeroOrden, ok: false, motivo: 'PRE_VUELO_FALLIDO' });
      continue;
    }
    console.log(`  -> Pre-vuelo OK: Enlace sincronizado y responde PDF válido.`);

    // B. BUSCAR / CREAR CONTACTO EN GHL
    console.log(`  2. Buscando contacto en GHL...`);
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

    // C. ACTUALIZAR CAMPOS Y TAGS
    console.log(`  3. Actualizando campos y etiquetas en GHL...`);
    const customFields = [];
    if (idsPuente.urlFacturaPdf) customFields.push({ id: idsPuente.urlFacturaPdf, field_value: urlBranded });
    if (idsPuente.facturaNumeroOrden) customFields.push({ id: idsPuente.facturaNumeroOrden, field_value: ord.numeroOrden });
    if (idsPuente.sedeAsignada) customFields.push({ id: idsPuente.sedeAsignada, field_value: atencion.nombre });
    if (idsPuente.vtigerSede) customFields.push({ id: idsPuente.vtigerSede, field_value: atencion.clave });

    await escribirCamposPuente(contactId, customFields, { headers });
    await agregarTagsContacto(contactId, ['factura_lista', 'factura_enviada', `sede_${atencion.clave.toLowerCase()}`], { headers });

    // D. CONSTRUIR TEXTO DEL SMS
    const textoSms = construirTextoMensaje({
      nombre: ord.nombreCliente,
      apellido: ord.apellidoCliente,
      nombreCompleto,
      numeroOrden: ord.numeroOrden,
      urlPdf: urlBranded,
      sede: ord.sede
    });

    console.log(`  4. Enviando SMS oficial A2P desde ${cfg.ghl.smsFromNumber}...`);
    console.log(`  Texto SMS:\n  """\n  ${textoSms.replace(/\n/g, '\n  ')}\n  """`);

    // E. DISPARAR SMS
    const resSms = await enviarMensajeFacturaGhl({
      contactId,
      mensaje: textoSms,
      apiKey: cfg.ghl.apiKeyCentral,
      tipo: 'SMS',
      validarEnlace: true,
      urlAValidar: urlBranded
    });

    if (resSms.ok) {
      console.log(`  ✅ [EXITO] SMS entregado correctamente en GHL. MessageId: ${resSms.messageId}`);
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

    // F. PAUSA DE CADENCIA (20 segundos entre contactos para evitar ráfagas masivas)
    if (i < comerciales.length - 1) {
      console.log(`\n  ⏳ Pausa de seguridad de 20 segundos antes del siguiente contacto...`);
      await new Promise(r => setTimeout(r, 20000));
    }
  }

  console.log('\n================================================================================');
  console.log(' RESUMEN FINAL DEL DESPACHO DE FACTURAS DE HOY (23 DE OCTUBRE)');
  console.log('================================================================================');
  const exitosos = resultados.filter(r => r.ok).length;
  console.log(` Total evaluadas: ${comerciales.length}`);
  console.log(` ✅ Enviadas con éxito: ${exitosos}`);
  console.log(` ❌ Fallidas: ${comerciales.length - exitosos}`);
  console.log('================================================================================\n');
}

main().catch(console.error);
