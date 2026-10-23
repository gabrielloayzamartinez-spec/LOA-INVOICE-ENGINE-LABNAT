/**
 * ==============================================================================
 * LOA INVOICE ENGINE - DETECCION DE COMPRAS NUEVAS (vTiger -> candidatos GHL)
 * ==============================================================================
 * Encuentra los contactos con compra RECIENTE y su ultima orden, resuelve a que
 * contacto de GHL pertenecen y devuelve los candidatos a publicar.
 *
 * CONSULTAS VALIDADAS CONTRA VTIGER REAL (no son suposiciones):
 *   - `ORDER BY spl_fecha_ultima_compra DESC`           -> SOPORTADO
 *   - `spl_fecha_ultima_compra >= '<YYYY-MM-DD>'`       -> SOPORTADO
 *   - `ORDER BY createdtime DESC` en SalesOrder         -> SOPORTADO
 *   - El campo `total` de SalesOrder esta DENEGADO por permisos -> se usa
 *     `hdnGrandTotal` (verificado).
 *
 * IDEMPOTENCIA EN DOS NIVELES:
 *   1. Cursor local (`data/cursor.json`): evita reprocesar lo ya publicado.
 *   2. Campo `Factura Nº Orden` en el contacto de GHL: fuente de verdad final,
 *      verificada por el caso de uso antes de descargar nada.
 *
 * El cursor solo marca una orden cuando se PUBLICO o cuando ya estaba publicada.
 * Si fallo el PDF o la subida, NO se marca: el proximo ciclo lo reintenta.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { escaparValor } from '../connectors/vtiger_webservice.js';

/** Campos de la ultima orden (todos verificados contra la instancia real). */
export const ORDEN_SELECT = [
  'id', 'salesorder_no', 'subject', 'contact_id', 'createdtime', 'modifiedtime',
  'hdnGrandTotal', 'sostatus', 'cf_882', 'cf_1006', 'cf_856', 'cf_858',
  'cf_3127', 'cf_1069', 'cf_3156', 'quantity',
  'cf_870', 'cf_872', 'cf_876', 'cf_1053'
];

/** Campos del comprador. `phone`/`mobile`/`homephone` pueden estar restringidos: hay respaldo. */
export const COMPRADOR_SELECT = ['id', 'spl_num_compras', 'spl_fecha_ultima_compra', 'cf_994', 'phone', 'mobile', 'homephone', 'otherphone', 'cf_3451'];
export const COMPRADOR_SELECT_MINIMO = ['id', 'spl_num_compras', 'spl_fecha_ultima_compra', 'cf_994', 'cf_3451'];

/** Normaliza una orden cruda de vTiger al contrato interno. */
export function normalizarOrden(o = {}) {
  return {
    id: String(o.id || '').trim(),
    numeroOrden: String(o.salesorder_no || '').trim(),
    asunto: String(o.subject || '').trim().toUpperCase(),
    fecha: String(o.createdtime || '').slice(0, 10),
    createdtime: String(o.createdtime || '').trim(),
    modifiedtime: String(o.modifiedtime || '').trim(),
    total: String(o.hdnGrandTotal ?? '').trim(),
    estado: String(o.sostatus || '').trim(),
    estadoLogistico: String(o.cf_882 || '').trim(),
    telefono: String(o.cf_1006 || '').trim(),
    nombreCliente: String(o.cf_856 || '').trim(),
    apellidoCliente: String(o.cf_858 || '').trim(),
    sede: String(o.cf_3127 || '').trim(),
    contactIdVtiger: String(o.contact_id || '').trim(),
    tratamiento: String(o.cf_1069 || '').trim(),
    producto: String(o.cf_3156 || '').trim(),
    cantidad: String(o.cf_3298 ?? o.quantity ?? '').trim(),
    // Direccion de envio de ESTA compra: permitida en la orden, denegada en el
    // contacto por el rol de API (verificado contra la instancia real).
    direccion: String(o.cf_870 || '').trim(),
    zip: String(o.cf_872 || '').trim(),
    ciudad: String(o.cf_876 || '').trim(),
    estadoEnvio: String(o.cf_1053 || '').trim()
  };
}

/** Clave unica de una orden para el cursor (record + numero de orden). */
export function claveCursor(orden = {}) {
  return `${String(orden.id || '').trim()}|${String(orden.numeroOrden || '').trim()}`;
}

// ------------------------------------------------------------------------------
// CURSOR PERSISTIDO
// ------------------------------------------------------------------------------

/** Carga el cursor. Si no existe o esta corrupto, devuelve uno vacio. */
export function cargarCursor(ruta = 'data/cursor.json') {
  try {
    const crudo = fs.readFileSync(ruta, 'utf8');
    const data = JSON.parse(crudo);
    return {
      procesadas: data?.procesadas && typeof data.procesadas === 'object' ? data.procesadas : {},
      ultimaCorrida: data?.ultimaCorrida || null
    };
  } catch {
    return { procesadas: {}, ultimaCorrida: null };
  }
}

/** Guarda el cursor de forma atomica (escribe tmp y renombra). */
export function guardarCursor(ruta = 'data/cursor.json', cursor = {}) {
  const destino = path.resolve(ruta);
  const contenido = JSON.stringify({ ...cursor, guardadoEn: new Date().toISOString() }, null, 2);
  try {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const temporal = `${destino}.tmp`;
    fs.writeFileSync(temporal, contenido, 'utf8');
    fs.renameSync(temporal, destino);
    return { ok: true, ruta: destino };
  } catch (e) {
    return { ok: false, ruta: destino, error: e.message };
  }
}

/** Poda el cursor para que no crezca sin limite (conserva lo mas reciente). */
export function podarCursor(cursor = {}, { maxEntradas = 5000 } = {}) {
  const entradas = Object.entries(cursor.procesadas || {});
  if (entradas.length <= maxEntradas) return cursor;
  const recientes = entradas.sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, maxEntradas);
  return { ...cursor, procesadas: Object.fromEntries(recientes) };
}

// ------------------------------------------------------------------------------
// DETECCION
// ------------------------------------------------------------------------------

/**
 * Detecta compras recientes y sus candidatos a publicacion.
 *
 * @param {object}   args
 * @param {object}   args.clienteVtiger     Cliente de la Webservice API (`consultar`).
 * @param {string}   [args.sede]            Sede a escanear (PALACIOS, BENAVIDES...).
 * @param {number}   [args.dias]            Ventana de antiguedad de la ultima compra.
 * @param {number}   [args.lote]            Maximo de compradores por ciclo.
 * @param {object}   [args.cursor]          Cursor cargado.
 * @param {Function} [args.buscarContactoGhl] (telefono) => contactId | null.
 * @param {Date}     [args.ahora]           Inyectable para pruebas.
 */
export async function detectarComprasNuevas({
  clienteVtiger,
  sede = 'PALACIOS',
  dias = 7,
  lote = 25,
  cursor = { procesadas: {} },
  buscarContactoGhl = null,
  ahora = new Date(),
  estadoCompra = 'VENDIDO'
} = {}) {
  if (!clienteVtiger || typeof clienteVtiger.consultar !== 'function') {
    throw new TypeError('detectarComprasNuevas requiere un clienteVtiger con .consultar(sql).');
  }

  const sedeLimpia = String(sede || '').toUpperCase().trim();
  const esGeneral = !sedeLimpia || sedeLimpia === 'TODAS' || sedeLimpia === 'GENERAL' || sedeLimpia === 'ALL';
  const fechaCorte = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // `cf_994` es la marca que deja el personal cuando la compra queda EFECTUADA
  // (valor real verificado en la instancia: "VENDIDO"). Si se pasa vacio, no se
  // filtra por estado (util para diagnosticos).
  const filtroEstado = String(estadoCompra || '').trim()
    ? ` AND cf_994 = '${escaparValor(String(estadoCompra).trim())}'`
    : '';

  const condicionSede = esGeneral
    ? ''
    : `cf_3451 = '${escaparValor(sedeLimpia)}' AND `;

  const base = `FROM Contacts WHERE ${condicionSede}spl_num_compras > 0 AND spl_fecha_ultima_compra >= '${fechaCorte}'${filtroEstado}`;
  const conContacto = `SELECT ${COMPRADOR_SELECT.join(', ')} ${base} ORDER BY spl_fecha_ultima_compra DESC LIMIT ${lote}`;
  const sinContacto = `SELECT ${COMPRADOR_SELECT_MINIMO.join(', ')} ${base} ORDER BY spl_fecha_ultima_compra DESC LIMIT ${lote}`;

  let compradores = [];
  try {
    compradores = await clienteVtiger.consultar(conContacto);
  } catch {
    // Los campos de telefono pueden estar restringidos para el rol: se reintenta.
    compradores = await clienteVtiger.consultar(sinContacto);
  }

  const resultado = { sede: esGeneral ? 'GENERAL' : sedeLimpia, fechaCorte, estadoCompra: String(estadoCompra || '').trim() || null, revisados: compradores.length, candidatos: [], omitidos: [], errores: [] };

  for (const c of compradores) {
    const vTigerId = String(c.id || '').trim();
    if (!vTigerId) continue;

    // Ultima orden del contacto.
    let ordenes = [];
    try {
      ordenes = await clienteVtiger.consultar(
        `SELECT ${ORDEN_SELECT.join(', ')} FROM SalesOrder WHERE contact_id = '${escaparValor(vTigerId)}' ORDER BY createdtime DESC LIMIT 1`
      );
    } catch (e) {
      resultado.errores.push({ vTigerId, etapa: 'orden', detalle: e.message });
      continue;
    }
    if (!ordenes.length) {
      resultado.omitidos.push({ vTigerId, motivo: 'SIN_ORDEN' });
      continue;
    }

    const orden = normalizarOrden(ordenes[0]);
    const clave = claveCursor(orden);

    if (cursor?.procesadas?.[clave]) {
      resultado.omitidos.push({ vTigerId, motivo: 'YA_PROCESADA', clave });
      continue;
    }

    const telefono = String(c.phone || c.mobile || c.homephone || c.otherphone || '').trim();
    const sedeComprador = String(c.cf_3451 || (!esGeneral ? sedeLimpia : 'GENERAL')).toUpperCase().trim();
    let contactId = null;
    if (buscarContactoGhl && telefono) {
      try {
        contactId = await buscarContactoGhl(telefono);
      } catch (e) {
        resultado.errores.push({ vTigerId, etapa: 'contacto_ghl', detalle: e.message });
        continue;
      }
    }

    if (!contactId) {
      resultado.omitidos.push({ vTigerId, motivo: telefono ? 'SIN_CONTACTO_GHL' : 'SIN_TELEFONO', clave });
      continue;
    }

    resultado.candidatos.push({ vTigerId, telefono, contactId, orden, clave, sede: sedeComprador });
  }

  return resultado;
}
 
/**
 * Detecta ordenes de venta que tienen el status logistico requerido (por defecto 'VERIFICADA')
 * creadas DESDE una fecha de corte obligatoria (estricta: no procesa hacia atras).
 *
 * @param {object}   args
 * @param {object}   args.clienteVtiger        Cliente de la Webservice API (`consultar`).
 * @param {string}   [args.fechaMinima]        Fecha de corte estricta (YYYY-MM-DD). Default '2026-10-21'.
 * @param {string}   [args.sede]               Sede a escanear (PALACIOS, BENAVIDES... o TODAS).
 * @param {number}   [args.lote]               Maximo de ordenes por ciclo.
 * @param {object}   [args.cursor]             Cursor cargado.
 * @param {Function} [args.buscarContactoGhl]  (telefono) => contactId | null.
 * @param {string}   [args.estadoLogistico]    Status logistico requerido (default 'VERIFICADA').
 */
export async function detectarOrdenesVerificadas({
  clienteVtiger,
  fechaMinima = '2026-10-21',
  sede = 'TODAS',
  lote = 50,
  cursor = { procesadas: {} },
  buscarContactoGhl = null,
  estadoLogistico = 'VERIFICADA',
  montoMinimo = 1.00,
  asuntosPermitidos = ['VENTA']
} = {}) {
  if (!clienteVtiger || typeof clienteVtiger.consultar !== 'function') {
    throw new TypeError('detectarOrdenesVerificadas requiere un clienteVtiger con .consultar(sql).');
  }

  const sedeLimpia = String(sede || '').toUpperCase().trim();
  const esGeneral = !sedeLimpia || sedeLimpia === 'TODAS' || sedeLimpia === 'GENERAL' || sedeLimpia === 'ALL';
  const fechaCorteLimpia = String(fechaMinima || '2026-10-21').trim();
  const estadoRequerido = String(estadoLogistico || 'VERIFICADA').trim();

  const condicionSede = esGeneral ? '' : ` AND cf_3127 = '${escaparValor(sedeLimpia)}'`;
  const sql = `SELECT ${ORDEN_SELECT.join(', ')} FROM SalesOrder WHERE cf_882 IN ('VERIFICADA', 'ENVIADA.....') AND createdtime >= '${escaparValor(fechaCorteLimpia)} 00:00:00'${condicionSede} ORDER BY createdtime ASC LIMIT ${lote}`;

  let ordenes = [];
  try {
    ordenes = await clienteVtiger.consultar(sql);
  } catch (e) {
    throw new Error(`Error consultando ordenes verificadas en vTiger: ${e.message}`);
  }

  const resultado = {
    sede: esGeneral ? 'TODAS' : sedeLimpia,
    fechaMinima: fechaCorteLimpia,
    estadoLogistico: estadoRequerido,
    asuntosPermitidos,
    revisados: ordenes.length,
    candidatos: [],
    omitidos: [],
    errores: []
  };

  for (const o of ordenes) {
    const orden = normalizarOrden(o);
    const clave = claveCursor(orden);

    if (cursor?.procesadas?.[clave]) {
      resultado.omitidos.push({ ordenId: orden.id, numeroOrden: orden.numeroOrden, motivo: 'YA_PROCESADA', clave });
      continue;
    }

    // Candado de Asunto: solo asuntos autorizados (ej: 'VENTA', omite CUSTOMER, MUESTRA GRATIS, etc.)
    if (asuntosPermitidos && Array.isArray(asuntosPermitidos) && asuntosPermitidos.length && orden.asunto) {
      const permitidos = asuntosPermitidos.map(a => String(a).trim().toUpperCase());
      if (!permitidos.includes(orden.asunto)) {
        resultado.omitidos.push({
          ordenId: orden.id,
          numeroOrden: orden.numeroOrden,
          motivo: 'ORDEN_ASUNTO_NO_FACTURABLE',
          asunto: orden.asunto,
          clave
        });
        continue;
      }
    }

    // Candado comercial: ordenes <= $1.00 (Customer Service / ajustes) no son candidatos a facturacion
    if (montoMinimo !== null && montoMinimo !== undefined && orden.total !== undefined && orden.total !== null && String(orden.total).trim() !== '') {
      const totalNum = parseFloat(String(orden.total).replace(/[^0-9.-]/g, ''));
      if (!isNaN(totalNum) && totalNum <= montoMinimo) {
        resultado.omitidos.push({
          ordenId: orden.id,
          numeroOrden: orden.numeroOrden,
          motivo: 'ORDEN_MONTO_NO_COMERCIAL',
          total: totalNum,
          clave
        });
        continue;
      }
    }

    // Resolucion de telefono: primero de la orden (cf_1006); si no viene, del contacto.
    let telefono = orden.telefono;
    if (!telefono && orden.contactIdVtiger) {
      try {
        const c = await clienteVtiger.consultar(
          `SELECT phone, mobile, homephone, otherphone FROM Contacts WHERE id = '${escaparValor(orden.contactIdVtiger)}' LIMIT 1`
        );
        if (c && c.length) {
          telefono = String(c[0].phone || c[0].mobile || c[0].homephone || c[0].otherphone || '').trim();
        }
      } catch (e) {
        resultado.errores.push({ ordenId: orden.id, etapa: 'telefono_contacto', detalle: e.message });
      }
    }

    let contactId = null;
    if (buscarContactoGhl && telefono) {
      try {
        contactId = await buscarContactoGhl(telefono);
      } catch (e) {
        resultado.errores.push({ ordenId: orden.id, etapa: 'contacto_ghl', detalle: e.message });
        continue;
      }
    }

    if (!contactId) {
      resultado.omitidos.push({
        ordenId: orden.id,
        numeroOrden: orden.numeroOrden,
        motivo: telefono ? 'SIN_CONTACTO_GHL' : 'SIN_TELEFONO',
        clave
      });
      continue;
    }

    resultado.candidatos.push({
      vTigerId: orden.id,
      telefono,
      contactId,
      orden,
      clave,
      sede: orden.sede || (esGeneral ? 'GENERAL' : sedeLimpia)
    });
  }

  return resultado;
}

/**
 * Ciclo completo: detecta y publica. Actualiza el cursor solo cuando la factura
 * quedo publicada (o ya lo estaba): un fallo se reintenta en el proximo ciclo.
 *
 * @param {object}   args
 * @param {Function} args.publicar  (candidato) => resultado del caso de uso.
 * @param {string}   [args.modoDeteccion] 'ordenes_verificadas' | 'contactos_compradores'
 */
export async function ejecutarCiclo({
  clienteVtiger,
  publicar,
  cursor = { procesadas: {}, ultimaCorrida: null },
  modoDeteccion = 'contactos_compradores',
  fechaMinima = '2026-10-21',
  estadoLogistico = 'VERIFICADA',
  montoMinimo = 1.00,
  asuntosPermitidos = ['VENTA'],
  ...opciones
} = {}) {
  if (typeof publicar !== 'function') throw new TypeError('ejecutarCiclo requiere una funcion publicar(candidato).');

  const deteccion = modoDeteccion === 'ordenes_verificadas'
    ? await detectarOrdenesVerificadas({ clienteVtiger, cursor, fechaMinima, estadoLogistico, montoMinimo, asuntosPermitidos, ...opciones })
    : await detectarComprasNuevas({ clienteVtiger, cursor, ...opciones });

  const publicaciones = [];
  let marcadas = 0;

  for (const candidato of deteccion.candidatos) {
    let resultado;
    try {
      resultado = await publicar(candidato);
    } catch (e) {
      resultado = { publicado: false, motivo: 'EXCEPCION_PUBLICACION', detalle: e.message };
    }

    if (resultado?.publicado || resultado?.motivo === 'YA_PUBLICADA') {
      cursor.procesadas[candidato.clave] = new Date().toISOString();
      marcadas++;
    }
    publicaciones.push({ ...candidato, resultado });
  }

  cursor.ultimaCorrida = new Date().toISOString();
  return { deteccion, publicaciones, marcadas };
}
