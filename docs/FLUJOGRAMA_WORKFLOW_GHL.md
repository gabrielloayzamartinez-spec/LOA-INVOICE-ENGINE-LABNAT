# 📊 Flujograma y Control Visual del Workflow de GHL (LOA Invoice)

Este documento define la arquitectura interna del **Workflow de GHL** para el envío de facturas y el sistema de **Control Visual (Tablero Kanban / Pipeline)** en GoHighLevel.

---

## 1. Sistema de Control Visual en GHL (Tablero de Oportunidades)

Para tener **supervisión visual en tiempo real**, en GHL se utiliza la sección **Opportunities (Oportunidades)** creando un Pipeline llamado **`Control de Facturación`**.

### Columnas del Tablero Visual:
```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 1. FACTURA LISTA │ ➔ │  2. SMS ENVIADO  │ ➔ │ 3. FACTURA LEÍDA │ ➔ │   4. REVISIÓN    │
│                  │    │                  │    │                  │    │ (Sin tel / Error)│
│  [Dina Garcia]   │    │  [Juan Perez]    │    │  [Maria Lopez]   │    │  [Carlos Soto]   │
│  S-97576 ($160)  │    │  S-97570 ($85)   │    │  S-97565 ($120)  │    │  Tel inválido    │
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```

Cada vez que el motor genera una factura, la tarjeta del cliente aparece en la columna **Factura Lista** y va avanzando automáticamente.

---

## 2. Flujograma del Workflow Interno de GHL ("LOA Invoice WF")

```mermaid
flowchart TD
    START(["🟢 DISPARADOR:\nTag añadido = 'FACTURA_LISTA'"]) --> OP1["📋 Acción 1: Crear/Actualizar Oportunidad\nPipeline: 'Control de Facturación'\nEtapa: '1. Factura Lista'\nValor: {{contact.factura_total}}"]
    
    OP1 --> COND1{"❓ Condición:\n¿URL Factura y Teléfono válidos?"}
    
    COND1 -- "NO (Falta dato)" --> ERR1["⚠️ Acción Error:\n- Mover Oportunidad a '4. Revisión'\n- Tag: 'FACTURA_ERROR'\n- Notificar al equipo"]
    
    COND1 -- "SÍ (Todo correcto)" --> NUM_CHECK{"❓ ¿Número SMS\nya configurado en GHL?"}
    
    NUM_CHECK -- "NO (Modo Espera / Seguro)" --> HOLD["⏸️ Acción Temporal:\n- Notificación interna al Admin\n- Esperar asignación de número"]
    
    NUM_CHECK -- "SÍ (Número Activo)" --> SEND_SMS["📲 Acción 2: Send SMS\nDesde: [Número Oficial]\nMensaje:\n'Hola {{contact.first_name}}, gracias por tu compra...\nFactura: {{contact.url_factura_pdf}}'"]
    
    SEND_SMS --> TAGS["🏷️ Acción 3: Gestión de Tags\n- Añadir Tag: 'FACTURA_ENVIADA'\n- Quitar Tag: 'FACTURA_LISTA'"]
    
    TAGS --> OP2["✅ Acción 4: Actualizar Oportunidad\nMover a Etapa: '2. SMS Enviado'"]
    
    OP2 --> WAIT_CLICK{"👁️ Monitoreo de Apertura:\n¿Cliente hizo clic en el enlace?"}
    
    WAIT_CLICK -- "SÍ" --> OP3["🎉 Mover Oportunidad:\nEtapa: '3. Factura Leída'"]
    WAIT_CLICK -- "NO (>24h)" --> END_OK(["🏁 Fin del flujo"])
```

---

## 3. Número Designado Oficial para Facturas (+1 786-882-8446)

El número oficial asignado y con registro A2P 10DLC aprobado es:
* **Número Remitente:** `+1 786-882-8446` (Miami, Florida)
* **Estado A2P:** Aprobado ✅

### Configuración en GHL:
1. En el bloque **Send SMS** del workflow "LOA Invoice WF":
   * **From Number:** Seleccionar `+1 786-882-8446`.
2. En **Settings ➔ Phone Numbers ➔ +1 786-882-8446**:
   * Desvío de llamadas configurado a mensaje informativo de canal automático.
3. En el Workflow de Auto-Respuesta:
   * Si un cliente responde a este número por SMS, recibe el mensaje no-reply y se archiva la conversación.

---

## 4. Estructura de Tags para Filtros Rápidos (Smart Lists)

En la sección **Contacts ➔ Smart Lists**, puedes crear 3 pestañas guardadas:

| Pestaña Smart List | Filtro por Tag | Utilidad |
|---|---|---|
| **Facturas Listas** | `FACTURA_LISTA` | Facturas generadas por el motor pendientes de envío |
| **Facturas Enviadas** | `FACTURA_ENVIADA` | Clientes que ya recibieron su enlace por SMS |
| **Facturas con Error** | `FACTURA_ERROR` | Clientes con teléfono inválido o sin formato |
