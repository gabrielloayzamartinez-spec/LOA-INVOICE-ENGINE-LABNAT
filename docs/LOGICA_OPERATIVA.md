# ⚙️ Lógica Operativa — LOA Invoice Engine conectado a GHL (envío por SMS)

**Qué hace:** cuando el personal registra una compra en vTiger y el contacto queda **`VENDIDO`**, el motor genera el PDF del invoice, **lo sube a la Media Library de GHL**, guarda la **URL pública** en el contacto y pone un **tag**; el **workflow de GHL** detecta el tag y **manda el SMS con el enlace**.

**Leyenda:** ✅ verificado contra los sistemas reales · 📘 según código/configuración.

---

## 1. Piezas y credenciales

| Pieza | Rol | Credencial | Estado |
|---|---|---|---|
| **vTiger** (`ventascallcenter.com`) | Fuente de verdad: órdenes y estados | `VTIGER_USERNAME` + `VTIGER_ACCESS_KEY` (API) | ✅ funciona (solo lectura) |
| **LOA Invoice Engine** | Genera el PDF, lo publica y marca el contacto | — | ✅ 13 suites / 456 asserts |
| **GHL Cuenta Empresa** (`ATPYNnsfZ1W8sd6WgWIV`) | Media Library + contactos + campos + workflow | `GHL_API_KEY_CENTRAL` (PIT) | ✅ validado, **subida real HTTP 201** |
| **Workflow GHL** | Envía el SMS | nativo | ⏳ a crear (5 min) |

**Scopes que debe tener el PIT:** `medias.read`, `medias.write`, `contacts.readonly`, `contacts.write`, `locations.readonly`, `customFields.readonly`.

---

## 2. Flujo operativo, paso a paso

```
[1] PERSONAL (vTiger)          Registra la compra; el contacto queda VENDIDO (cf_994)
        │                       y la orden toma numero S-XXXXX
        ▼
[2] DISPARADOR                 Webhook de vTiger  ──┐
                               (o el sync interno)  ├──► POST /evento/compra  (header x-loa-token)
                                                    ┘
        ▼
[3] MOTOR: resuelve la orden   1 consulta a vTiger (id o nº de orden) + direccion de envio (cf_870/872/876/1053)
        ▼
[4] MOTOR: resuelve el contacto   por telefono (lookup en GHL) o por el contactId del evento
        ▼
[5] MOTOR: corta si ya esta      lee `Factura Nº Orden` del contacto → si coincide, NO hace nada
        ▼
[6] MOTOR: GENERA EL PDF         plantilla propia (A4 horizontal, cabecera, bloques, tabla, total, terminos)
        ▼
[7] MOTOR: SUBE EL PDF           POST /medias/upload-file (multipart) → devuelve { fileId, url }
        ▼
[8] MOTOR: ESCRIBE EL PUENTE     PUT /contacts/:id  → `URL Factura PDF`, `Factura Nº Orden`
                                 POST /contacts/:id/tags → FACTURA_LISTA
        ▼
[9] GHL: WORKFLOW                Trigger "Tag Added = FACTURA_LISTA" → filtro URL no vacia → Send SMS
        ▼
[10] CLIENTE                     Recibe el SMS y abre el enlace  →  ve/descarga/imprime su invoice
        ▼
[11] GHL: CIERRE                 +FACTURA_ENVIADA, −FACTURA_LISTA
```

**Tiempo total:** segundos (del evento al SMS), salvo la cola de envío de GHL.

---

## 3. Cómo el PDF se vuelve un ENLACE (el mecanismo exacto)

**No se adjunta el archivo: se publica y se envía el enlace.** ✅ Verificado contra la cuenta real:

```
POST https://services.leadconnectorhq.com/medias/upload-file?locationId=ATPYNnsfZ1W8sd6WgWIV
Headers: Authorization: Bearer <PIT>   Version: 2021-07-28
Body:    multipart/form-data
           file = <bytes del PDF>   (nombre: INVOICE_S-96567.pdf)
           name = INVOICE_S-96567.pdf

Respuesta HTTP 201:
{
  "fileId": "6ac9629a89da6e6f9be330bb",
  "url": "https://assets.cdn.filesafe.space/ATPYNnsfZ1W8sd6WgWIV/media/094e0a9a-....pdf"
}
```

Esa **`url` es el enlace** que viaja en el SMS. Detalles que importan:

- El nombre del archivo **debe** ir en el multipart: si falta, GHL lo guarda como `blob` y el enlace no dice nada al cliente.
- La URL es pública (CDN de GHL): el cliente la abre sin login, y el workflow puede referenciarla.
- Límite de payload del endpoint de eventos: 64 KB (el invoice pesa ~2,5 KB).
- Si la subida falla (`401` token, `403` scope, `5xx`), el motor **no marca el contacto** y el evento responde `503` → el emisor reintenta.

---

## 4. El "puente" en el contacto (lo que el workflow consume)

| Elemento en GHL | Valor | Rol |
|---|---|---|
| Campo personalizado `URL Factura PDF` | la URL del punto 3 | Lo que el SMS envía |
| Campo personalizado `Factura Nº Orden` | p. ej. `S-96567` | **Idempotencia**: si ya está, no se republica |
| Tag `FACTURA_LISTA` | — | **Dispara** el workflow |
| Tag `FACTURA_ENVIADA` | — | Cierre: evita reenvíos |

**Los dos campos se resuelven por NOMBRE** (no hay IDs hardcodeados): si el nombre no coincide exactamente, el flujo se detiene en lugar de escribir en un campo equivocado.

---

## 5. Disparador: cómo avisa vTiger (dos vías, elegir una)

### Vía A — Webhook desde un Workflow de vTiger
1. CRM Settings → **Automation → Workflow** → nuevo workflow sobre **Contacts**.
2. Condición: *Estado de Venta* `cf_994` **es** `VENDIDO`.
3. Acción: **Webhook** → `POST https://<tu-motor>/evento/compra`
   - Header: `x-loa-token: <INVOICE_WEBHOOK_TOKEN>`
   - Body JSON: `{ "salesorder_id": "<id de la orden>", "contact_id": "<id del contacto>" }`
4. Guardar y probar (el endpoint responde `200` publicado / `422` faltan datos / `503` reintentar).

### Vía B — Enganche al sync que ya existe
El motor LOA que sincroniza vTiger por `last_modified_time` llama a `atenderEventoCompra(payload)` cuando detecta el cambio a `VENDIDO`. **No se toca vTiger.**

### Modo recuperación (si el motor estuvo caído)
`node src/cli.js once` → un barrido puntual. No es el flujo normal.

---

## 6. EL WORKFLOW EN GHL (paso a paso)

**Antes:** crear los dos campos personalizados (Settings → Custom Fields → Contact):
- `URL Factura PDF` (tipo: texto de una línea)
- `Factura Nº Orden` (tipo: texto de una línea)

**Workflow:**
1. **Trigger:** `Contact Tag` → *Tag Added* → `FACTURA_LISTA`.
2. **Filter:** `URL Factura PDF` → *is not empty*.
3. **Action → Send SMS:**
   > {{contact.first_name}}, tu compra quedó registrada. Aquí puedes ver y descargar tu factura:
   > {{contact.url_factura_pdf}}
   > Cualquier duda, respóndenos por aquí. — Laboratorios Naturales
4. **Action → Add Tag:** `FACTURA_ENVIADA`
5. **Action → Remove Tag:** `FACTURA_LISTA`
6. **Settings:** ventana L-V 07:00-22:00 / S-D 10:00-16:00; reintento 1 vez a la hora si falla.

> ⚠️ **Verificar antes de activar:** que la Cuenta Empresa tenga un **número de SMS habilitado** (Settings → Phone Numbers). Sin número, el workflow no puede enviar. Es el único punto que no se puede comprobar por API.

> ⚠️ **Discreción:** el SMS no debe nombrar el tratamiento ni el producto. Solo factura + enlace.

---

## 7. Puesta en marcha (checklist)

- [ ] `.env` del motor con: `VTIGER_*`, `GHL_API_KEY_CENTRAL`, `GHL_LOCATION_ID_CENTRAL`, `INVOICE_WEBHOOK_TOKEN`.
- [ ] `node src/cli.js check` → **Configuración COMPLETA**, **Media Library ACCESIBLE**, **vTiger OK**.
- [ ] `node src/cli.js verificar --numero=S-XXXXX` → revisar la tabla campo por campo contra vTiger.
- [ ] `node src/cli.js preview --record=<id>` → **ver el PDF** antes de publicar.
- [ ] Campos `URL Factura PDF` y `Factura Nº Orden` creados en GHL.
- [ ] Workflow creado y **en borrador** (sin publicar) hasta la prueba.
- [ ] `INVOICE_PDF_ENABLED=true`.
- [ ] `npm run serve` (endpoint de eventos) **o** el enganche Vía B.
- [ ] Prueba controlada: `node src/cli.js publish --contact=<id> --order=<id>` → revisar URL y que el workflow NO esté publicado.
- [ ] Publicar el workflow → prueba con una compra real de punta a punta.
- [ ] Monitorear `data/logs/audit.jsonl` durante 24 h.

---

## 8. Operación diaria y monitoreo

| Qué mirar | Dónde | Señal de alarma |
|---|---|---|
| Eventos procesados | `data/logs/audit.jsonl` (`INVOICE_EVENTO_PUBLICADO`) | Sin eventos en horas de venta |
| Fallos de subida | `INVOICE_PDF_PUBLICACION_FALLIDA` | `TOKEN_INVALIDO` / `SCOPE_FALTANTE` |
| Fallos de marcado | `INVOICE_PDF_ESCRITURA_FALLIDA` | La URL se publicó pero el contacto no se marcó |
| Eventos rechazados | `INVOICE_WEBHOOK_RECHAZADO` | Token mal configurado en vTiger |
| Salud del endpoint | `GET /salud` | Sin respuesta → motor caído (los eventos se pierden: usar `once`) |

**Comandos útiles:**
```bash
node src/cli.js check                       # estado de todo
node src/cli.js verificar --numero=S-96567  # corroborar contra vTiger
node src/cli.js preview --record=6x2833710  # ver el invoice sin publicar
node src/cli.js publish --contact=X --order=Y  # publicar UNA factura (prueba)
node src/cli.js serve                       # endpoint de eventos (produccion)
node src/cli.js once                        # recuperacion (barrido puntual)
```

---

## 9. Qué pasa si algo falla

| Falla | Respuesta del motor | Se recupera |
|---|---|---|
| vTiger no responde | `ORDEN_NO_ENCONTRADA`; audita; no publica | Sí, reintento del emisor |
| El contacto no está en GHL | `CONTACTO_NO_ENCONTRADO` (`422`) | Sí, cuando el sync lo cree |
| Token/scope de GHL | `MEDIA_NO_DISPONIBLE` (`503`) | Sí, tras corregir el PIT |
| GHL caído | motivo explícito; **nunca lanza** | Sí |
| El SMS no sale | El workflow reintenta 1 vez; el tag queda de traza | Sí |
| El evento llega dos veces | `YA_PUBLICADA` (`200`, sin resubir) | Idempotente por diseño |

---

## 10. Límites explícitos

- **No** se adjunta el PDF al SMS: se envía un **enlace** (el SMS no soporta adjuntos, y así se evitan plantillas de Meta).
- **No** se escribe en vTiger (solo lectura en 3 capas).
- **No** es un comprobante fiscal: es un **invoice comercial**.
- **No** se hace backfill histórico: se publica lo que llega por evento.
