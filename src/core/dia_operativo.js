/**
 * ==============================================================================
 * LOA INVOICE ENGINE - GESTOR DE DÍA OPERATIVO Y CALENDARIO
 * ==============================================================================
 * Centraliza la lógica de "Tiempo Presente" y entendimiento de calendario para
 * que el motor trabaje estrictamente sobre la fecha operativa en curso:
 *   - Límite exacto: 12:00:00 AM (00:00:00) a 11:59:59 PM (23:59:59).
 *   - Manejo de zona horaria comercial (por defecto: America/New_York / Lima).
 *   - Detección de cambio de día a la medianoche (rollover automático).
 *   - Generación de cláusulas SQL para vTiger (SalesOrder).
 *   - Filtros de validación para evitar procesar compras de fechas anteriores.
 * ==============================================================================
 */

export const ZONA_HORARIA_DEFECTO = 'America/New_York';

export const DIAS_SEMANA = [
  'Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'
];

export const MESES_ANIO = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Obtiene la fecha YYYY-MM-DD en una zona horaria dada.
 */
export function formatearFechaIsoLocal(fecha = new Date(), zonaHoraria = ZONA_HORARIA_DEFECTO) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(fecha); // 'YYYY-MM-DD'
  } catch {
    return fecha.toISOString().slice(0, 10);
  }
}

/**
 * Construye el objeto completo de entendimiento de calendario para el Día Operativo.
 *
 * @param {Date|string|null} [referencia] Fecha base o timestamp. Por defecto ahora.
 * @param {string}           [zonaHoraria] Zona horaria a considerar.
 * @returns {object} Objeto con todos los metadatos del Día Operativo.
 */
export function obtenerDiaOperativo(referencia = null, zonaHoraria = ZONA_HORARIA_DEFECTO) {
  let fechaIso;
  if (typeof referencia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(referencia.trim())) {
    fechaIso = referencia.trim();
  } else {
    const d = referencia ? new Date(referencia) : new Date();
    fechaIso = formatearFechaIsoLocal(d, zonaHoraria);
  }

  const [anioStr, mesStr, diaStr] = fechaIso.split('-');
  const anio = parseInt(anioStr, 10);
  const mes = parseInt(mesStr, 10);
  const dia = parseInt(diaStr, 10);

  // Fecha a mediodia local para calcular dia de semana sin desfase
  const fechaMediodia = new Date(`${fechaIso}T12:00:00Z`);
  const indiceSemana = fechaMediodia.getUTCDay();
  const diaSemana = DIAS_SEMANA[indiceSemana] || 'Desconocido';
  const nombreMes = MESES_ANIO[mes - 1] || '';

  const inicioDia = `${fechaIso} 00:00:00`;
  const finDia = `${fechaIso} 23:59:59`;
  const esFinDeSemana = indiceSemana === 0 || indiceSemana === 6;

  return {
    fecha: fechaIso,              // '2026-10-23'
    anio,                         // 2026
    mes,                          // 10
    dia,                          // 23
    nombreMes,                    // 'Octubre'
    diaSemana,                    // 'Viernes'
    indiceDiaSemana: indiceSemana,// 5
    esFinDeSemana,                // false
    inicioDia,                    // '2026-10-23 00:00:00'
    finDia,                       // '2026-10-23 23:59:59'
    zonaHoraria,
    descripcion: `${diaSemana} ${dia} de ${nombreMes} de ${anio}`,
    rangoHorarioTexto: `Desde 12:00:00 AM (${inicioDia}) hasta 11:59:59 PM (${finDia})`
  };
}

/**
 * Valida si un timestamp de vTiger (ej: createdtime '2026-10-23 11:20:15')
 * pertenece estrictamente al Día Operativo indicado.
 *
 * @param {string|Date} timestampOFecha Timestamp de la compra en vTiger.
 * @param {object|string} [diaOperativoOFecha] Dia operativo de referencia (por defecto HOY).
 * @returns {boolean}
 */
export function perteneceAlDiaOperativo(timestampOFecha = '', diaOperativoOFecha = null) {
  if (!timestampOFecha) return false;

  const diaEsperado = typeof diaOperativoOFecha === 'object' && diaOperativoOFecha?.fecha
    ? diaOperativoOFecha.fecha
    : (typeof diaOperativoOFecha === 'string' && diaOperativoOFecha.length === 10
        ? diaOperativoOFecha
        : obtenerDiaOperativo().fecha);

  const timestampStr = String(timestampOFecha).trim();
  const fechaCompra = timestampStr.slice(0, 10);

  return fechaCompra === diaEsperado;
}

/**
 * Genera la cláusula SQL de vTiger para filtrar solo el Día Operativo.
 *
 * @param {object|string} [diaOperativo] Objeto devuelto por obtenerDiaOperativo() o YYYY-MM-DD.
 * @param {string}        [columna] Nombre de la columna en vTiger ('createdtime').
 * @returns {string} Ejemplo: "createdtime >= '2026-10-23 00:00:00' AND createdtime <= '2026-10-23 23:59:59'"
 */
export function clausulaSqlDiaOperativo(diaOperativo = null, columna = 'createdtime') {
  const op = typeof diaOperativo === 'object' && diaOperativo?.inicioDia
    ? diaOperativo
    : obtenerDiaOperativo(diaOperativo);

  return `${columna} >= '${op.inicioDia}' AND ${columna} <= '${op.finDia}'`;
}

/**
 * Resuelve el valor de INVOICE_FECHA_MINIMA a una fecha YYYY-MM-DD comparable.
 *   'HOY' / 'TODAY' -> fecha del día operativo en curso
 *   ''              -> null (sin corte)
 *   'YYYY-MM-DD'    -> se devuelve tal cual
 *
 * Sin esta resolución, comparar `orden.fecha < 'HOY'` da verdadero siempre
 * (lexicográficamente '2' < 'H') y bloquea TODAS las órdenes del día.
 */
export function resolverFechaCorte(fechaMinima = '') {
  const crudo = String(fechaMinima || '').trim();
  if (!crudo) return null;
  if (['HOY', 'TODAY'].includes(crudo.toUpperCase())) return obtenerDiaOperativo().fecha;
  return crudo;
}

/**
 * Detecta si ha ocurrido un cambio de día calendario entre dos verificaciones.
 *
 * @param {string} fechaAnterior Fecha YYYY-MM-DD previa.
 * @param {string} [zonaHoraria]
 * @returns {{ cambio: boolean, fechaAnterior: string, fechaActual: string, nuevoDia: object }}
 */
export function verificarCambioDia(fechaAnterior = '', zonaHoraria = ZONA_HORARIA_DEFECTO) {
  const actual = obtenerDiaOperativo(null, zonaHoraria);
  if (!fechaAnterior) {
    return { cambio: false, fechaAnterior: actual.fecha, fechaActual: actual.fecha, nuevoDia: actual };
  }

  const huboCambio = String(fechaAnterior).trim() !== actual.fecha;
  return {
    cambio: huboCambio,
    fechaAnterior,
    fechaActual: actual.fecha,
    nuevoDia: actual
  };
}
