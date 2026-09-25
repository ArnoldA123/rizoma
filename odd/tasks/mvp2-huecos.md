# Feature: MVP2 Huecos MVP1 — cerrar diferidos web+API

**Objetivo:** convertir los placeholders y degradados del MVP1 en capacidad real: triaje/receta, archivos con URL firmada, onboarding HTTP, listado de comprobantes, listados de equipos/stock, y refresco de token. Paginación cursor, OpenAPI, caché Redis y E2E navegador se deciden por tarea (alcance potencial, no comprometido).
**Predecesor:** MVP1 cerrado + login-real en main (fa3817f). Gaps listados en `odd/tasks/mvp1-web.md` (Alcance) y `apps/web/README.md` (Alcance diferido).
**Reglas:** español neutro en docs, código en inglés, datos sintéticos. Sin commits sin orden explícita. Rama feature + commits unidad de trabajo cuando se autorice.

## Tareas
- [x] H0 Mapeo: inventario exacto por hueco (scout muhb3d0q-4-f68f, solo lectura)
  - H4 S: `GET invoices/:id` existe, sin listado; UI caja con lista local a sesión; patrón a copiar `GET /billing/quotes`
  - H5 M: stock/assets solo writes; ids vía `getSiteBoard` → pick en ficha; faltan 3 GET listados
  - H1 M: tablas `triages`/`prescriptions` en 003 sin servicio ni controller; UI sin paneles
  - H3 M: `onboarding/service.ts` puro en memoria + tablas 002; sin controller ni ruta `/onboarding`
  - H2 L: solo `files/paths.ts` + config S3; sin controller/service/SDK ni contracts de files
  - H6 S/M: refresh descartado en callback; refrescar = `grant refresh_token` + renovación lazy
  - Orden sugerido: H4 → H5 → H1 → H3 → H2 → H6
- [ ] H1 Triaje + receta: endpoints + UI (tablas 003 existen, sin controller)
- [ ] H2 Archivos: subida/descarga con URL firmada (hoy solo `files/paths.ts`, resto metadata)
- [ ] H3 Onboarding HTTP: exponer controller + ruta `/onboarding` (servicio puro hoy)
- [x] H4 Comprobantes: `GET /v1/billing/invoices` con filtros + contratos + panel caja (lista local eliminada). Verde: API 420, contracts 68, web 92. Pulido padre: billing.test.ts cableado al script `test` de contracts, `.codegraph/` a .gitignore
- [ ] H5 Equipos/stock: listados (hoy solo vía tablero) + operación
- [ ] H6 Sesión: refresco de token (hoy 8h fijas, refresh guardado sin uso)
- [x] H5 Equipos/stock: `GET assets`, `GET stock/items`, `GET stock/moves` + tablas en paneles (pick por fila; pick de tablero conservado). Verde: API 433, contracts 68, web 92. Nota: `listItems` es tenant-wide con guard `site.read` (sin columna org)
- [x] H1 Triaje + receta: contratos + 2 servicios/controllers + paneles en ficha 360. Verde: API 454, contracts 76, web 92. Pulido padre: tests nuevos cableados (contracts + api). Nota: receta en episodio cerrado = state.denied; historial recetas ordena por id (sin created_at en 003)
- [x] H3 Onboarding: controller + store pre-tenant + wizard `/onboarding` de 7 pasos. Verde: API 472, contracts 88, web 92. Nota: acta servida del caso cerrado (mismo hash) hasta provisionar tenant; `onboarding/{*path}` excluido del middleware pendiente de arranque en vivo
- [x] H2 Archivos: presigner SigV4 sin SDK + `POST request-upload`/`GET :id/download` + paneles subida en consentimiento y bitácora. Verde: API 488, contracts 99, web 92. Notas: scope a nivel de nodo de membresía; PUT directo a S3 exige CORS en LocalStack/R2
- [x] H6 Sesión: refresh en segunda cookie HttpOnly + renovación lazy en proxy/session (singleflight, rotación). Verde: web 105. Limitación conocida: middleware Edge redirige a `/login` con access vencido antes de renovar — data-plane se auto-recupera; falta pase silencioso en navegaciones (seguimiento H6b)
- [x] H6b Middleware deja pasar `expired-access + refresh presente`; test cableado. Verde web 115
- [x] H6c Renovación en memoria en Server Components (`resolveSessionFromJar`; persistencia sigue en proxy/session). Tests cableados. Verde web 125
- [x] H7 Cierre: suites 99+488+125 en verde, probes estáticas 27/0/2, README diferidos actualizado. Verificado con clics: H1 listas 200, H4 27 comprobantes con filtros/detalle, H5 18 obras + tablas, H3 acta firmada sha256, H6 sesión persistente. Hallazgo operativo: el API dev sirve `dist` — reconstruir+reiniciar tras cada cambio de controllers
- [ ] H7 Cierre: probes, docs, verificación por rol

## Fuera (salvo que el mapeo diga lo contrario)
- Paginación por cursor, OpenAPI generado, caché Redis en tableros, webhooks, API keys, BI, builder, WhatsApp/SMS, E2E Playwright (todos MVP2/F2 oficial)

## Evidencia
- (se registra por tarea: commits solo con orden explícita)
