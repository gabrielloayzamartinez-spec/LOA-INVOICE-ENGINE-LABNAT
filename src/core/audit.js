/**
 * ==============================================================================
 * LOA INVOICE ENGINE - AUDITORIA (JSONL, SIN DEPENDENCIAS)
 * ==============================================================================
 * Cada evento relevante del flujo se escribe como una linea JSON, de modo que
 * cualquier incidencia (PDF que no baja, token invalido, contacto ilegible)
 * pueda reconstruirse despues sin adivinar.
 *
 * La auditoria NUNCA lanza: si no se puede escribir el archivo, el evento igual
 * sale por consola y el flujo continua.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';

let dirActual = process.env.INVOICE_LOG_DIR || 'data/logs';

/** Permite que el motor fije el directorio de logs desde su configuracion. */
export function configurarAuditoria({ dir } = {}) {
  if (dir) dirActual = dir;
}

function rutaArchivo() {
  return path.join(dirActual, 'audit.jsonl');
}

/** Registra un evento de auditoria (append-only JSONL). */
export function recordAuditEvent(evento = {}) {
  const registro = { ts: new Date().toISOString(), ...evento };
  const linea = JSON.stringify(registro);

  // Consola: siempre. Es la señal de vida del motor.
  if (registro.severity === 'critical' || registro.severity === 'error') console.error(`[AUDIT] ${linea}`);
  else console.log(`[AUDIT] ${linea}`);

  try {
    fs.mkdirSync(dirActual, { recursive: true });
    fs.appendFileSync(rutaArchivo(), `${linea}\n`, 'utf8');
  } catch {
    /* la auditoria no puede tumbar el flujo */
  }

  return registro;
}

/** Lee los ultimos N eventos (diagnostico). */
export function leerAuditoria(limite = 50) {
  try {
    const lineas = fs.readFileSync(rutaArchivo(), 'utf8').split('\n').filter(Boolean);
    return lineas.slice(-limite).map(l => { try { return JSON.parse(l); } catch { return { crudo: l }; } });
  } catch {
    return [];
  }
}
