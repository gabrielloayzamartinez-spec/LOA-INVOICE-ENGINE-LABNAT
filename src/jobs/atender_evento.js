/**
 * ==============================================================================
 * LOA INVOICE ENGINE - ATENCION DE UN EVENTO DE COMPRA (DISPARADOR UNICO)
 * ==============================================================================
 * Reemplaza al barrido como via principal: NO recorre la base, NO espera turnos.
 * Recibe UN evento (una venta que acaba de quedar efectuada) y publica ESA
 * factura, en segundos.
 *
 * QUIEN EMITE EL EVENTO (el motor sirve para los dos casos):
 *   A) Workflow de vTiger al cambiar el estado del contacto a VENDIDO -> POST al
 *      endpoint del motor (`src/webhook_server.js`).
 *   B) El motor LOA que ya sincroniza vTiger (detecta cambios por
 *      `last_modified_time`) y llama a `atenderEventoCompra()` directamente,
 *      sin HTTP.
 *
 * IDEMPOTENCIA: un evento puede repetirse (reintento del CRM, doble clic, doble
 * entrega del webhook). Es seguro por dos razones que YA existen:
 *   1. Campo `Factura Nº Orden` en el contacto (fuente de verdad en GHL).
 *   2. Cursor local (`data/cursor.json`).
 * Un evento duplicado termina en `YA_PUBLICADA` sin volver a subir el archivo.
 *
 * CONSUMO MINIMO: 1 consulta para la orden + (si hace falta) 1 para el telefono.
 * Sin barrido no hay N consultas por ciclo.
 * ==============================================================================
 */

import { escaparValor } from '../connectors/vtiger_webservice.js';
import { normalizarOrden, ORDEN_SELECT } from './detectar_compras_nuevas.js';
import { publicarFacturaDeContacto } from '../core/invoice_publisher.js';
import { recordAuditEvent } from '../core/audit.js';
import { registrarPipeline } from '../core/pipeline.js';
import { resolverFechaCorte } from '../core/dia_operativo.js';

/** Motivos propios del canal de eventos (el resto los aporta el publicador). */
export const MOTIVOS_EVENTO = {
  EVENTO_INCOMPLETO: 'EVENTO_INCOMPLETO',
  ORDEN_NO_ENCONTRADA: 'ORDEN_NO_ENCONTRADA',
  ORDEN_NO_VERIFICADA: 'ORDEN_NO_VERIFICADA',
  ORDEN_ANTERIOR_A_FECHA_CORTE: 'ORDEN_ANTERIOR_A_FECHA_CORTE',
  CONTACTO_NO_ENCONTRADO: 'CONTACTO_NO_ENCONTRADO'
};

/** Campos de la orden para el canal de eventos (incluye el vinculo al contacto). */
export const ORDEN_SELECT_EVENTO = [...new Set([...ORDEN_SELECT, 'contact_id'])];

/**
 * Normaliza el payload del evento, aceptando las formas reales que puede enviar
 * un CRM (vTiger webhook) o el sync interno. No inventa datos: lo que no viene,
 * queda vacio y se resuelve despues contra vTiger.
 *
 * Formas toleradas (ejemplos):
 *   { salesorder_id: '6x1' }  |  { record: '6x1' }  |  { id: '6x1' }
 *   { salesorder_no: 'S-96567' }  |  { numero: 'S-96567' }
 *   { contact_id: '12x1' }  |  { phone: '+1...' }  |  { ghlContactId: 'abc' }
 *   { event: 'vtiger.entity.aftersave', data: { ... } }   <- payload de vTiger
 */
export function normalizarEventoCompra(payload = {}) {
  const raiz = (payload && typeof payload === 'object') ? payload : {};
  const datos = (raiz.data && typeof raiz.data === 'object') ? { ...raiz, ...raiz.data } : raiz;

  const primero = (...valores) => {
    for (const v of valores) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  return {
    ordenId: primero(datos.salesorder_id, datos.salesorderid, datos.record, datos.recordId, datos.id),
    numeroOrden: primero(datos.salesorder_no, datos.salesorderno, datos.numero, datos.numeroOrden),
    vTigerContactId: primero(datos.contact_id, datos.contactid, datos.contactId, datos.contacto),
    telefono: primero(datos.phone, datos.mobile, datos.telefono, datos.phoneNumber),
    ghlContactId: primero(datos.ghlContactId, datos.ghl_contact_id, datos.locationContactId),
    estado: primero(datos.cf_994, datos.estado, datos.estadoVenta),
    evento: primero(datos.event, datos.eventType)
  };
}

/**
 * Procesa UN evento de compra y publica esa factura.
 *
 * Orden de resolucion (deliberado, para minimizar consultas y no publicar a ciegas):
 *   1. La ORDEN (1 consulta) -> si no existe, se aborta.
 *   2. El CONTACTO destino -> del evento, o por telefono (evento / vTiger + lookup).
 *   3. La publicacion (genera PDF, sube, marca el contacto).
 *
 * @param {object}   args
 * @param {object}   args.payload             Evento crudo (cualquier forma tolerada).
 * @param {object}   args.clienteVtiger       Cliente del webservice (`consultar`).
 * @param {Function} [args.buscarContactoGhl] (telefono) => contactId | null
 * @param {string}   [args.sede]              Etiqueta de sede para auditoria.
 * @param {boolean}  [args.habilitado]        Override del interruptor (pruebas).
 * @param {Function} [args.publicar]          Inyectable para pruebas.
 * @param {string}   [args.filtroEstadoLogistico] Estado logistico requerido (ej: 'VERIFICADA').
 * @param {string}   [args.fechaMinima]       Fecha minima estricta (ej: '2026-10-21').
 * @returns {Promise<{ok: boolean, motivo: string, detalle: string|null, resultado: object|null, orden: object|null}>}
 */
export async function atenderEventoCompra({
  payload = {},
  clienteVtiger,
  buscarContactoGhl = null,
  sede = null,
  habilitado = null,
  publicar = publicarFacturaDeContacto,
  pipelineArchivo = 'data/pipeline.jsonl',
  filtroEstadoLogistico = null,
  fechaMinima = null
} = {}) {
  const evento = normalizarEventoCompra(payload);
  const vacio = { resultado: null, orden: null };

  if (!evento.ordenId && !evento.numeroOrden) {
    return { ok: false, motivo: MOTIVOS_EVENTO.EVENTO_INCOMPLETO, detalle: 'El evento no trae ni el id ni el numero de la orden.', ...vacio };
  }
  if (!clienteVtiger || typeof clienteVtiger.consultar !== 'function') {
    throw new TypeError('atenderEventoCompra requiere clienteVtiger.consultar() para resolver la orden.');
  }
  registrarPipeline(pipelineArchivo, { orden: evento.ordenId, numeroOrden: evento.numeroOrden, sede, estado: 'DETECTADA' });

  // 1) La orden (una sola consulta, acotada por id o por numero).
  const where = evento.ordenId
    ? `id = '${escaparValor(evento.ordenId)}'`
    : `salesorder_no = '${escaparValor(evento.numeroOrden)}'`;

  let filas = [];
  try {
    filas = await clienteVtiger.consultar(`SELECT ${ORDEN_SELECT_EVENTO.join(', ')} FROM SalesOrder WHERE ${where} LIMIT 1`);
  } catch (e) {
    recordAuditEvent({ type: 'INVOICE_EVENTO_FALLO', severity: 'warn', sede, message: `No se pudo leer la orden del evento: ${e.message}` });
    return { ok: false, motivo: MOTIVOS_EVENTO.ORDEN_NO_ENCONTRADA, detalle: e.message, ...vacio };
  }
  if (!filas.length) {
    return { ok: false, motivo: MOTIVOS_EVENTO.ORDEN_NO_ENCONTRADA, detalle: `Sin resultados para ${where}.`, ...vacio };
  }

  const orden = normalizarOrden(filas[0]);

  // Validacion de estado logistico si fue configurado (ej: 'VERIFICADA' o avanzada a 'ENVIADA.....')
  const estadoLog = String(orden.estadoLogistico || '').trim().toUpperCase();
  const filtroLog = String(filtroEstadoLogistico || '').trim().toUpperCase();
  const esEstadoValido = !filtroEstadoLogistico || estadoLog.includes(filtroLog) || estadoLog.includes('ENVIADA') || estadoLog.includes('VERIFICADA');
  if (!esEstadoValido) {
    return {
      ok: false,
      motivo: MOTIVOS_EVENTO.ORDEN_NO_VERIFICADA,
      detalle: `El status logistico actual es '${orden.estadoLogistico || 'VACIO'}'. Se requiere '${filtroEstadoLogistico}'.`,
      orden,
      resultado: null
    };
  }

  // Validacion de corte de fecha estricto (no procesa ordenes anteriores a la fecha corte).
  // 'HOY' se resuelve a la fecha del dia operativo: comparar contra el literal 'HOY'
  // daba verdadero siempre y bloqueaba todas las ordenes del dia.
  const fechaCorte = resolverFechaCorte(fechaMinima);
  if (fechaCorte && orden.fecha && String(orden.fecha).slice(0, 10) < fechaCorte) {
    return {
      ok: false,
      motivo: MOTIVOS_EVENTO.ORDEN_ANTERIOR_A_FECHA_CORTE,
      detalle: `La orden fue creada el ${orden.fecha}, anterior a la fecha de corte permitida (${fechaMinima}).`,
      orden,
      resultado: null
    };
  }

  // 2) Contacto destino en GHL: del evento, o por telefono. Ademas se resuelve la
  // SEDE real (cf_3451 o cf_3127 de la orden) para el monitor por sede.
  let contactId = evento.ghlContactId || '';
  let detalleContacto = null;
  let sedeEfectiva = sede || orden.sede;

  const vTigerContactId = evento.vTigerContactId || String(filas[0].contact_id || '').trim();

  if (vTigerContactId) {
    try {
      const c = await clienteVtiger.consultar(`SELECT id, phone, mobile, cf_3451 FROM Contacts WHERE id = '${escaparValor(vTigerContactId)}' LIMIT 1`);
      const cc = c[0] || {};
      if (String(cc.cf_3451 || '').trim()) sedeEfectiva = String(cc.cf_3451).trim();
      if (!evento.telefono && !contactId) {
        evento.telefono = String(orden.telefono || cc.phone || cc.mobile || '').trim();
      }
    } catch (e) {
      detalleContacto = `No se pudo leer el contacto en vTiger: ${e.message}`;
      if (!evento.telefono && orden.telefono) evento.telefono = orden.telefono;
    }
  } else if (!evento.telefono && orden.telefono) {
    evento.telefono = orden.telefono;
  }

  if (!contactId) {
    const telefono = evento.telefono;
    if (telefono && buscarContactoGhl) contactId = (await buscarContactoGhl(telefono)) || '';
    if (!contactId) {
      return {
        ok: false,
        motivo: MOTIVOS_EVENTO.CONTACTO_NO_ENCONTRADO,
        detalle: detalleContacto || (telefono ? `Sin contacto en GHL para ${telefono}.` : 'Sin telefono ni contactId en el evento.'),
        orden,
        resultado: null
      };
    }
  }

  // 3) Publicacion de ESA factura (con la sede real del contacto).
  const resultado = await publicar({ contactId, orden, sede: sedeEfectiva, habilitado });

  recordAuditEvent({
    type: resultado?.publicado ? 'INVOICE_EVENTO_PUBLICADO' : 'INVOICE_EVENTO_OMITIDO',
    severity: resultado?.publicado ? 'info' : 'warn',
    sede,
    vTigerId: orden.id,
    message: `Evento de compra ${orden.numeroOrden}: ${resultado?.motivo}`
  });

  return {
    ok: Boolean(resultado?.publicado),
    motivo: resultado?.motivo || 'SIN_RESULTADO',
    detalle: resultado?.detalle || null,
    resultado,
    orden
  };
}
