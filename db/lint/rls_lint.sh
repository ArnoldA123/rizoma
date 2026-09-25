#!/usr/bin/env bash
# Linter RLS (criterio de salida F0 #2): falla si alguna tabla de negocio del
# SQL de migraciones carece de columna tenant_id o de POLICY tenant_isolation.
# Uso: bash db/lint/rls_lint.sh db/migrations/001_core_foundation.sql [...]
set -euo pipefail
# Allowlist explícita de excepciones documentadas:
#   tenants            -> raíz del modelo, no tiene tenant_id (001)
#   schema_migrations  -> control interno de migraciones, no es negocio (001)
#   app_state          -> singleton global del arranque: existe antes que
#                         cualquier tenant, así que no puede llevar tenant_id
#                         ni RLS (002)
#   onboarding_cases   -> datos pre-tenant del alta: el tenant todavía no
#                         existe mientras el wizard recorre los 7 pasos (002)
# onboarding_acta NO está exenta: es tabla de negocio con tenant_id + policy.
ALLOWLIST="tenants schema_migrations app_state onboarding_cases"
fail=0
for f in "$@"; do
  # Tablas creadas
  mapfile -t tables < <(grep -Eoi 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$f" | awk '{print $NF}' | sort -u)
  for t in "${tables[@]}"; do
    skip=0
    for a in $ALLOWLIST; do [ "$t" = "$a" ] && skip=1; done
    [ "$skip" = 1 ] && continue
    # ¿La tabla tiene tenant_id? (definición de columna en su CREATE TABLE)
    if ! awk "/CREATE TABLE IF NOT EXISTS $t/,/;/" "$f" | grep -qi 'tenant_id'; then
      echo "LINT FAIL: tabla '$t' sin columna tenant_id ($f)"; fail=1
    fi
    # ¿Existe POLICY tenant_isolation? (creada en bloque DO; se verifica presencia global + tabla en lista RLS)
    if ! grep -q 'tenant_isolation' "$f" || ! grep -q "'$t'" "$f"; then
      echo "LINT FAIL: tabla '$t' sin POLICY tenant_isolation ($f)"; fail=1
    fi
  done
done
if [ "$fail" = 0 ]; then echo "RLS LINT OK: $*"; else echo "RLS LINT: errores arriba"; exit 1; fi
