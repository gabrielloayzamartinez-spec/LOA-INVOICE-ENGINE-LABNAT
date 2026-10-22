import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  guardarEnlaceFactura,
  cargarEnlaces,
  resolverDestinoFactura,
  construirUrlBranded
} from '../src/core/short_links.js';
import { iniciarServidorEventos } from '../src/webhook_server.js';

const TMP_LINKS = 'data/test_tmp_links.json';
const TMP_PIPELINE = 'data/test_tmp_pipeline.jsonl';

function limpiar() {
  if (fs.existsSync(TMP_LINKS)) fs.unlinkSync(TMP_LINKS);
  if (fs.existsSync(TMP_PIPELINE)) fs.unlinkSync(TMP_PIPELINE);
}

limpiar();

console.log('--- Test short_links: Guardado y resolución ---');
const r1 = guardarEnlaceFactura({
  numeroOrden: 'S-97576',
  urlDestino: 'https://assets.cdn.filesafe.space/media/s97576.pdf',
  ruta: TMP_LINKS
});
assert.equal(r1.ok, true);

const res1 = resolverDestinoFactura('S-97576', { rutaLinks: TMP_LINKS });
assert.equal(res1, 'https://assets.cdn.filesafe.space/media/s97576.pdf');

// Insensible a mayúsculas
const resMin = resolverDestinoFactura('s-97576', { rutaLinks: TMP_LINKS });
assert.equal(resMin, 'https://assets.cdn.filesafe.space/media/s97576.pdf');

console.log('--- Test short_links: Construcción URL de marca ---');
const urlMarca = construirUrlBranded({
  baseDominio: 'https://facturas.labnaturales.com',
  numeroOrden: 'S-97576'
});
assert.equal(urlMarca, 'https://facturas.labnaturales.com/S-97576');

console.log('--- Test webhook_server: Redirección HTTP 302 a PDF ---');
const { server, url } = await iniciarServidorEventos({
  puerto: 0,
  token: 'test-token',
  atender: () => ({ ok: true }),
  rutaLinks: TMP_LINKS
});

// Petición GET /S-97576
const req302 = await new Promise((resolve, reject) => {
  const parsed = new URL(`${url}/S-97576`);
  http.get(parsed, (res) => {
    resolve({ statusCode: res.statusCode, location: res.headers.location });
  }).on('error', reject);
});

assert.equal(req302.statusCode, 302, 'Debe responder HTTP 302 Redirect');
assert.equal(req302.location, 'https://assets.cdn.filesafe.space/media/s97576.pdf', 'Debe apuntar al CDN de GHL');

// Petición GET /S-INEXISTENTE (404)
const req404 = await new Promise((resolve, reject) => {
  const parsed = new URL(`${url}/S-INEXISTENTE`);
  http.get(parsed, (res) => {
    resolve({ statusCode: res.statusCode });
  }).on('error', reject);
});
assert.equal(req404.statusCode, 404, 'Orden inexistente debe responder 404');

server.close();
limpiar();

console.log('TODAS LAS PRUEBAS DE ENLACES CORTOS Y REDIRECCIÓN PASARON (100% OK)');
