# Feature: MVP1 Salud — ficha, agenda, consentimientos y caja Perú

**Objetivo:** vertical salud operando en local: ficha Paciente 360, agenda,
episodios, triaje, receta por plantilla, consentimiento teleinterconsulta PE,
caja y factura (manual + SUNAT beta), importador CSV y 1 tablero por rol.
**Fuentes:** bases-consolidadas-v1.md §2.3, §3.3, §6.1, §7.1; peru-anexo-v1.md
§2 (consentimiento), §3 (factura). **Predecesor:** API runtime 4/4.
**Reglas:** sin commits sin orden explícita. Código en inglés, datos sintéticos.

## Tareas

- [x] S1 Migración 003 salud (patient_files, episodes, appointments, triages,
  consents, prescriptions, cash_sessions) con RLS + linter verde
- [x] S2 API pacientes+episodios+citas (CRUD con guard, policy y auditoría)
- [x] S3 Consentimiento teleinterconsulta (versionado, bloqueo sin SI,
  grabación por tipos, evidencia con hash, derechos ARCO)
- [x] S4 Caja + facturación (cobro, folio manual/SUNAT beta, IGV, anchos caja)
- [x] S5 Importador CSV pacientes + tablero por rol + verificación AA + cierre

## Criterios de salida (base §7.1)

1. Flujo registro→consentimiento→cita→atención→cobro→factura con auditoría.
2. Caja no ve historia clínica (prueba de denegación).
3. Adaptador fiscal emite y reintenta en degradado.
4. Importador CSV operativo. 5. AA en flujos críticos.

## Evidencia

- Commits: (solo con orden explícita)
