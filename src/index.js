/**
 * ==============================================================================
 * LOA INVOICE ENGINE - API PUBLICA
 * ==============================================================================
 * Punto de entrada unico del motor independiente de facturas.
 * ==============================================================================
 */

// Configuracion
export { cargarEnv, configFactura, validarConfig, resumenConfig, env, envBool, envInt } from './config.js';

// Auditoria
export { recordAuditEvent, leerAuditoria, configurarAuditoria } from './core/audit.js';

// Contrato e idempotencia
export {
  TAG_FACTURA_LISTA, TAG_FACTURA_ENVIADA, CLAVES_PUENTE_FACTURA, MOTIVOS_PUBLICACION,
  decidirPublicacion, construirPuenteFactura, construirCierreEnvio,
  leerEstadoPuenteFactura, nombreArchivoFactura
} from './core/invoice_bridge.js';

// Caso de uso
export { entregarFacturaDeOrden, facturaPdfHabilitada, MOTIVOS_ENTREGA } from './core/invoice_delivery.js';

// Conector con GHL + vTiger
export {
  publicarFacturaDeContacto, crearDepsFactura, resolverCamposPuente, normalizarNombreCampo,
  headersCentral, NOMBRES_CAMPOS_FACTURA,
  leerContactoGhl, escribirCamposPuente, agregarTagsContacto
} from './core/invoice_publisher.js';

// Conectores
export { crearClienteSesionWeb, getVtigerWebConfigStatus, esPdf, assertAccionWebPermitida } from './connectors/vtiger_web_session.js';
export { crearClienteVtiger, assertSentenciaSoloLectura, assertOperacionPermitida, escaparValor } from './connectors/vtiger_webservice.js';
export { subirPdfAMediaLibrary, verificarAccesoMedia, MOTIVOS_MEDIA } from './connectors/ghl_media.js';
export { ghlFetch } from './connectors/ghl_client.js';

// Deteccion de compras nuevas (modo barrido / recuperacion)
export {
  detectarComprasNuevas, cargarCursor, guardarCursor, claveCursor,
  normalizarOrden, ORDEN_SELECT
} from './jobs/detectar_compras_nuevas.js';

// DISPARADOR UNICO por evento (modo recomendado, sin barrido)
export {
  atenderEventoCompra, normalizarEventoCompra, MOTIVOS_EVENTO, ORDEN_SELECT_EVENTO
} from './jobs/atender_evento.js';
export {
  crearServidorEventos, iniciarServidorEventos, codigoHttpParaResultado
} from './webhook_server.js';
