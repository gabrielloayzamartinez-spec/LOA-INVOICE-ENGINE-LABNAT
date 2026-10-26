#!/usr/bin/env node
/**
 * ==============================================================================
 * LOA INVOICE ENGINE - REMEDIACION DE DOCUMENTOS NO OFICIALES
 * ==============================================================================
 * INCIDENTE 2026-10-26: el despacho masivo subio a la Media Library PDFs
 * generados con la plantilla propia (PDFKit) y envio el SMS con esos enlaces.
 *
 * Este script NO genera ningun PDF. Para cada orden afectada:
 *   1. Localiza el registro en vTiger (SalesOrder).
 *   2. Descarga el PDF OFICIAL con la accion ExportPDF (sesion web).
 *   3. Lo sube a la Media Library de GHL.
 *   4. Reemplaza el destino del enlace corto en data/links.json.
 *   5. Lo registra en el Render vivo (/enlace/registrar) para que el enlace
 *      que ya recibieron los clientes sirva AHORA el documento oficial.
 *   6. Verifica que el enlace entregue un PDF.
 *
 * El SMS correctivo es OPCIONAL y requiere autorizacion explicita (--sms).
 *
 * USO:
 *   node scripts/remediar_documentos_oficiales.js                 # simulacion
 *   node scripts/remediar_documentos_oficiales.js --aplicar       # corrige
 *   node scripts/remediar_documentos_oficiales.js --aplicar --sms # + aviso
 *   node scripts/remediar_documentos_oficiales.js --ordenes=S-97782,S-97783 --aplicar
 *
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import { cargarEnv, configFactura, validarConfig } from '../src/config.js';
import { crearClienteVtiger } from '../src/connectors/vtiger_webservice.js';
import { crearClienteSesionWeb, esPdf } from '../src/connectors/vtiger_web_session.js';
import { subirPdfAMediaLibrary } from '../src/connectors/ghl_media.js';
import { guardarEnlaceFactura } from '../src/core/short_links.js';
import { verificarEnlaceSincronizado } from '../src/core/link_validator.js';
import { enviarMensajeFacturaGhl, construirTextoMensaje } from '../src/connectors/ghl_messages.js';
import { recordAuditEvent } from '../src/core/audit.js';

cargarEnv();
const cfg = configFactura();

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const valor = (n, porDefecto) => {
  const p = argv.find(a => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : porDefecto;
};

const APLICAR = flag('aplicar');
const ENVIAR_SMS = flag('sms');
const ARCHIVO = valor('archivo', 'scratch/afectados_77.csv');
const SOLO = valor('ordenes', '');
const PAUSA_MS = Number(valor('pausa', '2000'));

const PLANTILLA_CORRECCION =
  'Hola {nombreCompleto}, te compartimos nuevamente tu factura OFICIAL de Laboratorios Naturales: {urlPdf}\n' +
  'Si ya la habias descargado, por favor usa este documento. Disculpa las molestias. Atencion: {telefonoAtencion}.';

const headersGhl = {
  Authorization: `Bearer ${cfg.ghl.apiKeyCentral}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
  Accept: 'application/json'
};

function leerOrdenes() {
  if (SOLO) return SOLO.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    .map(orden => ({ orden, telefono: null }));

  if (!fs.existsSync(ARCHIVO)) {
    throw new Error(`No existe el archivo de afectados: ${ARCHIVO}`);
  }
  const lineas = fs.readFileSync(ARCHIVO, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const vistos = new Set();
  const filas = [];
  for (const linea of lineas) {
    // Acepta CSV ("orden",ts,...) o una orden por linea.
    const mOrden = /^"?([A-Za-z0-9\-]+)"?,/.exec(linea) || /^([A-Za-z0-9\-]+)$/.exec(linea);
    if (!mOrden || !/^S-\d+$/i.test(mOrden[1])) continue;
    const orden = mOrden[1].toUpperCase();
    if (vistos.has(orden)) continue;
    vistos.add(orden);
    // El telefono viaja en la columna `mensaje`: "(+17027210531)".
    const mTel = /\+?\d{8,15}/.exec(linea.replace(/^[^,]*,/, ''));
    filas.push({ orden, telefono: mTel ? mTel[0] : null });
  }
  return filas;
}

/** vTiger: record id a partir del numero de orden. */
async function resolverRecord(clienteVtiger, numeroOrden) {
  const seguro = String(numeroOrden).replace(/[^A-Za-z0-9\-]/g, '');
  const filas = await clienteVtiger.consultar(
    `SELECT id, salesorder_no FROM SalesOrder WHERE salesorder_no = '${seguro}' LIMIT 1`
  );
  if (!Array.isArray(filas) || !filas.length) return { ok: false, motivo: 'ORDEN_NO_ENCONTRADA' };
  return { ok: true, id: String(filas[0].id), numeroOrden: String(filas[0].salesorder_no || numeroOrden) };
}

/** GHL: contacto por telefono (para el aviso opcional). */
function normalizarTelefono(tel = '') {
  const digitos = String(tel || '').replace(/\D+/g, '');
  if (!digitos) return '';
  if (digitos.length === 10) return `+1${digitos}`;
  if (digitos.length === 11 && digitos.startsWith('1')) return `+${digitos}`;
  return `+${digitos}`;
}

async function buscarContactoPorTelefono(telefono) {
  const numero = normalizarTelefono(telefono);
  if (!numero) return null;
  const url = `${cfg.ghl.baseUrl}/contacts/?locationId=${encodeURIComponent(cfg.ghl.locationIdCentral)}&query=${encodeURIComponent(numero)}`;
  try {
    const res = await fetch(url, { headers: headersGhl });
    if (!res.ok) return null;
    const cuerpo = await res.json().catch(() => null);
    const contactos = cuerpo?.contacts || [];
    return contactos.length ? contactos[0] : null;
  } catch {
    return null;
  }
}

/** Registra el enlace en el Render vivo para que el SMS ya enviado apunte al PDF oficial. */
async function registrarEnRender(numeroOrden, urlDestino) {
  const objetivo = `${cfg.marca.dominio}/enlace/registrar`;
  try {
    const res = await fetch(objetivo, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loa-token': cfg.webhook.token },
      body: JSON.stringify({ numeroOrden, urlDestino })
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, detalle: e.message };
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log(' REMEDIACION DE DOCUMENTOS NO OFICIALES -> PDF OFICIAL DE VTIGER');
  console.log('='.repeat(80));
  console.log(` Modo          : ${APLICAR ? 'APLICAR (escribe en GHL + Render)' : 'SIMULACION (no escribe nada)'}`);
  console.log(` Aviso SMS     : ${ENVIAR_SMS ? 'SI (autorizado)' : 'NO'}`);
  console.log(` Origen lista  : ${SOLO ? '--ordenes' : ARCHIVO}`);
  console.log('='.repeat(80) + '\n');

  const validacion = validarConfig(cfg, { webservice: true, sesionWeb: true, ghl: true, webhook: true });
  if (!validacion.ok) {
    console.error(`[STOP] Faltan variables: ${validacion.faltantes.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const ordenes = leerOrdenes();
  if (!ordenes.length) {
    console.error('[STOP] No hay ordenes que remediar.');
    process.exitCode = 1;
    return;
  }
  console.log(`Ordenes a procesar: ${ordenes.length}\n`);

  const vt = crearClienteVtiger(cfg.vtiger);
  const clienteWeb = crearClienteSesionWeb();

  const resultados = [];
  const marca = Date.now();

  for (let i = 0; i < ordenes.length; i++) {
    const orden = ordenes[i].orden;
    const cabecera = `[${i + 1}/${ordenes.length}] ${orden}`;
    const registro = { orden, telefono: ordenes[i].telefono, ts: new Date().toISOString(), ok: false, motivo: null, urlOficial: null, enlace: null, sms: null };

    try {
      const rec = await resolverRecord(vt, orden);
      if (!rec.ok) {
        registro.motivo = rec.motivo;
        console.log(`${cabecera} -> ${rec.motivo}`);
        resultados.push(registro);
        continue;
      }

      const pdf = await clienteWeb.descargarDocumentoOficial({
        record: rec.id,
        modulo: 'SalesOrder',
        app: cfg.pdf.app || 'MARKETING'
      });

      if (!pdf.ok || !pdf.buf || !esPdf(pdf.buf) || pdf.buf.length < 1000) {
        registro.motivo = pdf.motivo || 'PDF_OFICIAL_INVALIDO';
        registro.detalle = pdf.detalle || null;
        console.log(`${cabecera} -> FALLO OFICIAL: ${registro.motivo}${pdf.detalle ? ` | ${String(pdf.detalle).slice(0, 160)}` : ''}`);
        resultados.push(registro);
        continue;
      }

      const urlBranded = `${cfg.marca.dominio}/${encodeURIComponent(orden)}`;
      registro.enlace = urlBranded;

      if (!APLICAR) {
        registro.ok = true;
        registro.motivo = 'SIMULACION_OK';
        console.log(`${cabecera} -> PDF oficial obtenido (${pdf.buf.length} bytes). Reemplazaria el enlace ${urlBranded}`);
        resultados.push(registro);
        continue;
      }

      const subida = await subirPdfAMediaLibrary({
        locationId: cfg.ghl.locationIdCentral,
        nombreArchivo: `Factura_Oficial_${orden}.pdf`,
        contenido: pdf.buf,
        apiKey: cfg.ghl.apiKeyCentral
      });

      if (!subida.ok || !subida.url) {
        registro.motivo = `SUBIDA_FALLIDA:${subida.motivo || 'SIN_URL'}`;
        console.log(`${cabecera} -> fallo de subida (${registro.motivo})`);
        resultados.push(registro);
        continue;
      }

      guardarEnlaceFactura({
        numeroOrden: orden,
        urlDestino: subida.url,
        ruta: cfg.marca.linksPath || 'data/links.json'
      });

      const enRender = await registrarEnRender(orden, subida.url);
      await new Promise(r => setTimeout(r, 1500));
      const verif = await verificarEnlaceSincronizado(urlBranded);

      registro.ok = verif.sincronizado;
      registro.urlOficial = subida.url;
      registro.motivo = verif.sincronizado ? 'REEMPLAZADO' : 'ENLACE_NO_VERIFICADO';
      console.log(
        `${cabecera} -> PDF oficial ${pdf.buf.length} bytes | Render: ${enRender.ok ? 'OK' : 'FALLO'} | ` +
        `enlace: ${verif.sincronizado ? 'VERIFICADO' : verif.detalle}`
      );

      if (ENVIAR_SMS) {
        const contacto = await buscarContactoPorTelefono(registro.telefono || '');
        if (!contacto?.id) {
          registro.sms = 'CONTACTO_NO_ENCONTRADO';
        } else {
          const texto = construirTextoMensaje({
            nombreCompleto: contacto.name || [contacto.firstName, contacto.lastName].filter(Boolean).join(' '),
            numeroOrden: orden,
            urlPdf: urlBranded,
            plantilla: PLANTILLA_CORRECCION
          });
          const envio = await enviarMensajeFacturaGhl({
            contactId: contacto.id,
            mensaje: texto,
            apiKey: cfg.ghl.apiKeyCentral,
            tipo: 'SMS',
            validarEnlace: true,
            urlAValidar: urlBranded
          });
          registro.sms = envio.ok ? `ENVIADO:${envio.messageId}` : `FALLO:${envio.motivo}`;
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      recordAuditEvent({
        type: 'INVOICE_REMEDIACION_DOCUMENTO_OFICIAL',
        severity: 'info',
        message: `Enlace ${orden} reemplazado por el PDF oficial de vTiger (${subida.url}).`
      });
    } catch (e) {
      registro.motivo = `EXCEPCION:${e.message}`;
      console.log(`${cabecera} -> excepcion: ${e.message}`);
    }

    resultados.push(registro);
    if (i < ordenes.length - 1) await new Promise(r => setTimeout(r, PAUSA_MS));
  }

  const ok = resultados.filter(r => r.ok).length;
  const fallos = resultados.length - ok;
  const dir = path.resolve('scratch');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const salida = path.join(dir, `remediacion_${new Date(marca).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(salida, JSON.stringify({ modo: APLICAR ? 'aplicar' : 'simulacion', total: resultados.length, ok, fallos, resultados }, null, 2), 'utf8');

  console.log('\n' + '='.repeat(80));
  console.log(` RESUMEN: ${ok} OK / ${fallos} fallos sobre ${resultados.length}`);
  console.log(` Reporte: ${salida}`);
  console.log('='.repeat(80));
  console.log('\nSiguiente paso recomendado: revisar y versionar data/links.json con los enlaces oficiales.');
  console.log('  git add data/links.json && git commit -m "fix(incidente): reemplazar PDFs no oficiales por el ExportPDF oficial"\n');

  if (fallos > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[ERROR FATAL] ${e.message}`);
  process.exitCode = 1;
});
