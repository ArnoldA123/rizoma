# Keycloak — realm Rizoma (F0/T3)

`realm-rizoma.json` define el realm `rizoma`: clientes `rizoma-web` (público,
PKCE, `http://localhost:3000/*`) y `rizoma-api` (confidencial, service
account), los 14 roles de bases-consolidadas-v1.md §3.2, grupos `salud` y
`admins`, política OTP TOTP y dos usuarios demo sintéticos
(`admin.demo`, `medico.demo`, `@example.invalid`) con `CONFIGURE_TOTP`
obligatorio en el primer login.

## Importación

Compose monta este directorio en `/opt/keycloak/data/import` y arranca con
`--import-realm`: el realm se crea solo si no existe (idempotente; para
reimportar hay que borrar el realm desde la consola o la API).

## Verificación

```bash
# token admin de master (clave demo de infra/docker/.env)
T=$(curl -s -X POST http://127.0.0.1:8080/realms/master/protocol/openid-connect/token \
  -d 'client_id=admin-cli' -d 'username=admin' \
  -d 'password=rizoma_demo_password' -d 'grant_type=password' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8080/admin/realms/rizoma | python3 -c 'import sys,json; print(json.load(sys.stdin)["realm"])'
```

## Nota MFA

F0 exige TOTP en el primer login de los demo y política OTP a nivel de realm.
El flujo condicional por grupo (solo admin/salud/caja) se endurece en MVP1;
ver bases §5.
