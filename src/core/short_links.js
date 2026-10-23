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

  // 1. Buscar en links.json (ruta configurada)
  let mapa = cargarEnlaces(rutaLinks);
  if (mapa[clave]?.url) {
    return mapa[clave].url;
  }

  // Respaldo 1: si no se encontro en rutaLinks y no es la ruta relativa local 'data/links.json'
  if (rutaLinks !== RUTA_LINKS_DEFECTO) {
    const mapaLocal = cargarEnlaces(RUTA_LINKS_DEFECTO);
    if (mapaLocal[clave]?.url) {
      return mapaLocal[clave].url;
    }
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

    // 3. Respaldo directo en memoria para ordenes oficiales emitidas
  const estaticos = {
    'S-97555': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/3eff4f49-6efe-4b44-a228-8f8780c5b9fc.pdf',
    'S-97589': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/6921b834-bb46-4dc0-a0c2-74adfdd3891c.pdf',
    'S-97576': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/86307f58-97f1-46ff-a0fd-a971ca7b7574.pdf',
    'S-97557': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/5f574888-36e7-487d-b7ba-34f60a838e24.pdf',
    'S-97558': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/309e75d1-9da0-4df8-8ee1-14bd437792a8.pdf',
    'S-97559': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fecf83ac-ff31-49cd-9fc2-a216d88af50d.pdf',
    'S-97560': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/b01e5cb5-49df-4b9c-9902-df419745d630.pdf',
    'S-97561': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/cb56c498-c5ab-46b9-96bb-dbc580ca9101.pdf',
    'S-97562': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/01b8c926-aa2e-4771-9c02-32945c0cea2b.pdf',
    'S-97563': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/58c74ca1-d3f5-4128-ac3a-b16db999ad38.pdf',
    'S-97564': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/dd13e6d5-bb74-4895-9a91-7b1f90a20c5f.pdf',
    'S-97565': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fda790ad-e607-4a38-bcc0-3ec62084de73.pdf',
    'S-97566': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/95757d78-0230-4c69-8c30-c936c200bdca.pdf',
    'S-97569': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/7ccbf68d-a363-4b1a-b592-166b5ef4a08c.pdf',
    'S-97570': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/dd85711f-6d5b-4d7e-980e-ff3d093e2491.pdf',
    'S-97571': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fb978bb6-a098-4325-b290-fc4f607f11d5.pdf',
    'S-97573': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/1a9527a0-e7fa-4351-aa88-1a0e466c172d.pdf',
    'S-97574': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/51b4809f-3833-4076-9be1-242ebdd49735.pdf',
    'S-97575': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/065bef56-d863-4343-aa17-698469af5eb3.pdf',
    'S-97577': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/0e653745-8a43-4cfa-864e-420d5abbdc16.pdf',
    'S-97578': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/f1fbcecb-7bec-421d-833b-f8af4d7ffcdf.pdf',
    'S-97581': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/dc471645-b507-46d9-a068-aaaac06954dd.pdf',
    'S-97582': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fabebbe2-5396-4c0f-917c-92ae400cf71f.pdf',
    'S-97585': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/f780db5b-bf66-43aa-85af-8c327cb0a893.pdf',
    'S-97586': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/d3648481-bdbd-4c5c-bd0b-3b096d4f21dd.pdf',
    'S-97587': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/afc5d07a-a432-4ea9-92f5-30d37c562d89.pdf',
    'S-97588': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/722c6286-51b5-40b8-a4b1-4d9e1192aec8.pdf',
    'S-97590': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/c5cf0d71-1fd8-4ba1-9989-b97f17d51f69.pdf',
    'S-97593': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/c1f1700d-c8f6-4db5-b301-4c33e3976d18.pdf',
    'S-97594': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/f9a25fe4-f1a4-4219-b3d2-5ebf33549447.pdf',
    'S-97598': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/e60c2630-c976-402b-b6fa-3949a3b9b282.pdf',
    'S-97599': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/a636b8f8-9fac-4ef7-b6a7-380659e14b4d.pdf',
    'S-97603': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/63f47351-626b-43d3-a694-0aad4d9f9457.pdf',
    'S-97604': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/cdd7c1a7-c089-4c6a-aaef-f97ea5e4d3c3.pdf',
    'S-97605': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/5299953d-85c8-4f59-bb3d-d272208be4a2.pdf',
    'S-97606': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fdcc873d-f384-4161-9905-df58150a043e.pdf',
    'S-97607': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/00f30061-183b-4d57-8427-2041df2e292a.pdf',
    'S-97608': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/a82348c2-ffaa-4ea4-a9a2-2bb8d56bd272.pdf',
    'S-97609': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/72146d26-d637-4470-9dc2-2f3a5817de47.pdf',
    'S-97610': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/c202574c-7271-471b-9b7c-701b02bad953.pdf',
    'S-97611': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/be5e5bf6-d4e3-4c87-863c-e4ba8ef634de.pdf',
    'S-97612': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/729f66ee-56ee-47e7-b01e-d946c2a34fb6.pdf',
    'S-97613': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/2be629e5-7296-47d5-a634-fd555d41ecf9.pdf',
    'S-97614': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/e51e10da-1700-4546-9e35-b249fdd3070a.pdf',
    'S-97618': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/3c787e6c-8177-404e-a5aa-e6f467d25f16.pdf',
    'S-97619': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/0dc9bd91-e406-461e-ad2b-d6ed5d9bffc4.pdf',
    'S-97620': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/a605c367-1a09-45a0-b02c-cdb75b577f7b.pdf',
    'S-97621': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/67bb4115-4d35-4161-9b1d-7a050da833ca.pdf',
    'S-97623': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/7ea33867-5db7-4cb8-8cf7-fd86ab695dd1.pdf',
    'S-97624': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/624a8756-6a4a-4135-a7ef-37e48f745c79.pdf',
    'S-97625': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/4e63f33e-583b-47dd-9d8b-688621e22c33.pdf',
    'S-97627': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/a8b227d9-a81e-45a8-808d-f1961075e74a.pdf',
    'S-97628': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/6a93c4fc-92e2-4e0f-b793-f21e9291c332.pdf',
    'S-97629': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/e7cd979c-6db6-4c9c-8408-e3548eb89a1a.pdf',
    'S-97630': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/73e46f84-dea9-4182-8ca0-8edf7c0cc70f.pdf',
    'S-97631': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/6d509f68-a376-4b23-9abc-f94a253601b0.pdf',
    'S-97632': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/afaaf2ae-9063-4700-b5ab-54306dd59c96.pdf',
    'S-97633': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fef6bcd8-cdc3-422f-b1f2-f70b41da7122.pdf',
    'S-97634': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/d4c5bd19-4136-4bc3-8146-948eeaf0a0f3.pdf',
    'S-97635': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/9d32bda5-6fe8-4c2b-baeb-d32c68f4a579.pdf',
    'S-97636': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/fe9b2650-d0eb-4ecd-9a2b-edfdc4f4b9a2.pdf',
    'S-97637': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/9d01201e-b2cc-4328-9ba4-1716cf542f2f.pdf',
    'S-97638': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/1c2ed201-ab2b-4f02-bdae-4f8d41950530.pdf',
    'S-97639': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/aa710736-4109-46a5-bfa9-adaa3f1ff008.pdf',
    'S-97640': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/42252a11-36c7-4de7-8119-96a4612e19f9.pdf',
    'S-97641': 'https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/7b174cf2-c3a9-46f2-a0ad-14b3d058667b.pdf'
  };
  if (estaticos[clave]) return estaticos[clave];

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
