/**
 * ==============================================================================
 * LOA INVOICE ENGINE - PIPELINE DE COMPRA (TRAZA POR ETAPA PARA MEDIR Y AUDITAR)
 * ==============================================================================
 * Cada compra efectuada recorre un PIPELINE CONSECUTIVO. Este modulo registra una
 * fila (JSONL) por cada transicion y permite reconstruir, por sede, en que etapa
 * quedo cada orden. Es la base del monitor operativo.
 *
 * ETAPAS (en orden de exito):
 *   1. DETECTADA         el evento/barrido encontro la orden (compra efectuada)
 *   2. ORDEN_RESUELTA    se leyo la orden de vTiger (nº, fecha, total, direccion)
 *   3. PDF_OBTENIDO      el PDF oficial se descargo (o se genero como respaldo)
 *   4. PUBLICADO         el PDF se subio a la Media Library y hay URL publica
 *   5. MARCADO           el contacto tiene campo URL + tag FACTURA_LISTA  <- EXITO DEL MOTOR
 *   6. ENVIADO           GHL confirmo el envio (tag FACTURA_ENVIADA)     <- EXITO FINAL
 *
 * Estados de bloqueo (con motivo):
 *   OMITIDO            ya estaba publicada (idempotencia) o sin datos
 *   FALLO_DESCARGA     no se obtuvo el PDF
 *   FALLO_SUBIDA       Media Library rechazo la subida
 *   FALLO_ESCRITURA    no se pudo marcar el contacto
 *
 * POR QUE JSONL y no un JSON unico: append-only nunca se corrompe si el proceso
 * muere a mitad de una escritura, y conserva el historial completo de cada orden.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';

/** Etapas de EXITO, en orden consecutivo. */
export const ETAPAS_PIPELINE = ['DETECTADA', 'ORDEN_RESUELTA', 'PDF_OBTENIDO', 'PUBLICADO', 'MARCADO', 'ENVIADO'];

/** Estados de bloqueo (no avanzan mas). */
export const ETAPAS_FALLO = new Set(['OMITIDO', 'FALLO_DESCARGA', 'FALLO_SUBIDA', 'FALLO_ESCRITURA']);

/** Indice de cada etapa (para saber si avanzo o se atascó). */
export function indiceEtapa(estado) {
  const i = ETAPAS_PIPELINE.indexOf(estado);
  return i >= 0 ? i : null;
}

/**
 * Registra UNA transicion del pipeline (append-only JSONL).
 * Nunca lanza: si no puede escribir, el flujo de facturacion no se detiene.
 * @param {string} archivo   ruta del archivo de pipeline (data/pipeline.jsonl)
 * @param {object} evento    { orden, numeroOrden, sede, estado, motivo?, detalle? }
 */
export function registrarPipeline(archivo, evento = {}) {
  const fila = { ts: new Date().toISOString(), ...evento };
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.appendFileSync(archivo, `${JSON.stringify(fila)}\n`, 'utf8');
  } catch { /* la traza no puede tumbar el flujo */ }
  return fila;
}

/** Lee todas las filas del pipeline (tolerante a lineas corruptas). */
export function leerPipeline(archivo) {
  try {
    return fs.readFileSync(archivo, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Reduce el historial al ULTIMO estado de cada orden (una fila por compra). */
export function ultimoEstadoPorOrden(filas = []) {
  const mapa = new Map();
  for (const f of filas) {
    if (!f || !f.orden) continue;
    mapa.set(f.orden, f);
  }
  return [...mapa.values()];
}

/**
 * Agrupa las compras por sede y calcula el avance y las tasas.
 * Devuelve un objeto listo para imprimir como tabla.
 */
export function resumenPipeline(filas = []) {
  const finales = ultimoEstadoPorOrden(filas);
  const porSede = {};

  for (const f of finales) {
    const sede = String(f.sede || 'SIN_SEDE');
    const r = porSede[sede] || (porSede[sede] = {
      sede, total: 0, exitoMotor: 0, enviadas: 0, enProceso: 0, fallidas: 0, porEstado: {}
    });
    r.total++;
    r.porEstado[f.estado] = (r.porEstado[f.estado] || 0) + 1;

    if (f.estado === 'MARCADO') r.exitoMotor++;
    if (f.estado === 'ENVIADO') { r.exitoMotor++; r.enviadas++; }
    if (ETAPAS_FALLO.has(f.estado)) r.fallidas++;
    if (indiceEtapa(f.estado) !== null && f.estado !== 'MARCADO' && f.estado !== 'ENVIADO') r.enProceso++;
  }

  return porSede;
}

/** Filas "atascadas" en una etapa intermedia hace mas de `minutos` (sin cerrar). */
export function atascadas(filas = [], { minutos = 60, ahora = Date.now() } = {}) {
  const finales = ultimoEstadoPorOrden(filas);
  const limite = ahora - minutos * 60 * 1000;
  return finales.filter(f => {
    const etapa = indiceEtapa(f.estado);
    // Atascada = quedo en una etapa de avance (no final, no fallo) y ya paso el umbral.
    return etapa !== null && f.estado !== 'MARCADO' && f.estado !== 'ENVIADO'
      && new Date(f.ts).getTime() < limite;
  });
}

/** Tabla de texto legible para la consola. */
export function formatearResumen(porSede) {
  const filas = Object.values(porSede).sort((a, b) => b.total - a.total);
  const lineas = [];
  lineas.push('SEDE            TOTAL  OK-MOTOR  ENVIADAS  EN-PROCESO  FALLAS');
  lineas.push('-'.repeat(64));
  for (const r of filas) {
    lineas.push(
      `${r.sede.padEnd(15)} ${String(r.total).padStart(5)} ${String(r.exitoMotor).padStart(8)} ` +
      `${String(r.enviadas).padStart(9)} ${String(r.enProceso).padStart(10)} ${String(r.fallidas).padStart(6)}`
    );
  }
  if (!filas.length) lineas.push('(sin compras registradas todavia)');
  return lineas.join('\n');
}
