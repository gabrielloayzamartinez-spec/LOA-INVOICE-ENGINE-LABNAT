# Auditoría de sistema y verificación de conexión Render ↔ GitHub

- **Proyecto:** LOA INVOICE ENGINE
- **Repositorio:** `gabrielloayzamartinez-spec/LOA-INVOICE-ENGINE-LABNAT` (público)
- **Commit auditado:** `2d33263` — *fix(governance): desactivar envío directo de SMS y forzar PDF oficial vTiger sin fallback*
- **Fecha de auditoría:** 2026-10-26, 13:40 (America/Lima) / 18:40 UTC
- **Alcance:** estado del repositorio local, sincronía con GitHub, despliegue vivo en Render, coherencia de configuración, seguridad de secretos y suite de pruebas.

---

## 1. Veredicto ejecutivo

| Eslabón | Estado | Sustento |
|---|---|---|
| Local ↔ GitHub | ✅ **Coincidencia exacta** | `HEAD` local = `origin/main` = `main` en GitHub = `2d33263…ac7cc` (SHA completo verificado por API). Árbol limpio, sin stash, sin commits pendientes. |
| GitHub ↔ Render | 🟡 **Parcialmente verificado** | El servicio está vivo y sirve datos de un commit **≥ `760b523`**, pero el commit exacto **no es demostrable desde fuera** porque `/salud` no expone versión y `2d33263` no cambió ninguna superficie HTTP. |
| Salud del servicio | ✅ **Operativo** | `/salud` → `200 {"ok":true,"servicio":"loa-invoice-engine"}` en dominio propio y en host de Render. |
| Redirección de facturas | ✅ **Operativa** | `S-97782` → `302` hacia `assets.cdn.filesafe.space` (PDF oficial). |
| Secretos | ✅ **No filtrados en git** | Búsqueda en `HEAD` y en **todo el historial** (`git log -S`) sin coincidencias. `.env` y `data/*` correctamente ignorados. |
| Suite de pruebas | ✅ **16/18 suites en verde** | `test_cli` y `test_e2e_http` se bloquean solo en el paso que lanza procesos hijos: `EPERM` del sandbox de esta sesión, no defecto de código. |

**Conclusión:** la cadena Local → GitHub está perfectamente sincronizada y el despliegue de Render está **vivo y funcional con código reciente**, pero **falta un mecanismo de trazabilidad commit↔deploy**. Ese es el hallazgo principal de esta auditoría.

---

## 2. Cadena verificada

```
Commit local 2d33263  ──►  GitHub main 2d33263  ──►  Render (autoDeploy)  ──►  facturas.labnaturales.com
   working tree clean        pushed_at 18:31:48Z        loa-invoice-engine-labnat   CNAME → gcp-us-west1-1
```

| Comprobación | Resultado |
|---|---|
| SHA local | `2d3326368b6b5585d0ea9d39cf76e7ce4f2ac7cc` |
| SHA en GitHub (`/commits/main`) | `2d3326368b6b5585d0ea9d39cf76e7ce4f2ac7cc` |
| Rama local / remota | `main` ←→ `origin/main` (sin adelanto ni atraso) |
| Árbol de trabajo | limpio, sin stash, 55 archivos versionados |
| Último push a GitHub | `2026-10-26T18:31:48Z` |
| Dominio público | `https://facturas.labnaturales.com` → `loa-invoice-engine-labnat.onrender.com` → `gcp-us-west1-1.origin.onrender.com` (Oregón, coincide con `region: oregon`) |
| Host de Render directo | `https://loa-invoice-engine-labnat.onrender.com/salud` → `200` |
| `https://loa-invoice-engine.onrender.com/salud` | `404` — el `name` de `render.yaml` **no** coincide con el servicio real |

---

## 3. Prueba de huella del despliegue

Como `/salud` no informa versión, se usó un marcador de datos observable:

1. `data/links.json` tiene **145 entradas**.
2. El commit `760b523` añadió **77 entradas nuevas** (p. ej. `S-97782`).
3. Ese código **no** existe en el mapa estático de `src/core/short_links.js` (que llega hasta `S-97641`), por lo que solo puede resolverse si el despliegue incluye `links.json` de `760b523` o posterior.
4. `https://facturas.labnaturales.com/S-97782` → el servidor responde con `302` a `https://assets.cdn.filesafe.space/…` (verificado; el redirect cross-origin es la prueba de que el servidor vivo lo resolvió).

**Resultado:** el despliegue actual es **≥ `760b523`** (26/10 13:02). No es posible distinguir `760b523` de `2d33263` (26/10 13:31) desde el exterior, porque el último commit solo modificó:

- `render.yaml` (variables de entorno, no observables por HTTP),
- `scripts/despachar_*.js` (añaden `throw` de gobernanza; no se sirven por HTTP),
- `src/core/invoice_publisher.js` (elimina SMS directo y el PDF de respaldo; solo se ejecuta al procesar un evento real).

Dado que `autoDeploy` está activo y el push ocurrió a las 18:31:48Z, lo esperable es que `2d33263` ya esté desplegado, pero **eso es una inferencia, no una verificación**.

---

## 4. Hallazgos

| ID | Severidad | Hallazgo | Impacto | Acción |
|---|---|---|---|---|
| **H1** | 🔴 Alta | **Sin trazabilidad de commit en el despliegue.** `/salud` devuelve solo `ok`, `servicio` y `ts`. | No se puede demostrar qué versión corre en producción ni auditar un rollback. | Exponer `RENDER_GIT_COMMIT` en `/salud` (ver §6). |
| **H2** | 🔴 Alta | **`render.yaml` no describe el servicio real.** `name: loa-invoice-engine` vs servicio `loa-invoice-engine-labnat`. | Si el servicio se creó a mano, los cambios de `envVars` del blueprint **no se aplican** en Render; las variables del panel pueden diferir del repo. | Alinear nombre (renombrar servicio o `render.yaml`) y confirmar si es Blueprint. |
| **H3** | 🔴 Alta | **Rutas de estado sin disco persistente, y disco mal apuntado.** `INVOICE_CURSOR_PATH=data/cursor.json`, `INVOICE_LOG_DIR=data/logs`, `INVOICE_PIPELINE_PATH=data/pipeline.jsonl`, pero el bloque `disks` está comentado y montaría `/var/data`. | En cada deploy se pierden cursor, logs, auditoría y **los enlaces registrados en caliente vía `/enlace/registrar`**; un enlace emitido puede dejar de resolver tras un redeploy. | Activar disco y unificar rutas (`/var/data/...`) **o** aceptar la pérdida y documentarla. |
| **H4** | 🟠 Media | **`data/RENDER_ENV.txt` (10/10/2026) contradice la configuración vigente:** `INVOICE_PDF_ENABLED=false`, `INVOICE_PDF_FALLBACK_PROPIO=true`, `INVOICE_TRIGGER=evento`, `INVOICE_SCAN_SEDE=PALACIOS`, rutas `/var/data/*`. | Copiar/pegar ese archivo en el panel **apagaría el motor** y rompería las rutas. Además contiene credenciales reales en claro. | Eliminarlo o marcarlo obsoleto y mover los secretos a un gestor de contraseñas. |
| **H5** | 🟠 Media | **Divergencia `.env` local vs `render.yaml`:** `INVOICE_TRIGGER=evento` vs `hibrido`; `INVOICE_TRIGGER_STATUS=VERIFICADA` vs `VERIFICADA,ENVIADA`. | Comportamiento distinto entre pruebas locales y producción (escaneo autónomo y estados aceptados). | Documentar cuál es la fuente de verdad y alinear. |
| **H6** | 🟠 Media | **Repositorio público** con 145 URLs de facturas (UUID no adivinables) y todo el código. | Exposición innecesaria de enlaces de clientes; sin secretos, pero superficie de riesgo. | Valorar pasar el repo a privado. |
| **H7** | 🟡 Baja | **Sin CI/CD** (`.github` no existe); el `npm test` local depende de `spawn` con pipes. | Regresiones detectadas solo manualmente; la suite no corre en un entorno limpio. | Añadir workflow de GitHub Actions (`npm ci && npm test`). |
| **H8** | 🟡 Baja | **`/salud` no valida dependencias** (vTiger/GHL); un deploy "verde" puede tener credenciales rotas. | Falsa sensación de salud. | Añadir `/salud?deep=1` con chequeo de configuración (sin llamadas externas). |
| **H9** | 🟡 Baja | **Node local 24 vs Render 20** (`NODE_VERSION=20`, `engines >=20`). | Diferencias sutiles de runtime entre local y producción. | Fijar `.nvmrc`/Volta a 20 o subir Render a 22/24 de forma controlada. |

### Puntos fuertes confirmados

- Historial **sin secretos**: `KkfUOi0vXW4951jm`, `GABRIEL1520`, `8269f7ff…`, `pit-…` no aparecen en ningún commit (`git log --all -S`).
- `.env` y `data/*` correctamente ignorados; `data/links.json` versionado a propósito.
- Gobernanza aplicada en código: se eliminó el envío directo de SMS y el PDF de respaldo; los scripts de despacho quedan bloqueados con `throw`.
- `/salud`, portal raíz y redirecciones responden correctamente en el dominio de marca.
- Región del servicio (Oregón) coincide con `render.yaml`.

---

## 5. Diferencias de configuración

| Variable | `render.yaml` (repo) | `.env` local | `data/RENDER_ENV.txt` (obsoleto) |
|---|---|---|---|
| `INVOICE_PDF_ENABLED` | `true` | `true` | ❌ `false` |
| `INVOICE_PDF_FALLBACK_PROPIO` | `false` | `false` | ❌ `true` |
| `INVOICE_AUTO_SEND_SMS` | `false` | `false` | (ausente) |
| `INVOICE_TRIGGER` | `hibrido` | ⚠️ `evento` | ❌ `evento` |
| `INVOICE_SCAN_SEDE` | `TODAS` | `TODAS` | ❌ `PALACIOS` |
| `INVOICE_TRIGGER_STATUS` | `VERIFICADA,ENVIADA` | ⚠️ `VERIFICADA` | (ausente) |
| `INVOICE_CURSOR_PATH` | `data/cursor.json` | (default) | ❌ `/var/data/cursor.json` |
| `INVOICE_LOG_DIR` | `data/logs` | `data/logs` | ❌ `/var/data/logs` |

---

## 6. Plan de corrección priorizado

### P1 — Cerrar la trazabilidad commit↔deploy (30 min)

Añadir el commit al endpoint de salud (`src/webhook_server.js`). Render inyecta `RENDER_GIT_COMMIT` automáticamente:

```js
if (req.method === 'GET' && url.pathname === '/salud') {
  return responder(200, {
    ok: true,
    servicio: 'loa-invoice-engine',
    commit: process.env.RENDER_GIT_COMMIT || null,
    branch: process.env.RENDER_GIT_BRANCH || null,
    ts: new Date().toISOString()
  });
}
```

Tras el deploy, `GET /salud` debe devolver el SHA corto de `2d33263`. Alternativa inmediata sin tocar código: consultar la API de Render con `RENDER_API_KEY` (no configurada en esta máquina):

```bash
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services?name=loa-invoice-engine-labnat"
# luego: /v1/services/{serviceId}/deploys?limit=1
```

### P2 — Alinear `render.yaml` con el servicio real (15 min)

1. Renombrar en Render el servicio a `loa-invoice-engine`, **o** cambiar `name:` en `render.yaml` a `loa-invoice-engine-labnat`.
2. Confirmar en el panel si el servicio es Blueprint (solo entonces los `envVars` del repo se sincronizan).
3. Verificar en el panel que `INVOICE_PDF_ENABLED=true` y `INVOICE_SCAN_INTERVAL_MINUTES=5` están realmente aplicados (de eso depende el motor autónomo).

### P3 — Persistencia de estado (30 min)

Opciones:
- **A (recomendada):** activar disco y mover rutas a `/var/data/*`:
  ```yaml
  disks:
    - name: loa-invoice-data
      mountPath: /var/data
      sizeGB: 1
  envVars:  # INVOICE_CURSOR_PATH=/var/data/cursor.json, INVOICE_LOG_DIR=/var/data/logs, INVOICE_PIPELINE_PATH=/var/data/pipeline.jsonl
  ```
- **B:** mantener todo efímero y asumir que los enlaces registrados en caliente se pierden en cada deploy (los cubre el mapa estático + `links.json` versionado).

### P4 — Higiene (15 min)

- Retirar/rotar `data/RENDER_ENV.txt`; los secretos ya viven en `.env` y en el panel de Render.
- Alinear `.env` con `render.yaml` (`INVOICE_TRIGGER`, `INVOICE_TRIGGER_STATUS`).
- Valorar repo privado.
- Añadir `.github/workflows/test.yml` con `npm ci && npm test`.

---

## 7. Evidencia de pruebas

Ejecutado en `C:\Users\Lenovo\Desktop\LOA_INVOICE_ENGINE` (Node v24.19.0).

| Suite | Resultado |
|---|---|
| `test_config`, `test_index`, `test_invoice_bridge`, `test_vtiger_web_session`, `test_ghl_media`, `test_invoice_delivery`, `test_invoice_publisher`, `test_detector`, `test_evento`, `test_render`, `test_verify`, `test_pipeline` | ✅ PASS (cadena de `npm test` avanzó hasta `test_cli`) |
| `test_ghl_messages` | ✅ 23 PASS / 0 FAIL |
| `test_daily_report` | ✅ 20 PASS / 0 FAIL |
| `test_short_links` | ✅ exit 0 |
| `test_link_validator` | ✅ exit 0 |
| `test_cli` | ⛔ Bloqueado: `spawn EPERM` (sandbox de la sesión). Verificado manualmente: `check` → exit 0 con mensaje de variables faltantes; comando desconocido → exit 1 y lista de comandos. |
| `test_e2e_http` | 🟡 Tests 1–4 PASS; test 5 bloqueado por `spawn EPERM` (mismo motivo). |

> El `EPERM` es una restricción conocida de esta sesión (prohibición de pipes con procesos hijos), no un fallo del proyecto. En una terminal normal `npm test` debería completar las 18 suites.

### Consultas en vivo

| URL | Respuesta |
|---|---|
| `https://facturas.labnaturales.com/salud` | `200` `{"ok":true,"servicio":"loa-invoice-engine","ts":"2026-10-26T18:36:55.619Z"}` |
| `https://loa-invoice-engine-labnat.onrender.com/salud` | `200` (mismo payload) |
| `https://loa-invoice-engine.onrender.com/salud` | `404` (nombre de `render.yaml` no existe) |
| `https://facturas.labnaturales.com/` | `200` `{"ok":true,…,"mensaje":"Portal de facturacion"}` |
| `https://facturas.labnaturales.com/S-97782` | `302` → `https://assets.cdn.filesafe.space/…` (PDF) |
| `https://facturas.labnaturales.com/ruta-inexistente-audit` | `404` con página "Factura no encontrada" |

---

## 8. Nota sobre el entorno de esta auditoría

- `git ls-remote` / `git fetch` fallan localmente con `schannel: SEC_E_NO_CREDENTIALS`: el sandbox bloquea la red y el almacén de certificados. **No** es un problema de credenciales de GitHub. La sincronía se verificó vía API pública de GitHub.
- Toda petición HTTP saliente desde PowerShell falló; las verificaciones en vivo se hicieron con el cliente HTTP del harness.
- El informe se guarda como archivo **no versionado**; no se modificó código ni configuración del proyecto.
