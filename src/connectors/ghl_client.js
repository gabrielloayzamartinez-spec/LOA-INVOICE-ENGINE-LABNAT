/**
 * ==============================================================================
 * LOA INVOICE ENGINE - CLIENTE HTTP DE GOHIGHLEVEL
 * ==============================================================================
 * Un unico punto de salida hacia GHL, con:
 *   - timeout duro (una llamada colgada no detiene el ciclo),
 *   - reintentos con backoff ante 429 (rate limit),
 *   - reintentos ante errores de red.
 *
 * Sin este freno, un 429 de GHL haria fallar facturas que SI se podian publicar.
 * ==============================================================================
 */

import { configFactura } from '../config.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch con timeout y reintentos.
 * @param {string} url
 * @param {object} opciones    Opciones de fetch.
 * @param {number} intento     1-based.
 * @param {string} caller      Etiqueta para logs.
 */
export async function ghlFetch(url, opciones = {}, intento = 1, caller = 'GHL') {
  const cfg = configFactura();
  const timeoutMs = cfg.ghl.timeoutMs;
  const maxReintentos = cfg.ghl.maxReintentos;

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(new Error(`GHL_HTTP_TIMEOUT_${timeoutMs}ms`)), timeoutMs);

  try {
    const res = await fetch(url, { ...opciones, signal: controlador.signal });

    if (res.status === 429 && intento <= maxReintentos) {
      const retryAfter = Math.min(parseInt(res.headers.get('retry-after') || '5', 10) || 5, 60);
      const esperaMs = retryAfter * intento * 1000;
      console.warn(`[${caller}] [429] Rate limit de GHL. Reintento ${intento}/${maxReintentos} en ${esperaMs / 1000}s.`);
      await sleep(esperaMs);
      return ghlFetch(url, opciones, intento + 1, caller);
    }

    return res;
  } catch (e) {
    if (intento <= maxReintentos) {
      const esperaMs = 1000 * intento;
      console.warn(`[${caller}] [RED] ${e.message}. Reintento ${intento}/${maxReintentos} en ${esperaMs}ms.`);
      await sleep(esperaMs);
      return ghlFetch(url, opciones, intento + 1, caller);
    }
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}
