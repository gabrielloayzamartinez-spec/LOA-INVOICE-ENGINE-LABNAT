/**
 * Script TEMPORAL: matriz de accesos REAL campo por campo contra vTiger.
 * Determina si cada campo esta permitido o denegado para el usuario de API.
 * NO imprime valores (solo si vino un valor), para no exponer datos del cliente.
 * Se elimina despues de usarlo.
 */
import { cargarEnv, configFactura } from './src/config.js';
import { crearClienteVtiger } from './src/connectors/vtiger_webservice.js';

cargarEnv('.env');
const cfg = configFactura();
const vt = crearClienteVtiger({ url: cfg.vtiger.url, username: cfg.vtiger.username, accessKey: cfg.vtiger.accessKey });

const CONTACTO = '12x2768776';
const ORDEN = '6x2833710';

async function probar(modulo, campo, where) {
  const sql = `SELECT id, ${campo} FROM ${modulo} WHERE ${where} LIMIT 1;`;
  try {
    const filas = await vt.consultar(sql);
    const tieneValor = filas.length > 0 && filas[0][campo] !== undefined && String(filas[0][campo]).trim() !== '';
    return { campo, estado: 'PERMITIDO', conValor: tieneValor ? 'SI' : 'no' };
  } catch (e) {
    const msg = String(e.message || '');
    const tipo = /Permission to access/i.test(msg) ? 'DENEGADO (permiso)'
      : /attribute denied/i.test(msg) ? 'DENEGADO (permiso)'
      : /Syntax|Unexpected/i.test(msg) ? 'NO EXISTE (campo inexistente)'
      : `ERROR: ${msg.slice(0, 60)}`;
    return { campo, estado: tipo, conValor: '-' };
  }
}

const CAMPOS_CONTACTO = [
  'firstname', 'lastname', 'phone', 'mobile', 'homephone', 'email',
  'contact_no', 'cf_994', 'spl_num_compras', 'spl_fecha_ultima_compra',
  'cf_870', 'cf_872', 'cf_876', 'cf_1053', 'cf_1157',
  'mailingstreet', 'mailingcity', 'mailingstate', 'mailingzip', 'mailingcountry'
];

const CAMPOS_ORDEN = [
  'salesorder_no', 'createdtime', 'hdnGrandTotal', 'sostatus', 'contact_id',
  'cf_1057', 'cf_882', 'cf_886', 'cf_1069', 'cf_3156', 'cf_3298', 'quantity',
  'cf_870', 'cf_872', 'cf_876', 'cf_1053', 'cf_1157',
  'cf_2606', 'cf_2713', 'cf_902', 'total'
];

console.log('\n=== CONTACTS (contacto de la orden S-96567) ===');
const resContacto = [];
for (const c of CAMPOS_CONTACTO) resContacto.push(await probar('Contacts', c, `id = '${CONTACTO}'`));
for (const r of resContacto) console.log(`  ${r.campo.padEnd(24)}${r.estado.padEnd(28)}valor: ${r.conValor}`);

console.log('\n=== SALESORDER (orden S-96567) ===');
const resOrden = [];
for (const c of CAMPOS_ORDEN) resOrden.push(await probar('SalesOrder', c, `id = '${ORDEN}'`));
for (const r of resOrden) console.log(`  ${r.campo.padEnd(24)}${r.estado.padEnd(28)}valor: ${r.conValor}`);

const denegados = [...resContacto, ...resOrden].filter(r => r.estado.startsWith('DENEGADO')).map(r => r.campo);
console.log(`\nRESUMEN: ${denegados.length} campo(s) denegados -> ${denegados.join(', ') || 'ninguno'}`);

// Direccion de envio tal como la ve el motor (desde la ORDEN, que si la permite)
console.log('\n=== DIRECCION DE ENVIO EN LA ORDEN (SalesOrder) ===');
try {
  const filas = await vt.consultar(`SELECT id, cf_870, cf_872, cf_876, cf_1053 FROM SalesOrder WHERE id = '${ORDEN}' LIMIT 1;`);
  if (filas.length) {
    const o = filas[0];
    console.log(`  cf_870 (direccion) : ${o.cf_870 || '(vacio)'}`);
    console.log(`  cf_872 (zip)       : ${o.cf_872 || '(vacio)'}`);
    console.log(`  cf_876 (ciudad)    : ${o.cf_876 || '(vacio)'}`);
    console.log(`  cf_1053 (estado)   : ${o.cf_1053 || '(vacio)'}`);
  }
} catch (e) {
  console.log(`  [FALLA] ${e.message}`);
}
vt.cerrar?.();
