/**
 * ==============================================================================
 * LOA INVOICE ENGINE - WEBSERVICE DE VTIGER (DETECCION DE COMPRAS)
 * ==============================================================================
 * Lectura de compras por la Webservice API (challenge + login + query).
 *
 * CANDADO DE SOLO LECTURA EN TRES CAPAS (igual que el motor principal):
 *   1. HTTP      : solo GET; POST unicamente para el handshake de login.
 *   2. Operacion : allow-list estricta (`query`, `getchallenge`, `login`).
 *   3. Sentencia : toda consulta debe empezar con SELECT y no puede contener
 *                  verbos de escritura (INSERT/UPDATE/DELETE/DROP...).
 *
 * Este motor JAMAS escribe, modifica ni inyecta datos en vTiger.
 * ==============================================================================
 */

import crypto from 'crypto';

/** Operaciones permitidas (allow-list, no deny-list). */
export const VTIGER_ALLOWED_OPERATIONS = ['query', 'getchallenge', 'login'];

const VERBOS_ESCRITURA = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i;

export class VtigerReadOnlyViolation extends Error {
  constructor(message, { stage = null, detail = null } = {}) {
    super(message);
    this.name = 'VtigerReadOnlyViolation';
    this.code = 'VTIGER_READ_ONLY_VIOLATION';
    this.stage = stage;
    this.detail = detail;
  }
}

export class VtigerWebserviceError extends Error {
  constructor(message, { code = 'VTIGER_WEBSERVICE_ERROR', status = null } = {}) {
    super(message);
    this.name = 'VtigerWebserviceError';
    this.code = code;
    this.status = status;
  }
}

/** CAPA 1: solo GET, salvo el POST de login. */
export function assertMetodoPermitido(method = 'GET', { isLogin = false } = {}) {
  const m = String(method).toUpperCase();
  if (m === 'GET') return true;
  if (m === 'POST' && isLogin) return true;
  throw new VtigerReadOnlyViolation(`Metodo HTTP '${m}' prohibido sobre vTiger (solo lectura).`, { stage: 'HTTP_METHOD', detail: m });
}

/** CAPA 2: allow-list de operaciones. */
export function assertOperacionPermitida(operation = '') {
  const op = String(operation).toLowerCase().trim();
  if (VTIGER_ALLOWED_OPERATIONS.includes(op)) return true;
  throw new VtigerReadOnlyViolation(`Operacion vTiger '${op}' prohibida (allow-list: ${VTIGER_ALLOWED_OPERATIONS.join(', ')}).`, { stage: 'OPERATION', detail: op });
}

/** CAPA 3: la sentencia debe ser de lectura. */
export function assertSentenciaSoloLectura(sql = '') {
  const statement = String(sql).trim();
  if (!/^\s*SELECT\b/i.test(statement)) {
    throw new VtigerReadOnlyViolation('Solo se permiten sentencias SELECT sobre vTiger.', { stage: 'STATEMENT' });
  }
  const verbo = VERBOS_ESCRITURA.exec(statement);
  if (verbo) {
    throw new VtigerReadOnlyViolation(`Sentencia con verbo de escritura '${verbo[1].toUpperCase()}' bloqueada: vTiger es solo lectura.`, { stage: 'STATEMENT' });
  }
  return true;
}

/** Escapa un valor para interpolarlo en una consulta de vTiger. */
export function escaparValor(valor = '') {
  return String(valor).replace(/'/g, "''").replace(/[\\;]/g, '');
}

/**
 * Crea un cliente de la Webservice API con sesion cacheada (single-flight).
 */
export function crearClienteVtiger({ url, username, accessKey, fetchImpl = globalThis.fetch, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const endpoint = `${base}/webservice.php`;

  let sessionName = null;
  let expiraEn = 0;
  let enVuelo = null;

  function sesionVigente() {
    return Boolean(sessionName) && Date.now() < expiraEn;
  }

  async function hacerLogin() {
    assertMetodoPermitido('GET');
    assertOperacionPermitida('getchallenge');
    if (!base || !username || !accessKey) {
      throw new VtigerWebserviceError('Credenciales de la Webservice API incompletas (VTIGER_URL, VTIGER_USERNAME, VTIGER_ACCESS_KEY).', { code: 'WS_CREDENTIALS_MISSING' });
    }

    const resChallenge = await fetchImpl(`${endpoint}?operation=getchallenge&username=${encodeURIComponent(username)}`);
    const dataChallenge = await resChallenge.json().catch(() => null);
    const token = dataChallenge?.result?.token;
    if (!token) {
      throw new VtigerWebserviceError(`No se obtuvo el token de desafio de vTiger (HTTP ${resChallenge.status}).`, { code: 'WS_CHALLENGE_FAILED', status: resChallenge.status });
    }

    assertMetodoPermitido('POST', { isLogin: true });
    assertOperacionPermitida('login');
    const clave = crypto.createHash('md5').update(`${token}${accessKey}`).digest('hex');

    const resLogin = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ operation: 'login', username, accesskey: clave }).toString()
    });
    const dataLogin = await resLogin.json().catch(() => null);
    const sesion = dataLogin?.result?.sessionName;
    if (!sesion) {
      throw new VtigerWebserviceError(`Login de la Webservice API rechazado (HTTP ${resLogin.status}).`, { code: 'WS_LOGIN_FAILED', status: resLogin.status });
    }

    sessionName = sesion;
    expiraEn = Date.now() + ttlMs;
    return sessionName;
  }

  async function asegurarSesion() {
    if (sesionVigente()) return sessionName;
    if (enVuelo) return enVuelo;
    enVuelo = hacerLogin().finally(() => { enVuelo = null; });
    return enVuelo;
  }

  /** Ejecuta una consulta SELECT. Reintenta UNA vez si la sesion expiro. */
  async function consultar(sql, { intento = 1 } = {}) {
    assertOperacionPermitida('query');
    assertSentenciaSoloLectura(sql);

    const sesion = await asegurarSesion();
    const res = await fetchImpl(`${endpoint}?operation=query&sessionName=${encodeURIComponent(sesion)}&query=${encodeURIComponent(sql)}`);
    const data = await res.json().catch(() => null);

    const error = data?.error;
    const sinSesion = error?.code === 'ACCESS_DENIED' || /session/i.test(String(error?.message || ''));
    if (error && sinSesion && intento === 1) {
      sessionName = null; // sesion vencida: se renueva y se reintenta una vez
      return consultar(sql, { intento: 2 });
    }
    if (error) {
      throw new VtigerWebserviceError(`vTiger respondio un error: ${error.message || error.code}`, { code: 'WS_QUERY_ERROR', status: res.status });
    }

    return Array.isArray(data?.result) ? data.result : [];
  }

  return { consultar, asegurarSesion, sesionVigente, cerrar: () => { sessionName = null; expiraEn = 0; } };
}
