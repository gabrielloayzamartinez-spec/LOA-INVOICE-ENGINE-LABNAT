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
  'id', 'salesorder_no', 'createdtime', 'hdnGrandTotal', 'sostatus',
  'cf_1069', 'cf_3156', 'cf_3298', 'quantity',
  'cf_870', 'cf_872', 'cf_876', 'cf_1053'
];

/** Campos del comprador. `phone`/`mobile` pueden estar restringidos: hay respaldo. */
export const COMPRADOR_SELECT = ['id', 'spl_num_compras', 'spl_fecha_ultima_compra', 'cf_994', 'phone', 'mobile'];
export const COMPRADOR_SELECT_MINIMO = ['id', 'spl_num_compras', 'spl_fecha_ultima_compra', 'cf_994'];

/** Normaliza una orden cruda de vTiger al contrato interno. */
export function normalizarOrden(o = {}) {
  return {
    id: String(o.id || '').trim(),
    numeroOrden: String(o.salesorder_no || '').trim(),
    fecha: String(o.createdtime || '').slice(0, 10),
    total: String(o.hdnGrandTotal ?? '').trim(),
    estado: String(o.sostatus || '').trim(),
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

  const sedeLimpia = String(sede).toUpperCase();
  const fechaCorte = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // `cf_994` es la marca que deja el personal cuando la compra queda EFECTUADA
  // (valor real verificado en la instancia: "VENDIDO"). Si se pasa vacio, no se
  // filtra por estado (util para diagnosticos).
  const filtroEstado = String(estadoCompra || '').trim()
    ? ` AND cf_994 = '${escaparValor(String(estadoCompra).trim())}'`
    : '';

  const base = `FROM Contacts WHERE cf_3451 = '${escaparValor(sedeLimpia)}' AND spl_num_compras > 0 AND spl_fecha_ultima_compra >= '${fechaCorte}'${filtroEstado}`;
  const conContacto = `SELECT ${COMPRADOR_SELECT.join(', ')} ${base} ORDER BY spl_fecha_ultima_compra DESC LIMIT ${lote}`;
  const sinContacto = `SELECT ${COMPRADOR_SELECT_MINIMO.join(', ')} ${base} ORDER BY spl_fecha_ultima_compra DESC LIMIT ${lote}`;

  let compradores = [];
  try {
    compradores = await clienteVtiger.consultar(conContacto);
  } catch {
    // Los campos de telefono pueden estar restringidos para el rol: se reintenta.
    compradores = await clienteVtiger.consultar(sinContacto);
  }

  const resultado = { sede: sedeLimpia, fechaCorte, estadoCompra: String(estadoCompra || '').trim() || null, revisados: compradores.length, candidatos: [], omitidos: [], errores: [] };

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

    const telefono = String(c.phone || c.mobile || '').trim();
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

    resultado.candidatos.push({ vTigerId, telefono, contactId, orden, clave });
  }

  return resultado;
}

/**
 * Ciclo completo: detecta y publica. Actualiza el cursor solo cuando la factura
 * quedo publicada (o ya lo estaba): un fallo se reintenta en el proximo ciclo.
 *
 * @param {object}   args
 * @param {Function} args.publicar  (candidato) => resultado del caso de uso.
 */
export async function ejecutarCiclo({
  clienteVtiger,
  publicar,
  cursor = { procesadas: {}, ultimaCorrida: null },
  ...opciones
} = {}) {
  if (typeof publicar !== 'function') throw new TypeError('ejecutarCiclo requiere una funcion publicar(candidato).');

  const deteccion = await detectarComprasNuevas({ clienteVtiger, cursor, ...opciones });
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
