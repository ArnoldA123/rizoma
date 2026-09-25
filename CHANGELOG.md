# Rizoma — Changelog

## v0.2.0 — MVP2 (2026-09-25)

Fundación F0 + MVP1 Salud/Obras/Web + cierre de diferidos + API pública + notificaciones + builder/BI + endurecimiento release.

- **MVP1** (PR #1, #2): Salud y Obras contra API verificada, web con 12 pantallas, accesibilidad AA.
- **Login real** (PR #3): claim `tenant_id` en el realm, sesión adelgazada persistente.
- **Huecos MVP1** (PR #4): triaje/receta, comprobantes, equipos/stock, archivos firmados, onboarding HTTP, refresh de token.
- **API pública** (PR #5): claves `X-Api-Key`, webhooks HMAC con reintentos, `usage_counters`, OpenAPI + guía.
- **Notificaciones** (PR #6): `message_log`, adaptador `log`, runtime `notify-send`, emisores en factura y citas.
- **Builder/BI** (PR #7): vistas guardadas, campos custom, transiciones configurables, comparativas con CSV, matriz de permisos.
- **Release** (PR #8): caché Redis en tableros, paginación keyset, job E2E en CI, versiones 0.2.0.

Datos de demostración sintéticos (Perú). Sin datos clínicos reales.
