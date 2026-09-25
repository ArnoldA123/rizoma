# Feature: Login real Keycloak → Web MVP1 — CERRADA (verificada)

**Objetivo:** que `medico.demo` inicie sesión con Keycloak + TOTP y aterrice en `/` con identidad, rol y accesos reales, sin cabeceras de desarrollo y sin cambiar URLs a mano.
**Causa raíz:** token sin `tenant_id` UUID (fallback `azp=rizoma-web` no es UUID) + sin `membership` en Postgres para el `sub` Keycloak + cookie `rizoma_session` de ~2.9KB que el navegador no persistía. Web mostraba `tenant.missing`.
**Autorización:** usuario autorizó opción 1 (login real con `medico.demo`). Confirmó el 2026-09-25 que ya ve las interfaces.

## Tareas
- [x] T1 Limpiar doble servidor web puerto 3000 (quedó uno solo)
- [x] T2 Obtener sub UUID reales Keycloak (medico.demo b7594ed4-0b58-4604-b54f-c8ee869c1f4a, admin.demo 902a7375-c1b6-483f-9f2a-bae7829586b1)
- [x] T3 Mapper `tenant_id` hardcoded en `infra/keycloak/realm-rizoma.json` (user-attribute descartado: el user profile del realm bloquea atributos custom)
- [x] T4 Mapper aplicado en vivo vía Admin API (eliminado user-attribute previo, creado hardcoded; TOTP de medico.demo intacto; directAccess restaurado a false)
- [x] T5 Users + memberships en Postgres para sub b7594ed4 (tenant a100...0001, Sede A b100...00a1, rol medico)
- [x] T6 Cookie adelgazada (solo accessToken+expiresAt+tokenType) + verificado con clics: `/` con Sesión de Médico, Pacientes 68 filas, Agenda vacía propia, cookie 2095 chars, 0 errores
- [x] T7 Confirmación del usuario con medico.demo + TOTP en su navegador

## Decisiones
- Tenant Salud demo: `a1000000-0000-4000-8000-000000000001`, Sede A `b1000000-0000-4000-8000-0000000000a1`
- Mapper final: `oidc-hardcoded-claim-mapper`, claim `tenant_id` en access/id/userinfo (vale para todos los usuarios del cliente demo)
- No se borró el realm (preserva TOTP del usuario). Actualización por Admin API + JSON para persistencia.
- Sin commits sin orden explícita. Cambios pendientes de commit (ver abajo).

## Cambios pendientes de commit (sin orden explícita, no commitear)
- `M apps/web/lib/session-codec.ts` — escritura adelgazada + compat lectura legacy
- `M apps/web/app/api/auth/callback/route.ts` — guarda solo 3 campos
- `M infra/keycloak/realm-rizoma.json` — mapper hardcoded tenant-id
- `?? apps/web/test/session-codec.test.ts` — 10 tests nuevos (aún fuera del script `test` de package.json: al cablearlo, agregar el archivo a la lista explícita de `node --test`)
- `?? odd/tasks/login-real.md` — este archivo
- `?? odd/memory-chomb-mirror.md` — espejo de memoria (revisar si se conserva)
- `?? .playwright-cli/` — artefactos de verificación (candidato a gitignore o borrado)
- Filas DB (no versionadas): users+memberships para b7594ed4 (medico.demo) y 07c70cf5 (playwright.medico, usuario de prueba sin TOTP — decidir si se conserva para futuras verificaciones o se elimina)

## Evidencia
- subs obtenidos 2026-09-25 vía admin-cli
- Token de prueba con `tenant_id` + rol medico (grant directo temporal, luego desactivado y usuario temporal eliminado; playwright.medico se conserva)
- FAIL pre-fix con clics (sin cookie) → PASS post-fix con clics (Sesión de Médico, 68 filas, Agenda propia)
- `node --test apps/web/test/session-codec.test.ts`: 10 pass; `typecheck` web limpio; suite web 82 pass
- Confirmación del usuario: ve las interfaces con medico.demo
