/**
 * ==============================================================================
 * LOA INVOICE ENGINE - SUITE DEL GENERADOR DE INVOICE
 * ==============================================================================
 * Verifica el documento sin depender de vTiger ni de GHL:
 *   1. Formato de montos (coma decimal).
 *   2. Lineas en modo 'etiqueta' (el vigente) y 'detalle'.
 *   3. Normalizacion del contacto (nombre y direccion de la etiqueta).
 *   4. Nombre de archivo.
 *   5. MODELO del documento: el contenido exacto que se imprime (determinista).
 *   6. Estructura del PDF generado (firma, tamaño y tamaño de pagina).
 *   7. Degradacion elegante del logo y emisor configurable.
 *
 * Ejecucion:  node tests/test_render.js
 * ==============================================================================
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generarFacturaPdf, formatearMonto, construirLineasDesdeOrden,
  normalizarContactoFactura, nombreArchivoInvoice, construirModeloInvoice,
  EMPRESA_POR_DEFECTO, COLUMNAS_TABLA
} from '../src/core/invoice_render.js';

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  [PASS] ${msg}`); passed++; }
  else { console.error(`  [FAIL] ${msg}`); failed++; }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-render-'));

const ORDEN = {
  id: '6x35385',
  numeroOrden: 'S-96567',
  fecha: '2026-10-03',
  total: '210.00000000',
  producto: 'CELULAS MADRES 60 CAPS',
  cantidad: '4,00',
  tratamiento: 'Artritis'
};

const CONTACTO = {
  firstname: 'ELIZABETH',
  lastname: 'CRUZ',
  phone: '4076935971',
  cf_870: 'PO BOX 229',
  cf_876: 'INTERCESSION CITY',
  cf_872: '33848',
  cf_1053: 'FL-Florida'
};

console.log('\n==========================================================');
console.log(' [TEST] GENERADOR DEL DOCUMENTO DE INVOICE');
console.log('==========================================================\n');

// ------------------------------------------------------------------------------
console.log('[TEST 1] Formato de montos (estilo del documento: coma decimal)');
assert(formatearMonto('210.00000000') === '210,00', 'Convierte el total de vTiger a 210,00');
assert(formatearMonto('160') === '160,00', 'Agrega los dos decimales');
assert(formatearMonto('0') === '0,00', 'Formatea el cero');
assert(formatearMonto('') === '0,00', 'Un total vacio no rompe');
assert(formatearMonto('1234.5') === '1234,50', 'Redondea a dos decimales');

// ------------------------------------------------------------------------------
console.log('\n[TEST 2] Lineas del documento');
const lineasEtiqueta = construirLineasDesdeOrden(ORDEN, 'etiqueta');
assert(lineasEtiqueta.length === 2, 'Modo etiqueta: 2 lineas (producto + oferta especial)');
assert(lineasEtiqueta[0].total === '0,00', 'La linea del producto va con importe 0,00 (formato vigente)');
assert(lineasEtiqueta[1].texto === 'OFERTA ESPECIAL', 'La ultima linea es OFERTA ESPECIAL');
assert(lineasEtiqueta[1].total === '210,00', 'El importe real aparece en la ultima linea');
assert(lineasEtiqueta[0].texto === 'CELULAS MADRES 60 CAPS', 'El texto del producto va en mayusculas');

const lineasDetalle = construirLineasDesdeOrden(ORDEN, 'detalle');
assert(lineasDetalle.length === 1 && lineasDetalle[0].total === '210,00', 'Modo detalle: una linea con el importe real');
assert(construirLineasDesdeOrden({ total: '50' }, 'detalle')[0].total === '50,00', 'Sin producto definido no rompe');

// ------------------------------------------------------------------------------
console.log('\n[TEST 3] Datos del cliente (los de la etiqueta de envio)');
const cli = normalizarContactoFactura(CONTACTO);
assert(cli.nombre === 'ELIZABETH CRUZ', 'Compone el nombre en mayusculas');
assert(cli.direccionLineas[0] === 'PO BOX 229', 'Toma la direccion');
assert(cli.direccionLineas[1] === '33848 INTERCESSION CITY', 'Combina zip y ciudad');
assert(cli.direccionLineas[2] === 'FL-Florida', 'Toma el estado');
assert(cli.direccionLineas[3] === '4076935971', 'Toma el telefono');
assert(normalizarContactoFactura({}).nombre === 'CLIENTE', 'Un contacto vacio no rompe (usa CLIENTE)');
assert(normalizarContactoFactura({ mobile: '3050000000' }).direccionLineas.includes('3050000000'), 'Usa mobile si no hay phone');

// ------------------------------------------------------------------------------
console.log('\n[TEST 4] Nombre de archivo del invoice');
assert(nombreArchivoInvoice(ORDEN) === 'INVOICE_S-96567.pdf', 'Usa el numero de invoice');
assert(nombreArchivoInvoice({ numeroOrden: 'G 0421/2158' }) === 'INVOICE_G_0421_2158.pdf', 'Neutraliza caracteres invalidos');
assert(nombreArchivoInvoice({}) === 'INVOICE_sin-numero.pdf', 'Sin numero usa un nombre seguro');

// ------------------------------------------------------------------------------
console.log('\n[TEST 5] MODELO del documento (el contenido exacto que se imprime)');
const modelo = construirModeloInvoice({ orden: ORDEN, contacto: CONTACTO });
assert(modelo.titulo === 'INVOICE No. S-96567  -  2026-10-03', `Encabezado: "${modelo.titulo}"`);
assert(modelo.numero === 'S-96567', 'Expone el numero de invoice');
assert(modelo.fecha === '2026-10-03', 'Expone la fecha');
assert(modelo.cliente.nombre === 'ELIZABETH CRUZ', 'Bloque del cliente con el nombre');
assert(modelo.cliente.lineas.join(' | ') === 'PO BOX 229 | 33848 INTERCESSION CITY | FL-Florida | 4076935971', 'Bloque del cliente con la direccion completa de la etiqueta');
assert(modelo.emisor.nombre === 'LABORATORIOS NATURALES', 'Bloque del emisor con la razon social');
assert(modelo.emisor.lineas.join(' | ') === '14447 SW 28TH ST | 33175 MIAMI | FL-Florida | 3053007017', 'Bloque del emisor con sus datos');
assert(modelo.tabla.columnas.join(',') === COLUMNAS_TABLA.join(','), 'Titulos de la tabla: Pos | Cantidad | Text | Total');
assert(modelo.tabla.filas.length === 2, 'La tabla lleva 2 filas en modo etiqueta');
assert(modelo.tabla.filas[0].texto === 'CELULAS MADRES 60 CAPS' && modelo.tabla.filas[0].cantidad === '4,00', 'Primera fila: producto y cantidad');
assert(modelo.tabla.filas[1].texto === 'OFERTA ESPECIAL', 'Segunda fila: OFERTA ESPECIAL');
assert(modelo.total === '210,00', 'El total del documento es 210,00');
assert(modelo.terminos.includes('returns within 30 days'), 'Incluye la politica de devoluciones aprobada');
assert(construirModeloInvoice({ orden: ORDEN, contacto: CONTACTO, modo: 'detalle' }).tabla.filas.length === 1, 'El modo detalle cambia el modelo (1 fila)');

// ------------------------------------------------------------------------------
console.log('\n[TEST 6] Estructura del PDF generado');
const pdf = await generarFacturaPdf({ orden: ORDEN, contacto: CONTACTO });
assert(Buffer.isBuffer(pdf), 'Devuelve un Buffer');
assert(pdf.slice(0, 5).toString('latin1') === '%PDF-', 'Tiene la firma %PDF-');
assert(pdf.length > 1500, `El PDF tiene contenido real (${pdf.length} bytes)`);
const crudo = pdf.toString('latin1');
assert(crudo.includes('/MediaBox [0 0 841.89 595.28]'), 'La pagina es A4 horizontal (841.89 x 595.28 pt)');
assert(crudo.includes('/Type /Page'), 'Contiene al menos una pagina');
assert(crudo.includes('/Font'), 'Incrusta las fuentes del documento');

// ------------------------------------------------------------------------------
console.log('\n[TEST 7] Escritura en disco, logo y emisor configurable');
const destino = path.join(TMP, 'invoice.pdf');
fs.writeFileSync(destino, pdf);
assert(fs.existsSync(destino) && fs.statSync(destino).size > 1500, 'El PDF se puede guardar en disco');

const conLogoInexistente = await generarFacturaPdf({ orden: ORDEN, contacto: CONTACTO, empresa: { logoPath: path.join(TMP, 'no-existe.png') } });
assert(conLogoInexistente.slice(0, 5).toString('latin1') === '%PDF-', 'Si el logo no existe, genera el PDF con el placeholder de marca');

const modeloPropio = construirModeloInvoice({ orden: ORDEN, contacto: CONTACTO, empresa: { nombre: 'OTRA EMPRESA SA', terminos: 'Sin devoluciones.' } });
assert(modeloPropio.emisor.nombre === 'OTRA EMPRESA SA', 'Permite sobrescribir los datos del emisor');
assert(modeloPropio.terminos === 'Sin devoluciones.', 'Permite sobrescribir los terminos');
assert(EMPRESA_POR_DEFECTO.nombre === 'LABORATORIOS NATURALES', 'Los datos por defecto son los aprobados');

// ------------------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }

console.log('\n==========================================================');
console.log(` RESULTADO: ${passed} PASS / ${failed} FAIL`);
console.log('==========================================================\n');

if (failed > 0) process.exitCode = 1;
