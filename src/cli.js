#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA INVOICE ENGINE - CLI
 * ==============================================================================
 * Comandos:
 *   check     Valida configuracion y accesos (NO publica nada).
 *   test-pdf  Descarga el PDF de una orden y lo guarda (diagnostico, sin publicar).
 *   publish   Publica la factura de UNA orden de UN contacto (prueba controlada).
 *   once      Un ciclo completo: detecta compras recientes y publica.
 *   scan      Ciclo continuo cada INVOICE_SCAN_INTERVAL_MINUTES.
 *
 * Uso:
 *   node src/cli.js check
 *   node src/cli.js test-pdf --record=6x35385
 *   node src/cli.js publish --contact=CONTACT_ID --order=6x35385 --numero=G-04212158
 *   node src/cli.js once
 *   node src/cli.js scan
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { cargarEnv, configFactura, validarConfig, resumenConfig } from './config.js';
import { configurarAuditoria, recordAuditEvent, leerAuditoria } from './core/audit.js';
import { crearClienteVtiger } from './connectors/vtiger_webservice.js';
import { crearClienteSesionWeb } from './connectors/vtiger_web_session.js';
import { leerPipeline, resumenPipeline, ultimoEstadoPorOrden, formatearResumen, atascadas } from './core/pipeline.js';
import { verificarAccesoMedia } from './connectors/ghl_media.js';
import { ghlFetch } from './connectors/ghl_client.js';
import { publicarFacturaDeContacto, headersCentral } from './core/invoice_publisher.js';
import { generarFacturaPdf, construirModeloInvoice, nombreArchivoInvoice, EMPRESA_POR_DEFECTO, contactoParaInvoice } from './core/invoice_render.js';
import { compararInvoiceConVtiger, formatearVerificacion } from './core/invoice_verify.js';
import { cargarCursor, guardarCursor, podarCursor, ejecutarCiclo, normalizarOrden, ORDEN_SELECT, detectarOrdenesVerificadas } from './jobs/detectar_compras_nuevas.js';
import { atenderEventoCompra } from './jobs/atender_evento.js';
import { iniciarServidorEventos } from './webhook_server.js';
import { generarReporteDiario } from './core/daily_report.js';
import { obtenerDiaOperativo, verificarCambioDia } from './core/dia_operativo.js';
import { obtenerAtencionSede } from './core/sedes.js';

cargarEnv();
const cfg = configFactura();
configurarAuditoria({ dir: cfg.logs.dir });

function args() {
  const salida = {};
  for (const a of process.argv.slice(3)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) salida[m[1]] = m[2];
    else if (a.startsWith('--')) salida[a.slice(2)] = true;
  }
  return salida;
}

function linea(t = '') { console.log(t); }
function titulo(t) { linea(`\n${'='.repeat(70)}\n ${t}\n${'='.repeat(70)}`); }

function clienteVtiger() {
  return crearClienteVtiger({ url: cfg.vtiger.url, username: cfg.vtiger.username, accessKey: cfg.vtiger.accessKey });
}

/** Busca el contacto en GHL por telefono (query / search). Si no existe y viene la orden, lo crea. Devuelve el id o null. */
async function buscarContactoGhl(telefono, { fetchImpl = null, orden = null, sede = null } = {}) {
  if (!telefono) return null;
  const headers = headersCentral(cfg.ghl.apiKeyCentral);
  const enviar = fetchImpl || ((u, o) => ghlFetch(u, o, 1, 'InvoiceLookup'));

  const digitos = String(telefono).replace(/\D/g, '');
  const variantes = [
    telefono.trim(),
    digitos,
    digitos.length === 10 ? `+1${digitos}` : (digitos.startsWith('1') && digitos.length === 11 ? `+${digitos}` : null),
    digitos.length === 11 && digitos.startsWith('1') ? digitos.slice(1) : null
  ].filter(Boolean);

  const unicos = [...new Set(variantes)];

  for (const query of unicos) {
    try {
      const url = `${cfg.ghl.baseUrl}/contacts/?locationId=${encodeURIComponent(cfg.ghl.locationIdCentral)}&query=${encodeURIComponent(query)}`;
      const res = await enviar(url, { method: 'GET', headers });
      const texto = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) continue;
      const cuerpo = JSON.parse(texto);
      const contactId = cuerpo?.contacts?.[0]?.id || cuerpo?.contact?.id || null;
      if (contactId) return contactId;
    } catch {
      /* prueba la siguiente variante */
    }
  }

  // Si no se encontro y viene orden, crear el contacto para que la orden no quede huerfana
  if (orden && (orden.nombreCliente || orden.apellidoCliente)) {
    try {
      const atencion = obtenerAtencionSede(sede || orden.sede);
      const telE164 = digitos.length === 10 ? `+1${digitos}` : (digitos.startsWith('1') && digitos.length === 11 ? `+${digitos}` : `+${digitos}`);
      const bodyCreate = {
        firstName: orden.nombreCliente || 'Cliente',
        lastName: orden.apellidoCliente || '',
        name: [orden.nombreCliente, orden.apellidoCliente].filter(Boolean).join(' ').trim(),
        phone: telE164,
        locationId: cfg.ghl.locationIdCentral,
        tags: ['vtiger', `sede_${atencion.clave.toLowerCase()}`]
      };
      const resCreate = await enviar(`${cfg.ghl.baseUrl}/contacts/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyCreate)
      });
      if (resCreate.ok) {
        const textoCreate = await (resCreate.text ? resCreate.text().catch(() => '') : Promise.resolve(''));
        const cuerpoCreate = JSON.parse(textoCreate || '{}');
        return cuerpoCreate?.contact?.id || null;
      }
    } catch {}
  }

  return null;
}

// ------------------------------------------------------------------------------
// COMANDO: check
// ------------------------------------------------------------------------------
async function comandoCheck() {
  titulo('CHECK - Estado del motor de facturas (no publica nada)');
  linea(JSON.stringify(resumenConfig(cfg), null, 2));

  // La sesion web de vTiger (Via A) YA NO se usa: el invoice se genera localmente.
  // Si el PDF se toma de vTiger (OPCION A, por defecto), la sesion web es OBLIGATORIA.
  const v = validarConfig(cfg, { webservice: true, sesionWeb: cfg.pdf.fuente === 'vtiger', ghl: true });
  linea(`\nConfiguracion: ${v.ok ? 'COMPLETA' : `FALTAN -> ${v.faltantes.join(', ')}`}`);
  if (!cfg.habilitado) linea('Interruptor: APAGADO (INVOICE_PDF_ENABLED=false). Nada se publicara.');

  if (cfg.ghl.apiKeyCentral && cfg.ghl.locationIdCentral) {
    const acceso = await verificarAccesoMedia({ locationId: cfg.ghl.locationIdCentral, apiKey: cfg.ghl.apiKeyCentral });
    linea(`\nMedia Library: ${acceso.ok ? 'ACCESIBLE' : `NO ACCESIBLE -> ${acceso.motivo} (${acceso.status})`}`);
    if (!acceso.ok) linea('  Un 401 = token invalido; un 403 = falta el scope medias.read/medias.write.');
  }

  if (cfg.vtiger.url && cfg.vtiger.username && cfg.vtiger.accessKey) {
    try {
      const vt = clienteVtiger();
      const filas = await vt.consultar("SELECT id FROM Contacts WHERE cf_3451 = 'PALACIOS' AND spl_num_compras > 0 LIMIT 1");
      linea(`\nvTiger webservice: OK (${filas.length} comprador de prueba leido)`);
    } catch (e) {
      linea(`\nvTiger webservice: ERROR -> ${e.message}`);
    }
  }

  if (cfg.vtiger.webUsername && cfg.vtiger.webPassword) {
    const sesion = crearClienteSesionWeb();
    try {
      await sesion.asegurarSesion();
      linea('vTiger sesion web: OK (login correcto)');
      sesion.cerrar();
    } catch (e) {
      linea(`vTiger sesion web: ERROR -> ${e.code || e.name}: ${e.message}`);
    }
  } else {
    linea(`\nvTiger sesion web: no configurada${cfg.pdf.fuente === 'vtiger' ? ' -> OBLIGATORIA para el PDF OFICIAL (definir VTIGER_WEB_USERNAME / VTIGER_WEB_PASSWORD)' : ' (no hace falta: se usa la plantilla propia)'}`);
  }

  titulo('Ultimos eventos de auditoria');
  for (const ev of leerAuditoria(5)) linea(`  ${ev.ts || ''} ${ev.type || ''} ${ev.message || ''}`.slice(0, 160));
}

// ------------------------------------------------------------------------------
// COMANDO: test-pdf
// ------------------------------------------------------------------------------
async function comandoTestPdf() {
  const { record, app } = args();
  titulo('TEST-PDF - Descarga del PDF OFICIAL de vTiger (no publica nada)');
  if (!record) return linea('Falta --record=<id de SalesOrder>.');

  const sesion = crearClienteSesionWeb();
  const appEfectiva = app ? String(app) : cfg.pdf.app;

  // Metodo principal: la URL exacta que usa la interfaz (ExportPDF + app).
  const r = await sesion.descargarDocumentoOficial({ record, modulo: 'SalesOrder', app: appEfectiva });
  let buffer = r.ok ? r.buf : null;
  let origen = `ExportPDF + app=${appEfectiva}`;

  if (!r.ok) {
    linea(`[aviso] El PDF oficial no se obtuvo (${r.motivo}${r.detalle ? `: ${r.detalle}` : ''}).`);
    linea('        Probando la via con folderid (plantillas del modulo)...');
    const alt = await sesion.descargarPdfAuto({ record, modulo: 'SalesOrder' });
    if (alt.ok) { buffer = alt.buf; origen = `ExportPDF + folderid=${alt.folderId}`; }
    else return linea(`[BLOQUEADO] No se obtuvo el PDF (oficial: ${r.motivo}; folderid: sin resultado).`);
  }

  const destino = path.join('data', 'out', `OFICIAL_${String(record).replace(/[^A-Za-z0-9-]/g, '')}.pdf`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buffer);
  linea(`[OK] PDF de ${buffer.length} bytes (${origen})`);
  linea(`     Guardado en ${destino}`);
  linea('     (No se subio nada a GHL ni se publico ninguna factura.)');
}

// ------------------------------------------------------------------------------
// COMANDO: preview
// ------------------------------------------------------------------------------
async function comandoPreview() {
  const { record, out, modo, logo } = args();
  titulo('PREVIEW - Invoice con datos REALES de vTiger (NO publica nada)');
  if (!record) return linea('Falta --record=<id de SalesOrder>. Ej: --record=6x35385');

  const vt = clienteVtiger();
  const filas = await vt.consultar(
    `SELECT id, salesorder_no, contact_id, createdtime, hdnGrandTotal, sostatus, cf_1069, cf_3156, quantity, cf_870, cf_872, cf_876, cf_1053 FROM SalesOrder WHERE id = '${String(record).replace(/'/g, '')}' LIMIT 1`
  );
  if (!filas.length) return linea(`No se encontro la orden ${record} en vTiger.`);

  const cruda = filas[0];
  const orden = normalizarOrden(cruda);

  // Datos del cliente (los mismos de la etiqueta de envio).
  let contacto = {};
  if (cruda.contact_id) {
    const idContacto = String(cruda.contact_id).replace(/'/g, '');
    try {
      const c = await vt.consultar(`SELECT id, firstname, lastname, phone, mobile, homephone, cf_870, cf_872, cf_876, cf_1053 FROM Contacts WHERE id = '${idContacto}' LIMIT 1`);
      contacto = c[0] || {};
    } catch (e) {
      linea(`  [aviso] Algun campo del contacto esta restringido: ${String(e.message).slice(0, 110)}`);
      const c = await vt.consultar(`SELECT id, firstname, lastname, phone, mobile, homephone FROM Contacts WHERE id = '${idContacto}' LIMIT 1`);
      contacto = c[0] || {};
    }
  }

  const modoEfectivo = modo === 'detalle' ? 'detalle' : 'etiqueta';
  const empresa = { ...EMPRESA_POR_DEFECTO };
  if (logo) empresa.logoPath = String(logo);

  const contactoDoc = contactoParaInvoice({ contacto, orden });
  const pdf = await generarFacturaPdf({ orden, contacto: contactoDoc, empresa, modo: modoEfectivo });
  const modelo = construirModeloInvoice({ orden, contacto: contactoDoc, empresa, modo: modoEfectivo });

  const destino = out ? String(out) : path.join('data', 'out', nombreArchivoInvoice(orden));
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, pdf);

  linea(`  Orden      : ${orden.numeroOrden}  (record ${orden.id})`);
  linea(`  Fecha      : ${orden.fecha}`);
  linea(`  Total      : ${modelo.total} USD`);
  linea(`  Cliente    : ${modelo.cliente.nombre}`);
  linea(`  Envio      : ${modelo.cliente.lineas.join(' / ') || '(sin direccion en vTiger)'}`);
  linea(`  Emisor     : ${modelo.emisor.nombre}`);
  linea(`  Lineas     : ${modelo.tabla.filas.map(f => `${f.texto}${f.cantidad ? ` x${f.cantidad}` : ''} = ${f.total}`).join('  |  ')}`);
  linea(`  PDF        : ${pdf.length} bytes -> ${destino}`);
  linea('  (Muestra local: no se subio nada a GHL y no se publico ninguna factura.)');
}

// ------------------------------------------------------------------------------
// COMANDO: publish
// ------------------------------------------------------------------------------
async function comandoPublish() {
  const { contact, order, numero } = args();
  titulo('PUBLISH - Publicar la factura de UNA orden (prueba controlada)');
  if (!contact || !order) return linea('Uso: node src/cli.js publish --contact=CONTACT_ID --order=RECORD_ID [--numero=G-XXXX]');

  const orden = { id: String(order), numeroOrden: numero ? String(numero) : '' };
  if (!orden.numeroOrden) {
    const vt = clienteVtiger();
    const filas = await vt.consultar(`SELECT ${ORDEN_SELECT.join(', ')} FROM SalesOrder WHERE id = '${orden.id}' LIMIT 1`);
    if (!filas.length) return linea(`No se encontro la orden ${orden.id} en vTiger.`);
    Object.assign(orden, normalizarOrden(filas[0]));
  }

  linea(`Orden: ${orden.numeroOrden} (record ${orden.id}) | contacto GHL: ${contact}`);
  const resultado = await publicarFacturaDeContacto({ contactId: String(contact), orden, habilitado: true, sede: cfg.escaneo.sede });
  linea(`\nResultado: ${JSON.stringify(resultado, null, 2)}`);
}

// ------------------------------------------------------------------------------
// COMANDO: serve  (DISPARADOR UNICO por evento — modo recomendado)
// ------------------------------------------------------------------------------
async function comandoServe() {
  const { port } = args();
  titulo('SERVE - Endpoint de eventos (disparador unico, SIN barrido)');

  const validacion = validarConfig(cfg, { webservice: true, sesionWeb: cfg.pdf.fuente === 'vtiger', ghl: true, webhook: true });
  if (!validacion.ok) return linea(`[STOP] Faltan variables: ${validacion.faltantes.join(', ')}`);
  if (!cfg.habilitado) {
    linea('  [MODO SEGURO] INVOICE_PDF_ENABLED=false: Emisión desactivada. Redirecciones (/S-XXXXX) y /salud ACTIVAS.');
  }

  const vt = clienteVtiger();
  const atender = (payload) => atenderEventoCompra({
    payload,
    clienteVtiger: vt,
    sede: cfg.escaneo.sede,
    filtroEstadoLogistico: cfg.escaneo.triggerStatus || 'VERIFICADA',
    fechaMinima: cfg.escaneo.fechaMinima || '2026-10-21',
    buscarContactoGhl: (tel) => buscarContactoGhl(tel)
  });

  const puerto = port ? Number(port) : cfg.webhook.puerto;
  const { url } = await iniciarServidorEventos({
    puerto,
    atender,
    token: cfg.webhook.token,
    rutaLinks: cfg.marca?.linksPath || 'data/links.json',
    rutaPipeline: cfg.escaneo?.pipelinePath || 'data/pipeline.jsonl'
  });

  linea('');
  linea(`  Escuchando en : ${url}`);
  linea(`  Salud         : GET  ${url}/salud`);
  linea(`  Factura (GET) : ${url}/:numeroOrden   (ej: ${url}/S-97576)`);
  linea(`  Evento (POST) : ${url}/evento/compra   (header: x-loa-token)`);

  // --- MOTOR AUTONOMO CONTINUO EN LA NUBE (RENDER) ---
  if (cfg.habilitado && cfg.escaneo.intervaloMinutos > 0) {
    linea(`\n  🚀 ACTIVANDO MOTOR AUTÓNOMO EN RENDER: escaneo cada ${cfg.escaneo.intervaloMinutos} minuto(s)`);
    const rutaCursor = cfg.escaneo.cursorPath;
    let ejecutando = false;

    const correrCicloAutonomo = async () => {
      if (ejecutando) {
        linea('  [AUTO-SCAN] Ciclo previo aún en curso, esperando próximo turno...');
        return;
      }
      ejecutando = true;
      try {
        const cursor = cargarCursor(rutaCursor);
        await unCiclo({ cursor, rutaCursor });
      } catch (err) {
        recordAuditEvent({
          type: 'INVOICE_CICLO_FALLIDO',
          severity: 'error',
          message: `Fallo ciclo autónomo en Render: ${err.message}`
        });
        linea(`  [AUTO-SCAN ERROR] ${err.message}`);
      } finally {
        ejecutando = false;
      }
    };

    // Primer escaneo tras 10s de arranque seguro
    setTimeout(correrCicloAutonomo, 10000);
    // Ciclos continuos recurrentes
    setInterval(correrCicloAutonomo, cfg.escaneo.intervaloMinutos * 60 * 1000);
  }

  linea('');
  linea('  Servidor y motor autónomo activos.');
}

// ------------------------------------------------------------------------------
// COMANDOS: once / scan  (MODO RECUPERACION — barrido)
// ------------------------------------------------------------------------------
async function unCiclo({ cursor, rutaCursor, sedeOverride = null, diasOverride = null, loteOverride = null } = {}) {
  const vt = clienteVtiger();
  const sedeEfectiva = sedeOverride !== null && sedeOverride !== undefined ? String(sedeOverride).toUpperCase() : cfg.escaneo.sede;
  const diasEfectivos = diasOverride !== null && diasOverride !== undefined ? Number(diasOverride) : cfg.escaneo.dias;
  const loteEfectivo = loteOverride !== null && loteOverride !== undefined ? Number(loteOverride) : cfg.escaneo.lote;

  const diaOp = obtenerDiaOperativo();
  linea(`\n[DÍA OPERATIVO ACTIVO] ${diaOp.descripcion} (Horario estricto: 12:00:00 AM a 11:59:59 PM)`);

  const resumen = await ejecutarCiclo({
    clienteVtiger: vt,
    publicar: (candidato) => publicarFacturaDeContacto({
      contactId: candidato.contactId,
      orden: candidato.orden,
      sede: candidato.sede || sedeEfectiva
    }),
    cursor,
    sede: sedeEfectiva,
    dias: diasEfectivos,
    lote: loteEfectivo,
    modoDeteccion: 'ordenes_verificadas',
    fechaMinima: cfg.escaneo.fechaMinima,
    soloHoy: cfg.escaneo.soloHoy,
    estadoLogistico: cfg.escaneo.triggerStatus || 'VERIFICADA',
    estadoCompra: cfg.escaneo.estadoCompra,
    buscarContactoGhl: (tel) => buscarContactoGhl(tel)
  });

  const podado = podarCursor(cursor, { maxEntradas: 5000 });
  const guardado = guardarCursor(rutaCursor, podado);

  linea(`\nRevisados: ${resumen.deteccion.revisados} | Candidatos: ${resumen.deteccion.candidatos.length} | Publicadas: ${resumen.publicaciones.filter(p => p.resultado?.publicado).length} | Marcadas en cursor: ${resumen.marcadas}`);
  for (const o of resumen.deteccion.omitidos.slice(0, 10)) linea(`  omitido ${o.ordenId || o.vTigerId}: ${o.motivo}`);
  for (const e of resumen.deteccion.errores.slice(0, 10)) linea(`  error ${e.ordenId || e.vTigerId} (${e.etapa}): ${e.detalle}`);
  for (const p of resumen.publicaciones) linea(`  ${p.resultado?.publicado ? '[PUBLICADA]' : '[NO]'} ${p.orden.numeroOrden} -> ${p.resultado?.motivo}${p.resultado?.url ? ` | ${p.resultado.url}` : ''}`);
  linea(`Cursor: ${guardado.ok ? 'guardado' : `ERROR ${guardado.error}`} (${rutaCursor})`);

  recordAuditEvent({ type: 'INVOICE_CICLO', severity: 'info', message: `Ciclo completado (${sedeEfectiva}): ${resumen.deteccion.candidatos.length} candidatos, ${resumen.publicaciones.filter(p => p.resultado?.publicado).length} publicadas.` });
  return resumen;
}

async function comandoOnce() {
  const { sede, dias, lote } = args();
  titulo('ONCE - Recuperacion manual: un barrido de compras (el flujo normal es por evento)');
  const validacion = validarConfig(cfg, { webservice: true, sesionWeb: cfg.pdf.fuente === 'vtiger', ghl: true });
  if (!validacion.ok) return linea(`[STOP] Faltan variables: ${validacion.faltantes.join(', ')}`);
  if (!cfg.habilitado) return linea('[STOP] El interruptor esta APAGADO. Poner INVOICE_PDF_ENABLED=true para publicar.');

  const rutaCursor = cfg.escaneo.cursorPath;
  await unCiclo({ cursor: cargarCursor(rutaCursor), rutaCursor, sedeOverride: sede, diasOverride: dias, loteOverride: lote });
}

async function comandoScan() {
  const { sede, dias, lote } = args();
  titulo(`SCAN - Recuperacion continua cada ${cfg.escaneo.intervaloMinutos} minuto(s) (el flujo normal es por evento)`);
  const validacion = validarConfig(cfg, { webservice: true, sesionWeb: cfg.pdf.fuente === 'vtiger', ghl: true });
  if (!validacion.ok) return linea(`[STOP] Faltan variables: ${validacion.faltantes.join(', ')}`);
  if (!cfg.habilitado) return linea('[STOP] El interruptor esta APAGADO. Poner INVOICE_PDF_ENABLED=true para publicar.');

  const rutaCursor = cfg.escaneo.cursorPath;
  const cursor = cargarCursor(rutaCursor);
  const intervaloMs = cfg.escaneo.intervaloMinutos * 60 * 1000;

  const correr = async () => {
    try { await unCiclo({ cursor, rutaCursor, sedeOverride: sede, diasOverride: dias, loteOverride: lote }); }
    catch (e) { recordAuditEvent({ type: 'INVOICE_CICLO_FALLIDO', severity: 'error', message: e.message }); }
  };

  await correr();
  setInterval(correr, intervaloMs);
  linea(`\nMotor en marcha. Proximo ciclo en ${cfg.escaneo.intervaloMinutos} minuto(s). Ctrl+C para detener.`);
}

// ------------------------------------------------------------------------------
// COMANDO: verificar
// ------------------------------------------------------------------------------
async function comandoVerificar() {
  const { record, numero } = args();
  titulo('VERIFICAR - El invoice contra vTiger, campo por campo (solo lee, no publica)');
  if (!record && !numero) return linea('Falta --record=<id de SalesOrder> o --numero=<S-XXXXX>.');

  const vt = clienteVtiger();
  const where = record
    ? `id = '${String(record).replace(/'/g, '')}'`
    : `salesorder_no = '${String(numero).replace(/'/g, '')}'`;

  const filas = await vt.consultar(
    `SELECT id, salesorder_no, contact_id, createdtime, hdnGrandTotal, sostatus, cf_1069, cf_3156, quantity, cf_870, cf_872, cf_876, cf_1053 FROM SalesOrder WHERE ${where} LIMIT 1`
  );
  if (!filas.length) return linea(`No se encontro la orden (${where}).`);
  const orden = normalizarOrden(filas[0]);

  let contacto = {};
  let permisoDireccion = true;
  if (filas[0].contact_id) {
    const idc = String(filas[0].contact_id).replace(/'/g, '');
    try {
      const c = await vt.consultar(`SELECT id, firstname, lastname, phone, mobile, homephone, cf_870, cf_872, cf_876, cf_1053 FROM Contacts WHERE id = '${idc}' LIMIT 1`);
      contacto = c[0] || {};
    } catch (e) {
      permisoDireccion = false;
      const c = await vt.consultar(`SELECT id, firstname, lastname, phone, mobile, homephone FROM Contacts WHERE id = '${idc}' LIMIT 1`);
      contacto = c[0] || {};
    }
  }

  const contactoDoc = contactoParaInvoice({ contacto, orden });
  const modelo = construirModeloInvoice({ orden, contacto: contactoDoc });
  const r = compararInvoiceConVtiger({ orden, contacto: contactoDoc, modelo });

  linea('');
  linea(formatearVerificacion(r));
  linea('');
  linea(`  Orden verificada    : ${orden.numeroOrden} (record ${orden.id})`);
  linea(`  Veredicto           : ${r.consistente ? 'CONSISTENTE (el invoice coincide con vTiger)' : 'REVISAR'}`);
  if (r.diferencias.length) linea(`  Diferencias         : ${r.diferencias.join(', ')}`);
  if (r.faltantesEnVtiger.length) linea(`  vTiger NO entrego   : ${r.faltantesEnVtiger.join(', ')}`);
  if (!permisoDireccion) {
    linea('  Causa probable      : el usuario de la API no tiene permiso sobre cf_870 (direccion).');
    linea('                        Pedir al administrador de vTiger que habilite ese campo, o el invoice saldra sin direccion.');
  }
  linea('  (Solo lectura en vTiger. No se publico nada en GHL.)');
}

// ------------------------------------------------------------------------------
// COMANDO: report  (MONITOR del pipeline por sede)
// ------------------------------------------------------------------------------
async function comandoReport() {
  const { sede } = args();
  titulo('REPORT - Pipeline de compras por sede (traza hasta el SMS)');

  const archivo = cfg.escaneo.pipelinePath || 'data/pipeline.jsonl';
  const filas = leerPipeline(archivo);
  const porSede = resumenPipeline(filas);

  linea(formatearResumen(porSede));
  linea('');
  linea('Etapas de exito: DETECTADA → ORDEN_RESUELTA → PDF_OBTENIDO → PUBLICADO → MARCADO → ENVIADO');
  linea('  MARCADO = factura publicada y lista para el workflow (exito del motor).');
  linea('  ENVIADO = GHL confirmo el SMS (tag FACTURA_ENVIADA).');
  linea('');

  const finales = ultimoEstadoPorOrden(filas);
  const filtradas = sede ? finales.filter(f => String(f.sede || '') === String(sede).toUpperCase()) : finales;
  linea(`Ultimas 15 compras${sede ? ` (sede ${sede.toUpperCase()})` : ''}:`);
  for (const f of filtradas.slice(-15).reverse()) {
    const hora = (f.ts || '').slice(11, 19);
    linea(`  ${String(f.numeroOrden || f.orden).padEnd(14)} ${String(f.sede || '-').padEnd(12)} ${f.estado.padEnd(16)} ${hora}  ${f.motivo || f.detalle || ''}`.slice(0, 110));
  }

  const atasc = atascadas(filas, { minutos: 30 });
  const atascFiltradas = sede ? atasc.filter(f => String(f.sede || '') === String(sede).toUpperCase()) : atasc;
  if (atascFiltradas.length) {
    linea('');
    linea(`⚠ ATASCADAS (>30 min en etapa intermedia): ${atascFiltradas.length}`);
    for (const f of atascFiltradas) linea(`  ${f.numeroOrden} (${f.sede || '-'}) -> ${f.estado}`);
  }
}

// ------------------------------------------------------------------------------
// COMANDO: report-diario  (REPORTE DE ORDENES VERIFICADAS Y ESTADO DE INVOICES)
// ------------------------------------------------------------------------------
async function comandoReportDiario() {
  const { fecha, sede, noGuardar } = args();
  titulo('REPORT-DIARIO - Ordenes de Venta VERIFICADAS y estado del Invoice');

  const validacion = validarConfig(cfg, { webservice: true, sesionWeb: false, ghl: false });
  if (!validacion.ok) return linea(`[STOP] Faltan variables: ${validacion.faltantes.join(', ')}`);

  const vt = clienteVtiger();
  const fechaEfectiva = fecha || new Date().toISOString().slice(0, 10);
  const sedeEfectiva = sede ? String(sede).toUpperCase() : cfg.escaneo.sede;

  const r = await generarReporteDiario({
    clienteVtiger: vt,
    fecha: fechaEfectiva,
    sede: sedeEfectiva,
    pipelineArchivo: cfg.escaneo.pipelinePath || 'data/pipeline.jsonl',
    cursorRuta: cfg.escaneo.cursorPath || 'data/cursor.json',
    guardar: !noGuardar,
    dirReportes: cfg.reporte?.dir || 'data/reports'
  });

  linea('');
  linea(r.reporteMd);
  if (r.rutaGuardada) {
    linea(`\nReporte guardado en: ${r.rutaGuardada}`);
  }
}

// ------------------------------------------------------------------------------
// DESPACHO
// ------------------------------------------------------------------------------
const comandos = {
  serve: comandoServe,
  check: comandoCheck,
  report: comandoReport,
  'report-diario': comandoReportDiario,
  'daily-report': comandoReportDiario,
  verificar: comandoVerificar,
  'test-pdf': comandoTestPdf,
  preview: comandoPreview,
  publish: comandoPublish,
  once: comandoOnce,
  scan: comandoScan
};

const comando = process.argv[2] || 'check';
const ejecutar = comandos[comando];

if (!ejecutar) {
  linea(`Comando desconocido: ${comando}`);
  linea(`Disponibles: ${Object.keys(comandos).join(', ')}`);
  process.exitCode = 1;
} else {
  try {
    await ejecutar();
  } catch (e) {
    recordAuditEvent({ type: 'INVOICE_CLI_ERROR', severity: 'error', message: `${comando}: ${e.message}` });
    linea(`\n[ERROR] ${e.message}`);
    process.exitCode = 1;
  }
}
