# Feature: MVP2 Notificaciones plenas

**Objetivo:** email + WhatsApp/SMS plenos con `message_log`, proveedores enchufables y reintentos, sobre las colas F0 (`notify-send` ya configurada) y el patrón de `webhook-deliver`.
**Por qué ahora:** la base de entrega (firmas, backoff, outbox) ya existe por W2/W3; notificaciones la reutiliza sin proveedores reales obligatorios (adaptadores `log`/`manual` + plantilla).
**Fuentes:** bases-consolidadas-v1.md §2 (módulo `notify`), §7.1 MVP2.
**Reglas:** español neutro en docs, código en inglés, datos sintéticos. Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.

## Tareas
- [x] N0 Mapeo (scout muh8jn1-n-gwyo): `notify-send` solo config sin runtime; `message_log` + `notify_templates` existen en 001 sin código; sin proveedores. Orden: N1 servicio → N2 adapters+runtime → N3 emisores → N4 cierre
- [x] N1 Servicio `notify.service.ts` + controller + contratos (`to`→`recipient` documentado). Verde: API 586, contracts 126. Cableados padre
- [x] N2 Adaptadores (`log` + puerta documentada) + runtime `notify-send` clonado de webhooks. Verde: workers 60. Cableado padre
- [x] N3 Emisores best-effort en `issueInvoice` y `createAppointment` (email primero, sms fallback, skip silencioso); onboarding no emite por diseño pre-tenant. Verde: API 590, contracts 126. API reconstruido (403 tipificado en vivo)
- [x] N4 Cierre: suites 590/126/60 + camino positivo en vivo (plantilla→send queued→lista, luego limpiado). Membership ti_admin demo para admin.demo en salud (futura verificación admin)

## Fuera
- Proveedor real de pago (requiere credenciales del cliente)
- Builder + BI (siguiente track)

## Evidencia
- (se registra por tarea: commits solo con orden explícita)
