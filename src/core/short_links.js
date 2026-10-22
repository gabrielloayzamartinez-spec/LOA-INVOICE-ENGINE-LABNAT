/**
 * ==============================================================================
 * LOA INVOICE ENGINE - GESTOR DE ENLACES CORTOS Y MARCA PROPIA
 * ==============================================================================
 * Permite transformar URLs largas del CDN de GHL en enlaces estéticos con marca:
 *   https://facturas.labnaturales.com/S-97576
 *
 * Funcionalidades:
 *   - Persistencia segura en JSON (o consulta secundaria en pipeline).
 *   - Normalización insensible a mayúsculas/minúsculas ('s-97576' -> 'S-97576').
 *   - Generación de redirección HTTP 302 hacia el CDN real de GHL.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { leerPipeline, ultimoEstadoPorOrden } from './pipeline.js';

const RUTA_LINKS_DEFECTO = 'data/links.json';

/** Carga el mapa de enlaces desde disco. */
export function cargarEnlaces(ruta = RUTA_LINKS_DEFECTO) {
  try {
    if (!fs.existsSync(ruta)) return {};
    const raw = fs.readFileSync(ruta, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** Guarda un nuevo enlace corto en disco. */
export function guardarEnlaceFactura({
  numeroOrden,
  urlDestino,
  codigo = null,
  ruta = RUTA_LINKS_DEFECTO
} = {}) {
  if (!urlDestino) return { ok: false, motivo: 'SIN_URL_DESTINO' };
  const clavePrincipal = String(codigo || numeroOrden || '').trim().toUpperCase();
  if (!clavePrincipal) return { ok: false, motivo: 'SIN_CLAVE' };

  try {
    const mapa = cargarEnlaces(ruta);
    const ahora = new Date().toISOString();

    const entrada = {
      numeroOrden: numeroOrden ? String(numeroOrden).trim() : null,
      url: String(urlDestino).trim(),
      actualizado: ahora
    };

    mapa[clavePrincipal] = entrada;
    // Si viene numeroOrden y se usó un codigo distinto, guardamos alias cruzado
    if (numeroOrden) {
      const aliasOrden = String(numeroOrden).trim().toUpperCase();
      mapa[aliasOrden] = entrada;
    }

    const dir = path.dirname(ruta);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ruta, JSON.stringify(mapa, null, 2), 'utf8');

    return { ok: true, clave: clavePrincipal, url: urlDestino };
  } catch (e) {
    return { ok: false, motivo: 'ERROR_ESCRITURA', detalle: e.message };
  }
}

/**
 * Resuelve la URL de destino a partir de un código o número de orden.
 * Si no está en links.json, busca como respaldo en pipeline.jsonl.
 */
export function resolverDestinoFactura(
  codigoOOrden = '',
  { rutaLinks = RUTA_LINKS_DEFECTO, rutaPipeline = 'data/pipeline.jsonl' } = {}
) {
  const clave = String(codigoOOrden || '').trim().toUpperCase();
  if (!clave) return null;

  // 1. Buscar en links.json
  const mapa = cargarEnlaces(rutaLinks);
  if (mapa[clave]?.url) {
    return mapa[clave].url;
  }

  // 2. Respaldo: buscar en pipeline.jsonl si coincide con numeroOrden
  try {
    if (fs.existsSync(rutaPipeline)) {
      const filas = leerPipeline(rutaPipeline);
      const finales = ultimoEstadoPorOrden(filas);
      const encontrada = finales.find(f => {
        const no = String(f.numeroOrden || '').trim().toUpperCase();
        const ord = String(f.orden || '').trim().toUpperCase();
        return no === clave || ord === clave;
      });
      if (encontrada?.url) return encontrada.url;
    }
  } catch {}

  return null;
}

/**
 * Construye la URL estética con la marca de la empresa.
 * Ejemplo: https://facturas.labnaturales.com/S-97576
 */
export function construirUrlBranded({ baseDominio = '', numeroOrden = '', codigo = '' } = {}) {
  const baseLimpia = String(baseDominio || '').replace(/\/+$/, '');
  const identificador = String(codigo || numeroOrden || '').trim();
  if (!baseLimpia || !identificador) return '';
  return `${baseLimpia}/${encodeURIComponent(identificador)}`;
}
