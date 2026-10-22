/**
 * ==============================================================================
 * LOA INVOICE ENGINE - VALIDADOR DE ENLACE Y DOCUMENTO SINCRONIZADO
 * ==============================================================================
 * CANDADO DE CALIDAD ESTRICTO: NINGUN mensaje de SMS o WhatsApp puede enviarse
 * si el enlace que viaja en el texto no ha sido fisicamente comprobado por HTTP.
 *
 * VALIDACIONES OBLIGATORIAS:
 *   1. El enlace responde HTTP 302 o 200 (nunca 404 ni 500).
 *   2. Si redirige (302/301), el destino final responde HTTP 200.
 *   3. La respuesta final NO es la pantalla de error 404 HTML.
 *   4. El documento es un PDF real (content-type application/pdf o cabecera %PDF).
 *
 * Si cualquiera de estos puntos falla, el envio SE BLOQUEA y la orden queda
 * en cola con motivo explícito: DOCUMENTO_NO_SINCRONIZADO.
 * ==============================================================================
 */

import https from 'node:https';
import http from 'node:http';

/**
 * Realiza una peticion HTTP/HTTPS siguiendo redirecciones para verificar
 * que un enlace este completamente sincronizado y entregando el PDF.
 *
 * @param {string} url - URL del enlace a validar (ej: https://facturas.labnaturales.com/S-97587)
 * @param {object} [opciones]
 * @param {number} [opciones.timeoutMs=10000]
 * @param {number} [opciones.maxRedirecciones=5]
 * @returns {Promise<{sincronizado: boolean, status: number, urlFinal: string, esPdf: boolean, detalle: string|null}>}
 */
export async function verificarEnlaceSincronizado(url = '', { timeoutMs = 10000, maxRedirecciones = 5 } = {}) {
  const urlLimpia = String(url || '').trim();
  if (!urlLimpia || (!urlLimpia.startsWith('http://') && !urlLimpia.startsWith('https://'))) {
    return {
      sincronizado: false,
      status: 0,
      urlFinal: urlLimpia,
      esPdf: false,
      detalle: 'URL_INVALIDA_O_VACIA'
    };
  }

  let actualUrl = urlLimpia;
  let saltos = 0;

  while (saltos < maxRedirecciones) {
    try {
      const res = await realizarPeticion(actualUrl, timeoutMs);
      
      // Si es redireccion (301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const destino = new URL(res.headers.location, actualUrl).toString();
        actualUrl = destino;
        saltos++;
        continue;
      }

      // Si responde 200
      if (res.statusCode === 200) {
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        const esPdfPorHeader = contentType.includes('application/pdf') || contentType.includes('application/octet-stream');
        const cuerpoInicio = res.cuerpoInicio ? res.cuerpoInicio.toString('utf8', 0, 100) : '';
        const esPdfPorBuffer = cuerpoInicio.startsWith('%PDF');
        const esErrorHtml = cuerpoInicio.includes('Factura no disponible') || cuerpoInicio.includes('no se encuentra disponible');

        if (esErrorHtml) {
          return {
            sincronizado: false,
            status: 404,
            urlFinal: actualUrl,
            esPdf: false,
            detalle: 'DOCUMENTO_EN_PROCESAMIENTO_O_NO_DISPONIBLE_404'
          };
        }

        const esDocumentoPdf = esPdfPorHeader || esPdfPorBuffer || actualUrl.toLowerCase().endsWith('.pdf');

        return {
          sincronizado: esDocumentoPdf,
          status: 200,
          urlFinal: actualUrl,
          esPdf: esDocumentoPdf,
          detalle: esDocumentoPdf ? null : 'RESPUESTA_200_PERO_NO_ES_PDF'
        };
      }

      // Si responde cualquier otro codigo (404, 500, etc.)
      return {
        sincronizado: false,
        status: res.statusCode,
        urlFinal: actualUrl,
        esPdf: false,
        detalle: `HTTP_${res.statusCode}`
      };
    } catch (e) {
      return {
        sincronizado: false,
        status: 0,
        urlFinal: actualUrl,
        esPdf: false,
        detalle: `ERROR_RED: ${e.message}`
      };
    }
  }

  return {
    sincronizado: false,
    status: 0,
    urlFinal: actualUrl,
    esPdf: false,
    detalle: 'DEMASIADAS_REDIRECCIONES'
  };
}

function realizarPeticion(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(targetUrl, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'LOA-Invoice-Validator/1.0',
        'Accept': 'application/pdf, text/html, */*'
      }
    }, (res) => {
      const trozos = [];
      let totalBytes = 0;

      res.on('data', chunk => {
        if (totalBytes < 1024) {
          trozos.push(chunk);
          totalBytes += chunk.length;
        }
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          cuerpoInicio: Buffer.concat(trozos)
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TIMEOUT_DE_CONEXION'));
    });

    req.on('error', reject);
  });
}

/**
 * Espera de cola / pacing entre envíos o reintentos de sincronización.
 * @param {number} ms - Milisegundos de espera (ej: 120000 = 2 minutos).
 */
export function esperarEnCola(ms = 2000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
