/**
 * ==============================================================================
 * LOA INVOICE ENGINE - GENERADOR DEL DOCUMENTO DE INVOICE (PLANTILLA PROPIA)
 * ==============================================================================
 * Construye el PDF del invoice con los datos de la orden, SIN depender de vTiger
 * ni de la plantilla PDF del CRM. Replica el formato aprobado por el negocio:
 *
 *   - Cabecera: logo + "INVOICE No. <numero>  -  <fecha>"
 *   - Bloque izquierdo: datos del cliente (los mismos de la etiqueta de envio)
 *   - Bloque derecho: datos del emisor
 *   - Tabla: Pos | Cantidad | Text | Total, con la fila de total
 *   - TERMS AND CONDITIONS
 *
 * ARQUITECTURA (por que esta partido en dos):
 *   `construirModeloInvoice()`  -> QUE dice el documento (objeto puro, testeable
 *                                  sin generar ni parsear PDFs).
 *   `generarFacturaPdf()`       -> COMO se dibuja (pdfkit).
 *   Asi el contenido se verifica de forma determinista y el dibujo se puede
 *   cambiar sin tocar la logica de datos.
 *
 * MODO "ETIQUETA" (por defecto): el detalle de productos va con importe 0,00 y el
 * importe real aparece en la ultima linea ("OFERTA ESPECIAL"), igual que el
 * documento vigente. Con modo 'detalle' se emite el importe por linea.
 *
 * CONTRATO DE ENTRADA (todo sale del CRM: cero invencion de datos):
 *   orden    { numeroOrden|numeroInvoice, fecha, total, producto, cantidad }
 *   contacto { firstname, lastname, phone, cf_870, cf_872, cf_876, cf_1053 }
 *   empresa  { nombre, direccion, ciudad, estado, telefono, terminos, logoPath }
 * ==============================================================================
 */

import fs from 'fs';
import PDFDocument from 'pdfkit';

/** Datos del emisor (los de la plantilla aprobada). */
export const EMPRESA_POR_DEFECTO = {
  nombre: 'LABORATORIOS NATURALES',
  direccion: '14447 SW 28TH ST',
  ciudad: '33175 MIAMI',
  estado: 'FL-Florida',
  telefono: '3053007017',
  terminos: 'We accept returns within 30 days of purchase. The product must be in its original condition, unused, and in its original packaging. To initiate a return, contact us with your order number. Returns will not be accepted after the stated period. Shipping costs are non-refundable.',
  logoPath: null
};

/** Colores de la plantilla. */
const COLOR = {
  texto: '#111111',
  gris: '#666666',
  lineaTabla: '#9E9E9E',
  cabeceraTabla: '#E0E0E0',
  verde: '#2E7D32'
};

/** Titulos de la tabla (formato aprobado). */
export const COLUMNAS_TABLA = ['Pos', 'Cantidad', 'Text', 'Total'];

/** Monto con coma decimal y 2 decimales: '210.00000000' -> '210,00'. */
export function formatearMonto(valor = '') {
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n)) return String(valor || '0').trim() || '0,00';
  return n.toFixed(2).replace('.', ',');
}

/**
 * Convierte la orden del CRM en las lineas de la tabla.
 * @param {'etiqueta'|'detalle'} modo
 */
export function construirLineasDesdeOrden(orden = {}, modo = 'etiqueta') {
  const producto = String(orden.producto || orden.tratamiento || 'PRODUCTO').trim();
  const cantidad = String(orden.cantidad || '1').trim();
  const total = String(orden.total || '0').trim();

  if (modo === 'detalle') {
    return [{ pos: 1, cantidad, texto: producto.toUpperCase(), total: formatearMonto(total) }];
  }

  return [
    { pos: 1, cantidad, texto: producto.toUpperCase(), total: '0,00' },
    { pos: 2, cantidad: '', texto: 'OFERTA ESPECIAL', total: formatearMonto(total) }
  ];
}

/** Normaliza el contacto del CRM al bloque del documento. */
export function normalizarContactoFactura(contacto = {}) {
  const nombre = [contacto.firstname, contacto.lastname].filter(Boolean).join(' ').trim();
  const lineas = [
    String(contacto.cf_870 || '').trim(),
    [String(contacto.cf_872 || '').trim(), String(contacto.cf_876 || '').trim()].filter(Boolean).join(' '),
    String(contacto.cf_1053 || '').trim(),
    String(contacto.phone || contacto.mobile || '').trim()
  ].filter(Boolean);

  return { nombre: (nombre || 'CLIENTE').toUpperCase(), direccionLineas: lineas };
}

/** Nombre de archivo seguro para el invoice. */
export function nombreArchivoInvoice(orden = {}) {
  const numero = String(orden.numeroInvoice || orden.numeroOrden || 'sin-numero')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  return `INVOICE_${numero || 'sin-numero'}.pdf`;
}

/**
 * MODELO del documento: todo lo que el PDF va a mostrar, en un objeto puro.
 * Es la fuente de verdad del contenido y lo que se prueba en la suite.
 */
export function construirModeloInvoice({ orden = {}, contacto = {}, empresa = {}, lineas = null, modo = 'etiqueta' } = {}) {
  const emp = { ...EMPRESA_POR_DEFECTO, ...empresa };
  const cli = contacto.direccionLineas ? contacto : normalizarContactoFactura(contacto);
  const filas = lineas || construirLineasDesdeOrden(orden, modo);

  return {
    titulo: `INVOICE No. ${orden.numeroInvoice || orden.numeroOrden || ''}  -  ${orden.fecha || ''}`,
    numero: String(orden.numeroInvoice || orden.numeroOrden || ''),
    fecha: String(orden.fecha || ''),
    cliente: { nombre: cli.nombre, lineas: cli.direccionLineas },
    emisor: {
      nombre: emp.nombre,
      lineas: [emp.direccion, emp.ciudad, emp.estado, emp.telefono].filter(Boolean)
    },
    tabla: { columnas: [...COLUMNAS_TABLA], filas },
    total: formatearMonto(orden.total),
    terminos: emp.terminos,
    empresa: emp
  };
}

/** Dibuja el logo (imagen si existe; si no, un placeholder con la marca). */
function dibujarLogo(doc, empresa, x, y) {
  if (empresa.logoPath && fs.existsSync(empresa.logoPath)) {
    try {
      doc.image(empresa.logoPath, x, y, { width: 130 });
      return;
    } catch { /* si el logo falla, se degrada al placeholder */ }
  }
  doc.save();
  doc.circle(x + 14, y + 14, 14).fill(COLOR.verde);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12).text('LN', x + 5, y + 8);
  doc.restore();
  doc.fillColor(COLOR.verde).font('Helvetica-Bold').fontSize(13).text('Laboratorios', x + 36, y + 2);
  doc.fillColor(COLOR.verde).font('Helvetica-Oblique').fontSize(11).text('Naturales', x + 36, y + 17);
}

/**
 * Genera el PDF del invoice.
 * @returns {Promise<Buffer>} bytes del PDF (firma %PDF-)
 */
export function generarFacturaPdf({
  orden = {},
  contacto = {},
  empresa = {},
  lineas = null,
  modo = 'etiqueta',
  compress = true,
  formato = 'A4',
  orientacion = 'landscape'
} = {}) {
  const modelo = construirModeloInvoice({ orden, contacto, empresa, lineas, modo });

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: formato, layout: orientacion, margin: 40, compress });
      const trozos = [];
      doc.on('data', c => trozos.push(c));
      doc.on('end', () => resolve(Buffer.concat(trozos)));
      doc.on('error', reject);

      const izq = 40;
      const der = doc.page.width - 40;
      const anchoTotal = der - izq;

      // ------------------------------------------------------------- CABECERA
      dibujarLogo(doc, modelo.empresa, izq, 38);
      doc.fillColor(COLOR.texto).font('Helvetica-Bold').fontSize(16)
        .text(modelo.titulo, izq + 200, 48, { width: anchoTotal - 200, align: 'center' });

      // --------------------------------------------------- BLOQUES DE DATOS
      const yDatos = 100;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.texto)
        .text(modelo.cliente.nombre, izq, yDatos, { width: 300 });
      doc.font('Helvetica').fontSize(10).fillColor(COLOR.texto);
      let y = doc.y + 4;
      for (const linea of modelo.cliente.lineas) {
        doc.text(linea, izq, y, { width: 300 });
        y = doc.y + 1;
      }

      const xEmisor = izq + anchoTotal / 2 + 40;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.texto).text(modelo.emisor.nombre, xEmisor, yDatos, { width: 260 });
      doc.font('Helvetica').fontSize(10);
      let ye = doc.y + 4;
      for (const linea of modelo.emisor.lineas) {
        doc.text(linea, xEmisor, ye, { width: 260 });
        ye = doc.y + 1;
      }

      // --------------------------------------------------------------- TABLA
      const yTabla = Math.max(y, ye) + 24;
      const cols = [
        { titulo: modelo.tabla.columnas[0], x: izq, w: 60, align: 'center' },
        { titulo: modelo.tabla.columnas[1], x: izq + 60, w: 90, align: 'center' },
        { titulo: modelo.tabla.columnas[2], x: izq + 150, w: anchoTotal - 150 - 110, align: 'center' },
        { titulo: modelo.tabla.columnas[3], x: der - 110, w: 110, align: 'center' }
      ];
      const altoFila = 20;

      doc.rect(izq, yTabla, anchoTotal, altoFila).fill(COLOR.cabeceraTabla);
      doc.fillColor(COLOR.texto).font('Helvetica-Bold').fontSize(10);
      for (const c of cols) doc.text(c.titulo, c.x, yTabla + 6, { width: c.w, align: c.align });

      let yFila = yTabla + altoFila;
      doc.font('Helvetica').fontSize(10);
      for (const fila of modelo.tabla.filas) {
        const valores = [String(fila.pos ?? ''), String(fila.cantidad ?? ''), String(fila.texto ?? ''), String(fila.total ?? '')];
        cols.forEach((c, i) => doc.fillColor(COLOR.texto).text(valores[i], c.x, yFila + 6, { width: c.w, align: c.align }));
        yFila += altoFila;
      }

      doc.font('Helvetica-Bold');
      doc.text('Total (USD)', cols[2].x, yFila + 6, { width: cols[2].w, align: 'right' });
      doc.text(modelo.total, cols[3].x, yFila + 6, { width: cols[3].w, align: 'center' });
      yFila += altoFila;

      doc.strokeColor(COLOR.lineaTabla).lineWidth(0.8);
      doc.rect(izq, yTabla, anchoTotal, yFila - yTabla).stroke();
      for (let i = 1; i < cols.length; i++) {
        doc.moveTo(cols[i].x, yTabla).lineTo(cols[i].x, yFila).stroke();
      }
      doc.moveTo(izq, yFila - altoFila).lineTo(der, yFila - altoFila).stroke();
      doc.moveTo(izq, yTabla + altoFila).lineTo(der, yTabla + altoFila).stroke();

      // ---------------------------------------------------- TERMINOS Y COND.
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.texto).text('TERMS AND CONDITIONS', izq, yFila + 30);
      doc.font('Helvetica').fontSize(10).fillColor(COLOR.gris)
        .text(modelo.terminos, izq, doc.y + 6, { width: anchoTotal, align: 'left' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
