/**
 * ==============================================================================
 * LOA INVOICE ENGINE - REPORTE DIARIO DE ORDENES VERIFICADAS Y ESTADO DE INVOICES
 * ==============================================================================
 * Genera el reporte diario que consolida:
 *   1. Todas las ordenes de venta con status Logistico = 'VERIFICADA' (vTiger cf_882)
 *      para la fecha solicitada.
 *   2. Estado de emision y publicacion del Invoice en GHL (Media Library y contacto).
 *   3. Estado del envio del mensaje (SMS / conversacion).
 *   4. Metricas ejecutivas y desglose por sede (PALACIOS, BENAVIDES, ROOSEVELT, etc.).
 *
 * Se puede ejecutar al final del dia o en la manana del dia siguiente.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { escaparValor } from '../connectors/vtiger_webservice.js';
import { ORDEN_SELECT, normalizarOrden, claveCursor, cargarCursor } from '../jobs/detectar_compras_nuevas.js';
import { leerPipeline, ultimoEstadoPorOrden } from './pipeline.js';

/**
 * Formatea una fecha o timestamp a formato YYYY-MM-DD.
 */
export function fechaYmd(fecha = new Date()) {
  if (typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
    return fecha.trim();
  }
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Genera el reporte diario de ordenes verificadas y envio de facturas.
 *
 * @param {object} args
 * @param {object} args.clienteVtiger        Cliente de Webservice vTiger.
 * @param {string} [args.fecha]              Fecha a reportar (YYYY-MM-DD). Default hoy.
 * @param {string} [args.sede]               Filtro de sede ('TODAS' o nombre de sede).
 * @param {string} [args.pipelineArchivo]    Ruta al archivo pipeline.jsonl.
 * @param {string} [args.cursorRuta]         Ruta al archivo cursor.json.
 * @param {boolean} [args.guardar]           Si debe guardar en disco (data/reports).
 * @param {string} [args.dirReportes]        Directorio de reportes.
 * @returns {Promise<object>}                Reporte estructurado y formateado en Markdown.
 */
export async function generarReporteDiario({
  clienteVtiger,
  fecha = null,
  sede = 'TODAS',
  pipelineArchivo = 'data/pipeline.jsonl',
  cursorRuta = 'data/cursor.json',
  guardar = true,
  dirReportes = 'data/reports'
} = {}) {
  if (!clienteVtiger || typeof clienteVtiger.consultar !== 'function') {
    throw new TypeError('generarReporteDiario requiere un clienteVtiger con .consultar(sql).');
  }

  const fechaReporte = fechaYmd(fecha || new Date());
  const sedeLimpia = String(sede || 'TODAS').toUpperCase().trim();
  const esGeneral = !sedeLimpia || sedeLimpia === 'TODAS' || sedeLimpia === 'GENERAL' || sedeLimpia === 'ALL';

  // 1) Consulta en vTiger de todas las SalesOrder VERIFICADAS en esa fecha
  const condicionSede = esGeneral ? '' : ` AND cf_3127 = '${escaparValor(sedeLimpia)}'`;
  const sql = `SELECT ${ORDEN_SELECT.join(', ')} FROM SalesOrder WHERE cf_882 = 'VERIFICADA' AND createdtime >= '${fechaReporte} 00:00:00' AND createdtime <= '${fechaReporte} 23:59:59'${condicionSede} ORDER BY createdtime ASC`;

  let filasVtiger = [];
  try {
    filasVtiger = await clienteVtiger.consultar(sql);
  } catch (e) {
    throw new Error(`Error consultando ordenes verificadas en vTiger: ${e.message}`);
  }

  // 2) Trazas de pipeline y cursor
  const trazasPipeline = fs.existsSync(pipelineArchivo) ? leerPipeline(pipelineArchivo) : [];
  const ultimosEstados = ultimoEstadoPorOrden(trazasPipeline);
  const estadosMap = new Map();
  for (const t of ultimosEstados) {
    const ordenId = String(t.orden || '').trim();
    const numOrden = String(t.numeroOrden || '').trim();
    if (ordenId) estadosMap.set(ordenId, t);
    if (numOrden) estadosMap.set(numOrden, t);
  }

  // Mapa de URLs de invoice encontradas en el pipeline
  const urlMap = new Map();
  for (const t of trazasPipeline) {
    const numOrden = String(t.numeroOrden || t.orden || '').trim();
    if (numOrden && t.url) urlMap.set(numOrden, t.url);
  }

  const cursor = fs.existsSync(cursorRuta) ? cargarCursor(cursorRuta) : { procesadas: {} };

  // 3) Consolidacion de cada orden
  const items = [];
  const desgloseSede = {};

  let publicadasCount = 0;
  let enviadasSmsCount = 0;
  let pendientesCount = 0;
  let omitidasCsCount = 0;
  let totalMonto = 0;

  for (const raw of filasVtiger) {
    const orden = normalizarOrden(raw);
    const clave = claveCursor(orden);
    const sedeOrden = (orden.sede || 'GENERAL').toUpperCase();

    if (!desgloseSede[sedeOrden]) {
      desgloseSede[sedeOrden] = { verificadas: 0, publicadas: 0, enviadasSms: 0, monto: 0 };
    }
    desgloseSede[sedeOrden].verificadas++;
    const monto = parseFloat(orden.total) || 0;
    desgloseSede[sedeOrden].monto += monto;
    totalMonto += monto;

    const pipelineTrace = estadosMap.get(orden.id) || estadosMap.get(orden.numeroOrden) || null;
    const estaEnCursor = Boolean(cursor?.procesadas?.[clave]);
    const urlFactura = urlMap.get(orden.numeroOrden) || urlMap.get(orden.id) || null;

    let estadoFactura = 'PENDIENTE';
    let smsStatus = 'PENDIENTE';

    if (pipelineTrace) {
      const st = String(pipelineTrace.estado || '').toUpperCase();
      if (st === 'ENVIADO') {
        estadoFactura = 'PUBLICADA';
        smsStatus = 'ENVIADO';
      } else if (st === 'MARCADO' || st === 'PUBLICADO') {
        estadoFactura = 'PUBLICADA';
        smsStatus = 'LISTO_PARA_ENVIO';
      } else if (st === 'BLOQUEADO' || st === 'OMITIDO') {
        estadoFactura = `NO_PUBLICADA (${pipelineTrace.motivo || st})`;
        smsStatus = 'NO_APLICA';
      } else {
        estadoFactura = st;
      }
    } else if (estaEnCursor) {
      estadoFactura = 'PUBLICADA';
      smsStatus = 'LISTO_PARA_ENVIO';
    }

    const esOmitidaCs = (monto <= 1.00) ||
      (orden.asunto && orden.asunto !== 'VENTA') ||
      (pipelineTrace?.motivo === 'ORDEN_MONTO_NO_COMERCIAL') ||
      (pipelineTrace?.motivo === 'ORDEN_ASUNTO_NO_FACTURABLE');

    if (estadoFactura === 'PUBLICADA') {
      publicadasCount++;
      desgloseSede[sedeOrden].publicadas++;
    } else if (esOmitidaCs && (estadoFactura.startsWith('NO_PUBLICADA') || estadoFactura === 'PENDIENTE')) {
      if (estadoFactura === 'PENDIENTE') estadoFactura = `NO_PUBLICADA (${orden.asunto !== 'VENTA' ? 'ASUNTO_NO_FACTURABLE' : 'MONTO_BAJO'})`;
      omitidasCsCount++;
    } else {
      pendientesCount++;
    }

    if (smsStatus === 'ENVIADO') {
      enviadasSmsCount++;
      desgloseSede[sedeOrden].enviadasSms++;
    }

    const clienteNombre = [orden.nombreCliente, orden.apellidoCliente].filter(Boolean).join(' ').trim() || 'CLIENTE';

    items.push({
      numeroOrden: orden.numeroOrden,
      id: orden.id,
      asunto: orden.asunto || '-',
      sede: sedeOrden,
      cliente: clienteNombre,
      telefono: orden.telefono || '-',
      total: monto.toFixed(2),
      horaCreacion: (orden.createdtime || '').slice(11, 19) || '-',
      estadoFactura,
      smsStatus,
      urlFactura
    });
  }

  const totalVerificadas = items.length;
  const tasaCumplimiento = totalVerificadas > 0 ? Math.round((publicadasCount / totalVerificadas) * 100) : 100;

  const stats = {
    fecha: fechaReporte,
    sede: esGeneral ? 'TODAS' : sedeLimpia,
    totalVerificadas,
    publicadas: publicadasCount,
    enviadasSms: enviadasSmsCount,
    omitidasCs: omitidasCsCount,
    pendientes: pendientesCount,
    totalMonto: totalMonto.toFixed(2),
    tasaCumplimientoPct: tasaCumplimiento,
    desgloseSede
  };

  // 4) Generacion de Markdown
  const lineasMd = [];
  lineasMd.push(`# REPORTE DIARIO: ÓRDENES VERIFICADAS Y EMISIÓN DE INVOICES`);
  lineasMd.push(`**Fecha:** ${fechaReporte} | **Sede:** ${stats.sede} | **Generado:** ${new Date().toISOString()}`);
  lineasMd.push('');
  lineasMd.push('## 1. Resumen Ejecutivo');
  lineasMd.push('');
  lineasMd.push('| Métrica | Valor |');
  lineasMd.push('| :--- | :--- |');
  lineasMd.push(`| **Órdenes de Venta Verificadas (cf_882)** | **${totalVerificadas}** |`);
  lineasMd.push(`| **Invoices Publicados en GHL** | **${publicadasCount}** |`);
  lineasMd.push(`| **Invoices con SMS Enviado** | **${enviadasSmsCount}** |`);
  lineasMd.push(`| **Órdenes CS/No Facturables Omitidas** | **${omitidasCsCount}** |`);
  lineasMd.push(`| **Invoices Pendientes** | **${pendientesCount}** |`);
  lineasMd.push(`| **Monto Total Facturado** | **$${stats.totalMonto} USD** |`);
  lineasMd.push(`| **Tasa de Cumplimiento** | **${tasaCumplimiento}%** |`);
  lineasMd.push('');
  lineasMd.push('## 2. Desglose por Sede');
  lineasMd.push('');
  lineasMd.push('| Sede | Verificadas | Invoices Publicados | SMS Enviados | Monto USD |');
  lineasMd.push('| :--- | :---: | :---: | :---: | :---: |');
  for (const [s, data] of Object.entries(desgloseSede)) {
    lineasMd.push(`| **${s}** | ${data.verificadas} | ${data.publicadas} | ${data.enviadasSms} | $${data.monto.toFixed(2)} |`);
  }
  lineasMd.push('');
  lineasMd.push('## 3. Detalle de Órdenes Verificadas');
  lineasMd.push('');
  lineasMd.push('| Orden | Asunto | Hora | Sede | Cliente | Teléfono | Total | Estado Invoice | SMS | Enlace PDF |');
  lineasMd.push('| :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :---: | :--- |');
  for (const it of items) {
    const enlace = it.urlFactura ? `[Ver PDF](${it.urlFactura})` : '-';
    lineasMd.push(`| **${it.numeroOrden}** | ${it.asunto || '-'} | ${it.horaCreacion} | ${it.sede} | ${it.cliente} | ${it.telefono} | $${it.total} | ${it.estadoFactura} | ${it.smsStatus} | ${enlace} |`);
  }
  lineasMd.push('');

  const reporteMd = lineasMd.join('\n');
  let rutaGuardada = null;

  if (guardar) {
    try {
      const dirDestino = path.resolve(dirReportes);
      fs.mkdirSync(dirDestino, { recursive: true });
      rutaGuardada = path.join(dirDestino, `reporte_diario_${fechaReporte}.md`);
      fs.writeFileSync(rutaGuardada, reporteMd, 'utf8');

      // Tambien guardamos el JSON estructurado para consumo automatizado
      const rutaJson = path.join(dirDestino, `reporte_diario_${fechaReporte}.json`);
      fs.writeFileSync(rutaJson, JSON.stringify({ stats, items }, null, 2), 'utf8');
    } catch {
      // Si falla guardar en disco, no revienta: devuelve el reporte en memoria
    }
  }

  return {
    ok: true,
    fecha: fechaReporte,
    stats,
    items,
    reporteMd,
    rutaGuardada
  };
}
