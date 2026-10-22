/**
 * ==============================================================================
 * LOA INVOICE ENGINE - VERIFICACION DEL INVOICE CONTRA VTIGER
 * ==============================================================================
 * Instrumento de CONTROL: compara, campo por campo, lo que dice vTiger (la fuente
 * de verdad) con lo que el documento va a imprimir. Sirve para corroborar que el
 * invoice es correcto ANTES de publicarlo, y despues para auditar.
 *
 * NO inventa ni corrige: solo compara y reporta. Si algo no coincide, lo dice con
 * el valor de cada lado; si un dato no esta disponible en vTiger (por permisos del
 * rol de API, por ejemplo), lo marca como FALTANTE EN VTIGER en lugar de darlo
 * por bueno.
 * ==============================================================================
 */

/** Compara el modelo del invoice contra la orden y el contacto de vTiger. */
export function compararInvoiceConVtiger({ orden = {}, contacto = {}, modelo } = {}) {
  if (!modelo) throw new TypeError('compararInvoiceConVtiger requiere el modelo del invoice.');

  const campos = [];
  const agregar = (campo, enVtiger, enInvoice) => {
    const a = String(enVtiger ?? '').trim();
    const b = String(enInvoice ?? '').trim();
    campos.push({ campo, enVtiger: a, enInvoice: b, ok: a !== '' && a === b });
  };

  // --- Identificacion ---
  agregar('Numero de invoice', orden.numeroOrden || orden.salesorder_no || '', modelo.numero);
  agregar('Fecha', String(orden.fecha || orden.createdtime || '').slice(0, 10), modelo.fecha);

  // --- Totales ---
  const totalVtiger = String(orden.total ?? orden.hdnGrandTotal ?? '').trim();
  const totalEsperado = totalVtiger === '' ? '' : formatear(totalVtiger);
  agregar('Total', totalEsperado, modelo.total);

  // --- Cliente ---
  const nombreVtiger = [contacto.firstname, contacto.lastname].filter(Boolean).join(' ').trim().toUpperCase();
  agregar('Nombre del cliente', nombreVtiger, modelo.cliente?.nombre);

  // --- Detalle ---
  const productoVtiger = String(orden.producto || orden.cf_3156 || orden.tratamiento || '').trim().toUpperCase();
  const filaProducto = (modelo.tabla?.filas || []).find(f => String(f.texto).toUpperCase() === productoVtiger) || (modelo.tabla?.filas || [])[0];
  agregar('Producto', productoVtiger, filaProducto?.texto || '');
  const cantidadVtiger = String(orden.cantidad || orden.cf_3298 || '').trim();
  const cantidadEsperada = cantidadVtiger === '' ? '' : formatear(cantidadVtiger);
  agregar('Cantidad', cantidadEsperada, filaProducto?.cantidad || '');

  // --- Direccion de envio (los campos que el rol de API puede no permitir) ---
  // Se compara la direccion SIN el telefono (que va como campo propio) para poder
  // detectar el caso real: el rol de vTiger no entrega cf_870 y el invoice sale
  // sin direccion. Eso debe reportarse como FALTA EN VTIGER, no como "OK".
  const telefono = String(contacto.phone || contacto.mobile || '').trim();
  const direccionVtiger = [
    String(contacto.cf_870 || '').trim(),
    [String(contacto.cf_872 || '').trim(), String(contacto.cf_876 || '').trim()].filter(Boolean).join(' '),
    String(contacto.cf_1053 || '').trim()
  ].filter(Boolean).join(' | ');
  const direccionInvoice = (modelo.cliente?.lineas || []).filter(l => l !== telefono).join(' | ');

  campos.push({
    campo: 'Direccion de envio',
    enVtiger: direccionVtiger,
    enInvoice: direccionInvoice,
    ok: direccionVtiger !== '' && direccionVtiger === direccionInvoice
  });

  agregar('Telefono', telefono, (modelo.cliente?.lineas || []).includes(telefono) ? telefono : '');

  // Campos que vTiger entrego vacios: se listan aparte (suelen ser permisos del rol).
  const faltantesEnVtiger = campos.filter(c => c.enVtiger === '').map(c => c.campo);
  const diferencias = campos.filter(c => !c.ok && c.enVtiger !== '').map(c => c.campo);

  return {
    consistente: diferencias.length === 0 && faltantesEnVtiger.length === 0,
    campos,
    diferencias,
    faltantesEnVtiger
  };
}

/** Mismo formato de monto que el documento (coma decimal, 2 decimales). */
function formatear(valor) {
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n)) return String(valor || '').trim();
  return n.toFixed(2).replace('.', ',');
}

/** Resumen legible para la consola (tabla simple). */
export function formatearVerificacion(resultado) {
  const lineas = [];
  const ancho = 24;
  lineas.push(`${'CAMPO'.padEnd(ancho)}${'VTIGER'.padEnd(30)}${'INVOICE'.padEnd(30)}ESTADO`);
  lineas.push('-'.repeat(ancho + 60 + 8));
  for (const c of resultado.campos) {
    const estado = c.enVtiger === '' ? 'FALTA EN VTIGER' : (c.ok ? 'OK' : 'DIFERENTE');
    lineas.push(`${c.campo.padEnd(ancho)}${String(c.enVtiger).slice(0, 29).padEnd(30)}${String(c.enInvoice).slice(0, 29).padEnd(30)}${estado}`);
  }
  return lineas.join('\n');
}
