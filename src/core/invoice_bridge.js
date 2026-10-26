/**
 * ==============================================================================
 * LOA INVOICE ENGINE - PUENTE DE FACTURA PDF (CONTRATO E IDEMPOTENCIA)
 * ==============================================================================
 * Traduce "hay una compra nueva con PDF disponible" al CONTRATO DE DATOS que la
 * Cuenta Empresa de GHL entiende, y decide con IDEMPOTENCIA ESTRICTA si
 * corresponde publicar.
 *
 * POR QUE ES UN MODULO APARTE: un error de idempotencia no se queda en un
 * contacto; dispara el workflow y manda un WhatsApp/SMS REAL al cliente. Por eso
 * la decision vive en funciones PURAS, probables sin red.
 *
 * CONTRATO PUBLICADO (el workflow de GHL se dispara con esto):
 *   Campo  `URL Factura PDF`  -> URL publica del PDF en la Media Library.
 *   Campo  `Factura Nº Orden` -> numero de orden ya publicada (IDEMPOTENCIA).
 *   Tag    `FACTURA_LISTA`    -> disparador del workflow de envio.
 *   Tag    `FACTURA_ENVIADA`  -> cierre: impide reenvios.
 * ==============================================================================
 */

import { obtenerAtencionSede } from './sedes.js';
import { perteneceAlDiaOperativo, obtenerDiaOperativo, resolverFechaCorte } from './dia_operativo.js';

/** Tag que dispara el workflow de envio. */
export const TAG_FACTURA_LISTA = 'FACTURA_LISTA';

/** Tag de cierre: la factura ya viajo al cliente. */
export const TAG_FACTURA_ENVIADA = 'FACTURA_ENVIADA';

/** Claves logicas de los campos puente. */
export const CLAVES_PUENTE_FACTURA = {
  urlFacturaPdf: 'urlFacturaPdf',
  facturaNumeroOrden: 'facturaNumeroOrden',
  sedeAsignada: 'sedeAsignada',
  vtigerSede: 'vtigerSede'
};

/** Motivos de la decision de publicacion. */
export const MOTIVOS_PUBLICACION = {
  COMPRA_NUEVA: 'COMPRA_NUEVA',
  YA_PUBLICADA: 'YA_PUBLICADA',
  ORDEN_SIN_NUMERO: 'ORDEN_SIN_NUMERO',
  ORDEN_SIN_ID: 'ORDEN_SIN_ID',
  ORDEN_NO_VERIFICADA: 'ORDEN_NO_VERIFICADA',
  ORDEN_TOTAL_INVALIDO: 'ORDEN_TOTAL_INVALIDO',
  ORDEN_MONTO_NO_COMERCIAL: 'ORDEN_MONTO_NO_COMERCIAL',
  ORDEN_ASUNTO_NO_FACTURABLE: 'ORDEN_ASUNTO_NO_FACTURABLE',
  ORDEN_ANTERIOR_A_FECHA_CORTE: 'ORDEN_ANTERIOR_A_FECHA_CORTE',
  ORDEN_FUERA_DE_DIA_OPERATIVO: 'ORDEN_FUERA_DE_DIA_OPERATIVO',
  SIN_PDF: 'SIN_PDF'
};

/** Nombre de archivo seguro para el PDF publicado. */
export function nombreArchivoFactura(numeroOrden = '') {
  const limpio = String(numeroOrden)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `factura_${limpio || 'sin-numero'}.pdf`;
}

/**
 * Decide si corresponde publicar la factura de una orden.
 *
 * REGLA DE ORO: el campo `Factura Nº Orden` del contacto es la UNICA fuente de
 * verdad. Si ya contiene el numero evaluado, NO se republica aunque el ciclo se
 * repita cien veces. Una recompra (numero distinto) SI se publica.
 *
 * @param {object}  orden                     Orden normalizada (id, numeroOrden...).
 * @param {object}  estadoActual              Estado puente leido del contacto en GHL.
 * @param {string}  urlPdf                    URL publica ya obtenida para esa orden.
 * @param {boolean} requerirPdf               `false` permite el CORTE TEMPRANO (decidir antes
 *                                            de descargar el PDF). La validacion previa a
 *                                            escribir en GHL siempre usa `true`.
 * @param {string}  [estadoLogisticoRequerido] Status logistico requerido (ej: 'VERIFICADA').
 * @param {string}  [fechaMinima]             Fecha minima permitida (ej: '2026-10-21').
 * @param {number}  [montoMinimo]             Monto minimo facturable (ej: 1.00 para omitir <= $1.00).
 * @param {string[]} [asuntosPermitidos]      Asuntos autorizados (ej: ['VENTA']).
 * @param {boolean}  [soloDiaOperativo]       Exige que la orden pertenezca estrictamente al Día Operativo en curso.
 * @param {object|string} [diaOperativo]      Objeto devuelto por obtenerDiaOperativo() o fecha YYYY-MM-DD.
 */
export function decidirPublicacion({
  orden = {},
  estadoActual = {},
  urlPdf = '',
  requerirPdf = true,
  estadoLogisticoRequerido = null,
  fechaMinima = null,
  montoMinimo = null,
  asuntosPermitidos = null,
  soloDiaOperativo = false,
  diaOperativo = null
} = {}) {
  const numeroOrden = String(orden.numeroOrden || '').trim();
  if (!numeroOrden) return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_SIN_NUMERO };
  if (!String(orden.id || '').trim()) return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_SIN_ID };

  // CANDADO 1: Status Logistico (acepta VERIFICADA y avance logistico ENVIADA.....)
  if (estadoLogisticoRequerido && orden.estadoLogistico) {
    const ordenLog = String(orden.estadoLogistico).trim().toUpperCase();
    const reqLog = String(estadoLogisticoRequerido).trim().toUpperCase();
    const esValido = ordenLog === reqLog || ordenLog.includes(reqLog) || ordenLog.includes('ENVIADA') || ordenLog.includes('VERIFICADA');
    if (!esValido) {
      return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_NO_VERIFICADA };
    }
  }

  // CANDADO 2: Total debe ser mayor a 0 (evita facturar ordenes canceladas en $0.00)
  if (orden.total !== undefined && orden.total !== null && String(orden.total).trim() !== '') {
    const totalNum = parseFloat(String(orden.total).replace(/[^0-9.-]/g, ''));
    if (isNaN(totalNum) || totalNum <= 0) {
      return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_TOTAL_INVALIDO };
    }
  }

  // CANDADO 2B: Umbral Comercial Minimo (excluye ordenes <= $1.00 de Customer Service / preautorizaciones)
  if (montoMinimo !== null && montoMinimo !== undefined && orden.total !== undefined && orden.total !== null && String(orden.total).trim() !== '') {
    const totalNum = parseFloat(String(orden.total).replace(/[^0-9.-]/g, ''));
    if (!isNaN(totalNum) && totalNum <= montoMinimo) {
      return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_MONTO_NO_COMERCIAL };
    }
  }

  // CANDADO 2C: Asunto Comercial (solo asuntos permitidos, ej: SOLO 'VENTA', omite CUSTOMER, MUESTRA GRATIS, etc.)
  if (asuntosPermitidos && Array.isArray(asuntosPermitidos) && asuntosPermitidos.length && orden.asunto) {
    const asuntoLimpio = String(orden.asunto).trim().toUpperCase();
    const permitidos = asuntosPermitidos.map(a => String(a).trim().toUpperCase());
    if (!permitidos.includes(asuntoLimpio)) {
      return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_ASUNTO_NO_FACTURABLE };
    }
  }

  // CANDADO 3: Corte de Fecha (no procesar ordenes historicas hacia atras)
  const fechaCorteEfectiva = resolverFechaCorte(fechaMinima);

  if (fechaCorteEfectiva && orden.fecha && orden.fecha < fechaCorteEfectiva) {
    return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_ANTERIOR_A_FECHA_CORTE };
  }

  // CANDADO 3B: Día Operativo Estricto (tiempo presente 00:00:00 - 23:59:59)
  if (soloDiaOperativo) {
    const fechaHoraCompra = orden.createdtime || orden.fecha;
    if (!perteneceAlDiaOperativo(fechaHoraCompra, diaOperativo)) {
      return { publicar: false, motivo: MOTIVOS_PUBLICACION.ORDEN_FUERA_DE_DIA_OPERATIVO };
    }
  }

  if (requerirPdf && !String(urlPdf || '').trim()) return { publicar: false, motivo: MOTIVOS_PUBLICACION.SIN_PDF };

  const yaPublicada = String(estadoActual.facturaNumeroOrden || '').trim();
  if (yaPublicada && yaPublicada === numeroOrden) {
    return { publicar: false, motivo: MOTIVOS_PUBLICACION.YA_PUBLICADA };
  }

  return { publicar: true, motivo: MOTIVOS_PUBLICACION.COMPRA_NUEVA };
}

/**
 * Construye el payload de campos + tags para la Cuenta Empresa.
 * Solo incluye los campos cuyos IDs fueron resueltos (fail-safe).
 */
export function construirPuenteFactura({ urlPdf = '', numeroOrden = '', sede = '', fieldIds = {} } = {}) {
  const url = String(urlPdf).trim();
  const numero = String(numeroOrden).trim();

  if (!url || !numero) {
    throw new TypeError('construirPuenteFactura requiere urlPdf y numeroOrden no vacios.');
  }

  const customFields = [];
  if (fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf]) {
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf], field_value: url });
  }
  if (fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden]) {
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden], field_value: numero });
  }
  if (sede && fieldIds[CLAVES_PUENTE_FACTURA.sedeAsignada]) {
    const atencion = obtenerAtencionSede(sede);
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.sedeAsignada], field_value: atencion.nombre });
  }
  if (sede && fieldIds[CLAVES_PUENTE_FACTURA.vtigerSede]) {
    const atencion = obtenerAtencionSede(sede);
    customFields.push({ id: fieldIds[CLAVES_PUENTE_FACTURA.vtigerSede], field_value: atencion.nombre.toUpperCase() });
  }

  const tags = [TAG_FACTURA_LISTA];
  if (sede) {
    const atencion = obtenerAtencionSede(sede);
    tags.push(`SEDE_${atencion.clave}`);
  }

  return { customFields, tags };
}

/** Tags de cierre, una vez que el mensaje salio. */
export function construirCierreEnvio() {
  return { agregar: [TAG_FACTURA_ENVIADA], quitar: [TAG_FACTURA_LISTA] };
}

/**
 * Lee el estado puente actual de un contacto de GHL.
 * Tolera `value`/`field_value`, busqueda por `id` o `key`, y contacto nulo.
 */
export function leerEstadoPuenteFactura(contactoGhl = {}, fieldIds = {}) {
  const contacto = contactoGhl || {};
  const campos = Array.isArray(contacto.customFields) ? contacto.customFields : [];

  const valorDe = (id = '', key = '') => {
    const encontrado = campos.find(c => (id && (c.id === id || c.key === id)) || (key && c.key === key));
    if (!encontrado) return '';
    return String(encontrado.value ?? encontrado.field_value ?? '').trim();
  };

  return {
    urlFacturaPdf: valorDe(fieldIds[CLAVES_PUENTE_FACTURA.urlFacturaPdf], 'contact.url_factura_pdf'),
    facturaNumeroOrden: valorDe(fieldIds[CLAVES_PUENTE_FACTURA.facturaNumeroOrden], 'contact.factura_numero_orden'),
    tags: Array.isArray(contacto.tags) ? [...contacto.tags] : []
  };
}
