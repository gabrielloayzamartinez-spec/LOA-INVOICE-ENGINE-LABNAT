/**
 * ==============================================================================
 * LOA INVOICE ENGINE - CONFIGURACION Y ASIGNACION POR SEDE
 * ==============================================================================
 * Centraliza la asignacion de sedes y sus lineas telefonicas oficiales de atencion
 * al cliente (Customer Service).
 * ==============================================================================
 */

export const SEDES_ATENCION = {
  PALACIOS: {
    clave: 'PALACIOS',
    nombre: 'Palacios',
    telefono: '888-297-4325',
    telefonoRaw: '8882974325'
  },
  BENAVIDES: {
    clave: 'BENAVIDES',
    nombre: 'Benavides',
    telefono: '888-720-0078',
    telefonoRaw: '8887200078'
  },
  ROOSEVELT: {
    clave: 'ROOSEVELT',
    nombre: 'Roosevelt',
    telefono: '888-513-0310',
    telefonoRaw: '8885130310'
  },
  PIURA: {
    clave: 'PIURA',
    nombre: 'Piura',
    telefono: '661-242-5576',
    telefonoRaw: '6612425576'
  }
};

/**
 * Normaliza cualquier variante de texto al identificador canonico de la sede.
 */
export function normalizarSede(sede = '') {
  const s = String(sede || '').trim().toUpperCase();
  if (s.includes('PALACIOS')) return 'PALACIOS';
  if (s.includes('BENAVIDES')) return 'BENAVIDES';
  if (s.includes('ROOSEVELT')) return 'ROOSEVELT';
  if (s.includes('PIURA')) return 'PIURA';
  return s || 'PALACIOS';
}

/**
 * Retorna la configuracion de atencion al cliente para una sede.
 * Por defecto usa PALACIOS como fallback fail-safe.
 */
export function obtenerAtencionSede(sede = '') {
  const canonica = normalizarSede(sede);
  return SEDES_ATENCION[canonica] || SEDES_ATENCION.PALACIOS;
}
