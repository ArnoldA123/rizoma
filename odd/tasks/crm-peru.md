# Feature: CRM Perú — consentimiento, SUNAT y seeds construcción

**Objetivo:** fijar Perú como país v1 sin huecos: consentimiento Ley 29733, factura local manual + switch SUNAT configurable por admin con vault, y seeds sintéticos construcción en PEN vía SQL.
**Fuente base:** `docs/crm-maleable/bases-consolidadas-v1.md`
**Salidas:**
- `docs/crm-maleable/_inbox/README.md`
- `docs/crm-maleable/peru-anexo-v1.md`
- `db/seeds/peru/001_construccion_full.sql`
**Reglas:** datos inventados sintéticos, nada de scraping de sitios reales. Español neutro, sin voseo. Sin commits. No leer rutas Windows (inaccesibles); el consentimiento entra vía `_inbox`.

## Tareas

- [x] T1 Crear `_inbox` temporal con instrucciones de entrega y borrado del consentimiento
- [x] T2 Redactar anexo Perú: Ley 29733, factura manual + switch SUNAT, admin UI de credenciales SOL/certificado con vault y auditoría
- [x] T3 Generar seed SQL full construcción Perú en PEN, coherente con RLS/tenant/org del documento base
- [x] T4 Verificación de coherencia y trazabilidad con bases-consolidadas
- [x] T5 Incorporar consentimiento real de teleinterconsulta Ley 26842 + 29733 al anexo Perú
- [x] T6 Especificar onboarding de primer arranque (si BD vacía) y fijar .docx como fuente preferente

## Decisiones ya tomadas por el usuario

- País: Perú. Factura: manual en MVP1 + switch a SUNAT. Credenciales SOL en vault cifrado.
- Seeds: full (obras + personal + asistencia + equipos + stock + materiales en soles), inventados en SQL.
- Consentimiento: pendiente de entrega del usuario en `_inbox`; no bloquear T2/T3, dejar placeholder tipificado.

## Evidencia

- Commits: (solo si el usuario lo pide explícito)
