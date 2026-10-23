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

// Verificacion del invoice contra vTiger
export { compararInvoiceConVtiger, formatearVerificacion } from './core/invoice_verify.js';

// Pipeline de compra (traza por etapa para el monitor por sede)
export {
  ETAPAS_PIPELINE, ETAPAS_FALLO, indiceEtapa,
  registrarPipeline, leerPipeline, ultimoEstadoPorOrden,
  resumenPipeline, atascadas, formatearResumen
} from './core/pipeline.js';

// Día Operativo y entendimiento calendario
export {
  obtenerDiaOperativo, perteneceAlDiaOperativo,
  clausulaSqlDiaOperativo, verificarCambioDia,
  ZONA_HORARIA_DEFECTO, DIAS_SEMANA, MESES_ANIO
} from './core/dia_operativo.js';

// Sedes de atención al cliente
export {
  obtenerAtencionSede, SEDES_ATENCION
} from './core/sedes.js';

// Enlaces cortos de marca propia (facturas.labnaturales.com)
export {
  guardarEnlaceFactura, cargarEnlaces,
  resolverDestinoFactura, construirUrlBranded
} from './core/short_links.js';

// Validador de enlaces pre-flight
export {
  verificarEnlaceSincronizado, esperarEnCola
} from './core/link_validator.js';

// Reportes diarios
export {
  generarReporteDiario
} from './core/daily_report.js';

