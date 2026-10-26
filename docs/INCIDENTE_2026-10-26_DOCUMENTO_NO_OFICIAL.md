# Incidente 2026-10-26 — Envío de SMS con documento NO oficial

- **Severidad:** Alta (comunicación masiva a clientes con documento no oficial)
- **Estado:** contenido en código; remediación de enlaces preparada y pendiente de ejecución
- **Commit base:** `2d33263` (endurecimiento inicial) + parches de esta sesión (sin commit aún)
- **Documento afectado:** PDF generado con la plantilla propia (`pdfkit`), no el ExportPDF de vTiger

---

## 1. Qué pasó

Entre las **11:37 y 12:39 (America/Lima) del 26/10/2026** se enviaron **77 SMS** a clientes con un enlace a un PDF **generado por el motor** (plantilla PDFKit), no al documento oficial de vTiger.

El script `scripts/despachar_hoy_26.js` hacía exactamente esto:

```js
// línea 114 (texto engañoso: decía "PDF oficial")
console.log(`  -> Generando PDF oficial con PDFKit para ${ord.numeroOrden}...`);
const resPdf = await generarFacturaPdf({ orden: ord, contacto: contactoDoc, empresa: EMPRESA_POR_DEFECTO, modo: 'etiqueta' });
...
const resSms = await enviarMensajeFacturaGhl({ contactId, mensaje: textoSms, ... }); // SMS directo, sin workflow
```

Es decir: **generaba el documento, lo subía a la Media Library y enviaba el SMS por API**, saltándose por completo el publicador oficial y el workflow de GHL.

### Prueba documental (texto extraído de los PDFs publicados)

| Orden | Documento | Evidencia |
|---|---|---|
| `S-97530` | ❌ Plantilla propia | 1 página · `LN Laboratorios Naturales INVOICE No. S-97530` · columnas `Pos / Cantidad / Text / Total` · `TERMS AND CONDITIONS` |
| `S-97616` | ❌ Plantilla propia | 1 página · `INVOICE No. S-97616` · `Total (USD)` |
| `S-97782` | ❌ Plantilla propia | 1 página · `INVOICE No. S-97782` · publicado 16:37:09Z (6 s antes del SMS) |
| `S-97589` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97589` · códigos `PDT313…` · `total general:(in $) 210.00` · `Condiciones Generales` |
| `S-97557` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97557` · `total neto 150.00` |
| `S-97555` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97555` |
| `S-97590` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97590` |
| `S-97612` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97612` |
| `S-97618` | ✅ Oficial vTiger | 2 páginas · `Órdenes de venta: S-97618` |

> Los importes de la plantilla provienen de `hdnGrandTotal` de vTiger, por lo que **las cifras coinciden con la orden**; lo que no era oficial es el **documento** (formato, códigos de producto, validez comercial).

---

## 2. Alcance real

| Métrica | Valor |
|---|---|
| SMS totales en el histórico | **145** |
| SMS con documento **no oficial** | **77** |
| SMS con documento oficial | **68** |
| Contactos afectados (únicos) | **77** (77 teléfonos distintos) |
| Ventana del incidente | 26/10/2026 11:37 → 12:39 (Lima) |
| Orden afectada más antigua / reciente | `S-97782` … `S-97616` |

Las 77 órdenes corresponden a los enlaces introducidos por el commit `760b523`; las 68 restantes usaron enlaces de commits anteriores, verificados como oficiales por muestreo.

**Lista nominal:** [`scratch/afectados_77.csv`](../scratch/afectados_77.csv) — `orden, telefono, nombre, sede, fecha_sms, msg_id, documento`.

Los envíos del 22 y 23 de octubre (68 SMS) salieron con el **PDF oficial** de vTiger: no requieren corrección documental.

---

## 3. Causa raíz

1. **Scripts de despacho fuera de gobernanza.** `despachar_22_hoy.js`, `despachar_rezagadas_21_22.js` y `despachar_hoy_26.js` generaban el PDF ellos mismos y llamaban al SMS directo, sin pasar por `entregarFacturaDeOrden`.
2. **Etiqueta engañosa.** El log decía "PDF oficial con PDFKit": quien supervisaba no podía distinguir el documento propio del oficial.
3. **Pre-flight insuficiente.** El candado `verificarEnlaceSincronizado` solo comprobaba que el enlace devolviera *un* PDF, no que fuera el oficial.
4. **Respaldo peligroso.** El publicador aceptaba un PDF sin marca de origen (`oficial`), por lo que un "fallback" podía publicarse y marcar el contacto → el workflow de GHL enviaba el documento equivocado.
5. **Defecto crítico: ExportPDF recibía el identificador equivocado.** vTiger devuelve el CRMID como `6x2855909`, pero la acción `ExportPDF` exige el número puro (`2855909`). Con el prefijo responde `{"success":false,"error":{"code":"El registro al que pretende acceder no existe"}}`. **La descarga del PDF oficial nunca funcionó**, así que el sistema caía siempre en la plantilla propia. Corregido con `normalizarRecordExportPdf()` y verificado: las órdenes `S-97782`, `S-97530` y `S-97616` ya descargan ~1 MB de PDF oficial cada una.

---

## 4. Contención aplicada en esta sesión (código, sin commit)

| Archivo | Cambio |
|---|---|
| `src/core/invoice_delivery.js` | **Candado default-deny**: si `pdf.oficial !== true` se rechaza con `PDF_NO_OFICIAL` **antes** de subir y antes de marcar el contacto. Nuevo motivo y paso `pdf_no_oficial`. |
| `src/connectors/ghl_messages.js` | **SMS directo prohibido en Render**: si `RENDER=true` y no hay `INVOICE_ALLOW_DIRECT_SMS=true`, bloquea y audita `INVOICE_SMS_BLOQUEADO_GOBERNANZA`. |
| `src/config.js` | `INVOICE_PDF_FALLBACK_PROPIO` pasa a **default `false`** y queda marcado como deprecado. |
| `src/connectors/vtiger_web_session.js` | **Fix de raíz**: `normalizarRecordExportPdf()` convierte `6x2855909` → `2855909` en `descargarDocumentoOficial`, `descargarPdf` y `descargarPdfAuto`. Sin esto el ExportPDF siempre fallaba. |
| `src/webhook_server.js` | `/salud` expone `commit` y `branch` (`RENDER_GIT_COMMIT`); `PDF_NO_OFICIAL` se trata como fallo temporal (503, reintentable). |
| `tests/test_invoice_delivery.js` | Nuevo **TEST 11**: un PDF no oficial no se sube ni se marca. Suite: **44 PASS / 0 FAIL**. |
| `scripts/remediar_documentos_oficiales.js` | Script de corrección: descarga el ExportPDF oficial, lo sube, **reemplaza el enlace ya enviado** y lo registra en Render. |

Los tres scripts de despacho ya estaban bloqueados en `2d33263` con un `throw` en la primera línea.

---

## 5. Remediación (por qué no hace falta reenviar 77 SMS)

El SMS enviado apunta a `https://facturas.labnaturales.com/<orden>`. Ese enlace es un **redirector** que resuelve contra `data/links.json` + el Render vivo.

Si se reemplaza el destino del enlace por el PDF oficial:
- el cliente que **abra el SMS que ya recibió** obtiene el documento oficial;
- no se envía ningún mensaje nuevo;
- no se duplica ninguna comunicación.

### Pasos

```bash
# 0) Verificar credenciales y sesión web de vTiger (modo simulación: descarga pero NO escribe)
node scripts/remediar_documentos_oficiales.js

# 1) Aplicar: sube el oficial y reemplaza cada enlace
node scripts/remediar_documentos_oficiales.js --aplicar

# 2) (Opcional, requiere tu aprobación) aviso correctivo por SMS
node scripts/remediar_documentos_oficiales.js --aplicar --sms

# 3) Versionar los enlaces corregidos
git add data/links.json
git commit -m "fix(incidente): reemplazar PDFs no oficiales por el ExportPDF oficial"
```

El script **nunca genera PDFs**: solo acepta el que devuelve `ExportPDF` de vTiger, valida `%PDF` y tamaño mínimo, y escribe un reporte en `scratch/remediacion_<fecha>.json`.

---

## 6. Verificación de la conexión GHL ↔ vTiger

| Eslabón | Evidencia | Estado |
|---|---|---|
| GHL (envío) | 145 SMS con `MsgId` real devuelto por la API | ✅ Operativo |
| GHL (Media Library) | PDFs subidos y servidos por `assets.cdn.filesafe.space` | ✅ Operativo |
| vTiger (ExportPDF) | PDFs oficiales de 2 páginas para S-97555/57/89/90/97612/97618 | ✅ Funcionó el 22–23 oct |
| vTiger (sesión web) | Login correcto; el ExportPDF fallaba por el CRMID con prefijo `6x` | ✅ Corregido y verificado (3 órdenes, ~1 MB c/u) |

**El bloqueo ya está resuelto**: no era la contraseña (el login funciona), era el formato del CRMID. El modo simulación descarga el PDF oficial de las 3 órdenes de prueba; queda ejecutar la remediación completa.

---

## 7. Pendientes y riesgos residuales

| # | Acción | Responsable |
|---|---|---|
| 1 | Confirmar que Render desplegó `895cf78`/siguiente — revisar `https://facturas.labnaturales.com/salud` (ya expone `commit`) | Usuario |
| 2 | Ejecutar remediación `--aplicar` sobre las 77 órdenes y commitear `links.json` | Usuario / agente |
| 3 | Decidir si se envía el SMS correctivo (requiere aprobación explícita) | Usuario |
| 4 | Purgar de la Media Library los 77 PDFs no oficiales (siguen accesibles por UUID directo) | Usuario |
| 5 | Revisar `data/RENDER_ENV.txt` (obsoleto, con `VTIGER_WEB_PASSWORD` distinto) y retirarlo | Usuario |

### Invariantes de gobernanza que ahora deben cumplirse siempre

1. Solo se publica el PDF que devuelve `ExportPDF` de vTiger (`oficial === true`).
2. Nunca se genera un PDF local en el camino de producción.
3. Nunca se envía SMS directo desde Render; el envío vive en el workflow de GHL.
4. Ningún script puede saltarse `entregarFacturaDeOrden`.
5. Un PDF sin prueba de origen oficial se rechaza por defecto.
