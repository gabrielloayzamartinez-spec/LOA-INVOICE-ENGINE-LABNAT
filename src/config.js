/**
 * ==============================================================================
 * LOA INVOICE ENGINE - CONFIGURACION (SIN DEPENDENCIAS EXTERNAS)
 * ==============================================================================
 * Este motor es INDEPENDIENTE: no importa nada del LOA Engine principal ni usa
 * librerias de terceros. Lee su configuracion de `.env` con un parser propio.
 *
 * FILOSOFIA FAIL-SAFE: si falta una variable, la configuracion igual se
 * construye y `validarConfig()` dice QUE falta. El motor nunca muere por una
 * variable ausente: se detiene con un mensaje claro.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';

/** Carga un archivo .env en process.env sin sobreescribir lo ya definido. */
export function cargarEnv(archivo = '.env') {
  const ruta = path.resolve(archivo);
  if (!fs.existsSync(ruta)) return { cargado: false, ruta, variables: 0 };

  const contenido = fs.readFileSync(ruta, 'utf8');
  let variables = 0;

  for (const linea of contenido.split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i <= 0) continue;

    const clave = limpia.slice(0, i).trim();
    let valor = limpia.slice(i + 1).trim();

    // Quita comillas envolventes (simples o dobles).
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    if (process.env[clave] === undefined) process.env[clave] = valor;
    variables++;
  }

  return { cargado: true, ruta, variables };
}

export function env(clave, porDefecto = '') {
  const v = process.env[clave];
  return v === undefined || v === '' ? porDefecto : v;
}

export function envBool(clave, porDefecto = false) {
  const v = String(process.env[clave] ?? '').trim().toLowerCase();
  if (v === '') return porDefecto;
  return v === 'true' || v === '1' || v === 'yes' || v === 'si';
}

export function envInt(clave, porDefecto = 0) {
  const n = parseInt(String(process.env[clave] ?? ''), 10);
  return Number.isFinite(n) ? n : porDefecto;
}

/** Configuracion completa del motor de facturas. */
export function configFactura() {
  return {
    habilitado: envBool('INVOICE_PDF_ENABLED', false),
    vtiger: {
      url: String(env('VTIGER_URL', '')).replace(/\/+$/, ''),
      username: env('VTIGER_USERNAME', ''),
      accessKey: env('VTIGER_ACCESS_KEY', ''),
      webUsername: env('VTIGER_WEB_USERNAME', ''),
      webPassword: env('VTIGER_WEB_PASSWORD', ''),
      webSessionTtlMs: Math.min(Math.max(envInt('VTIGER_WEB_SESSION_TTL_MS', 20 * 60 * 1000), 60 * 1000), 4 * 60 * 60 * 1000)
    },
    ghl: {
      // Base configurable: permite apuntar a un proxy o a un servidor de pruebas
      // HTTP real (test de integracion end-to-end).
      baseUrl: String(env('GHL_BASE_URL', 'https://services.leadconnectorhq.com')).replace(/\/+$/, ''),
      apiKeyCentral: env('GHL_API_KEY_CENTRAL', ''),
      locationIdCentral: env('GHL_LOCATION_ID_CENTRAL', ''),
      timeoutMs: Math.min(Math.max(envInt('GHL_HTTP_TIMEOUT_MS', 30000), 5000), 120000),
      maxReintentos: Math.min(Math.max(envInt('GHL_MAX_REINTENTOS', 3), 0), 6)
    },
    escaneo: {
      intervaloMinutos: Math.max(envInt('INVOICE_SCAN_INTERVAL_MINUTES', 15), 1),
      lote: Math.min(Math.max(envInt('INVOICE_SCAN_BATCH', 25), 1), 200),
      dias: Math.min(Math.max(envInt('INVOICE_SCAN_DIAS', 7), 1), 90),
      sede: String(env('INVOICE_SCAN_SEDE', 'PALACIOS')).toUpperCase(),
      cursorPath: env('INVOICE_CURSOR_PATH', 'data/cursor.json')
    },
    logs: {
      dir: env('INVOICE_LOG_DIR', 'data/logs')
    }
  };
}

/**
 * Valida la configuracion para una operacion concreta.
 * @param {object} cfg          Resultado de configFactura().
 * @param {object} [requiere]   { webservice, sesionWeb, ghl }
 */
export function validarConfig(cfg = configFactura(), requiere = {}) {
  const faltantes = [];
  const { webservice = true, sesionWeb = true, ghl = true } = requiere;

  if (webservice) {
    if (!cfg.vtiger.url) faltantes.push('VTIGER_URL');
    if (!cfg.vtiger.username) faltantes.push('VTIGER_USERNAME');
    if (!cfg.vtiger.accessKey) faltantes.push('VTIGER_ACCESS_KEY');
  }
  if (sesionWeb) {
    if (!cfg.vtiger.url) faltantes.push('VTIGER_URL');
    if (!cfg.vtiger.webUsername) faltantes.push('VTIGER_WEB_USERNAME');
    if (!cfg.vtiger.webPassword) faltantes.push('VTIGER_WEB_PASSWORD');
  }
  if (ghl) {
    if (!cfg.ghl.apiKeyCentral) faltantes.push('GHL_API_KEY_CENTRAL');
    if (!cfg.ghl.locationIdCentral) faltantes.push('GHL_LOCATION_ID_CENTRAL');
  }

  return { ok: faltantes.length === 0, faltantes: [...new Set(faltantes)] };
}

/** Resumen legible (sin secretos) para logs y diagnostico. */
export function resumenConfig(cfg = configFactura()) {
  const host = (u) => (u ? String(u).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null);
  return {
    habilitado: cfg.habilitado,
    vtigerHost: host(cfg.vtiger.url),
    webservice: Boolean(cfg.vtiger.username && cfg.vtiger.accessKey),
    sesionWeb: Boolean(cfg.vtiger.webUsername && cfg.vtiger.webPassword),
    cuentaEmpresa: {
      configurada: Boolean(cfg.ghl.apiKeyCentral && cfg.ghl.locationIdCentral),
      locationIdSufijo: cfg.ghl.locationIdCentral ? String(cfg.ghl.locationIdCentral).slice(-4) : null
    },
    escaneo: { sede: cfg.escaneo.sede, dias: cfg.escaneo.dias, lote: cfg.escaneo.lote, intervaloMinutos: cfg.escaneo.intervaloMinutos }
  };
}
