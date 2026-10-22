import assert from 'node:assert/strict';
import http from 'node:http';
import { verificarEnlaceSincronizado } from '../src/core/link_validator.js';

console.log('--- Test link_validator: Validación de Documento Sincronizado ---');

// 1. Simular servidor local con ruta 200 PDF, ruta 404 error HTML, y ruta 302 redirect
const server = http.createServer((req, res) => {
  if (req.url === '/factura_ok.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(Buffer.from('%PDF-1.4 test invoice content'));
    return;
  }
  if (req.url === '/redirect_ok') {
    res.writeHead(302, { 'Location': '/factura_ok.pdf' });
    res.end();
    return;
  }
  if (req.url === '/no_disponible') {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>La factura solicitada no se encuentra disponible</body></html>');
    return;
  }
  if (req.url === '/falso_200_html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>Factura no disponible o procesando</body></html>');
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

await new Promise(resolve => server.listen(0, resolve));
const puerto = server.address().port;
const base = `http://localhost:${puerto}`;

// Prueba 1: PDF directo 200
const r1 = await verificarEnlaceSincronizado(`${base}/factura_ok.pdf`);
assert.equal(r1.sincronizado, true, 'El PDF directo debe estar sincronizado');
assert.equal(r1.esPdf, true);
assert.equal(r1.status, 200);
console.log('  [PASS] PDF directo confirmado sincronizado');

// Prueba 2: Redirección 302 que lleva a PDF
const r2 = await verificarEnlaceSincronizado(`${base}/redirect_ok`);
assert.equal(r2.sincronizado, true, 'La redirección 302 a PDF debe resolverse y ser válida');
assert.equal(r2.esPdf, true);
assert.equal(r2.status, 200);
console.log('  [PASS] Redirección 302 a PDF confirmada');

// Prueba 3: Ruta con error 404 (documento no disponible) -> BLOQUEADO
const r3 = await verificarEnlaceSincronizado(`${base}/no_disponible`);
assert.equal(r3.sincronizado, false, 'Error 404 debe bloquear el envío');
assert.equal(r3.status, 404);
console.log('  [PASS] 404 bloquea el envío correctamente');

// Prueba 4: Falso 200 con pantalla HTML de error -> BLOQUEADO
const r4 = await verificarEnlaceSincronizado(`${base}/falso_200_html`);
assert.equal(r4.sincronizado, false, 'Falso 200 con HTML de no disponible debe bloquear el envío');
console.log('  [PASS] Falso 200 HTML bloquea el envío correctamente');

// Prueba 5: URL inválida o vacía -> BLOQUEADO
const r5 = await verificarEnlaceSincronizado('');
assert.equal(r5.sincronizado, false);
console.log('  [PASS] URL vacía bloquea el envío');

server.close();
console.log('TODAS LAS PRUEBAS DE VALIDACIÓN DE ENLACE PASARON (100% OK)');
