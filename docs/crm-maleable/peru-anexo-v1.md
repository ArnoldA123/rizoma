# CRM Maleable — Anexo Perú v1

**Estado:** diseño construible. Sin código de aplicación.
**País fijado:** Perú (ISO `PE`, locale `es-PE`).
**Documento base:** `docs/crm-maleable/bases-consolidadas-v1.md`.
**Alcance:** cerrar las decisiones de país que el base dejó abiertas: protección de datos
(Ley 29733), consentimiento, factura local manual, switch a SUNAT y gestión de secretos.
**Reglas:** datos y ejemplos ficticios; nada de scraping. Español neutro, sin voseo.
**Consentimiento:** el texto real de teleinterconsulta (Ley 26842 y Ley 29733) está incorporado
en §2; el bloqueo anterior por `_inbox` queda resuelto.

## 0. Decisiones fijadas por este anexo

| # | Dimensión | Decisión |
|---|-----------|----------|
| 1 | País fiscal y de residencia de datos | Perú. Datos y backups en jurisdicción peruana (heredado del base §4.7) |
| 2 | Moneda | `PEN` (soles). Sin multi-moneda en v1 |
| 3 | IGV | 18%, parametrizable por tenant y por fecha de vigencia (no codificado duro) |
| 4 | Comprobante MVP1 | Factura local **manual**: folio interno y estados `borrador/emitida/anulada` |
| 5 | Comprobante MVP2/switch | Emisión electrónica vía SUNAT por adaptador, activable por el admin |
| 6 | Credenciales SOL | Vault cifrado. Nunca en claro en BD, logs ni backups |
| 7 | Consentimiento | Teleinterconsulta bajo Ley 26842 y Ley 29733 (§2): versionado por paciente/episodio/centros, evidencia PDF con hash y bloqueo sin `SI` |
| 8 | Autoridad de control | Autoridad Nacional de Protección de Datos Personales (ANPD) |

## 1. Marco legal de datos personales (Ley 29733)

### 1.1 Principios aplicables al producto

| Principio | Traducción a diseño |
|-----------|---------------------|
| Consentimiento | Toda finalidad tiene una base de licitud registrada; el consentimiento se versiona |
| Finalidad | Cada tratamiento declara para qué se usa el dato; sin finalidad no se recolecta |
| Proporcionalidad | Solo datos necesarios por finalidad; campos mínimos por entidad |
| Calidad | Datos exactos y actualizables; el titular puede rectificar |
| Seguridad | Cifrado en tránsito (TLS 1.2+) y en reposo (AES-256); secretos en vault |
| Disposición de recurso | Borrado lógico + purga aprobada; no eliminación física sin control |

### 1.2 Datos tratados en el vertical construcción

- Identificación del trabajador: nombres, tipo y número de documento, contacto.
- Datos laborales: asignaciones, asistencia, marcas de entrada y salida.
- Datos del cliente de la obra: razón social, RUC, contacto comercial.
- Datos de salud: solo si el cliente decide tratarlos; el producto los marca como **sensibles**
  y exige consentimiento expreso y por escrito antes de almacenarlos.

### 1.3 Roles de tratamiento

| Rol | Quién | Responsabilidad |
|-----|-------|-----------------|
| Titular | Trabajador, cliente, contacto | Ejerce derechos ARCO sobre sus datos |
| Responsable | Tenant (empresa constructora) | Define finalidades y atiende ARCO |
| Encargado | El producto (SaaS) | Trata datos por cuenta del tenant, bajo contrato |
| Terceros | Pasarela, proveedor de notificación | Solo lo necesario, con encargo y contrato |

## 2. Consentimiento informado de teleinterconsulta (Ley 26842 y Ley 29733)

**Fuente canónica:** el `.docx` original *Consentimiento informado y tratamiento de tus datos
personales*, legible vía `word/document.xml`; el `.md` convertido es respaldo. Aplica al acto
médico de teleinterconsulta entre el **Centro Consultante** (teleconsultante, `(*)`) y el **Centro
Consultor** (teleconsultor, `(**)`). Reutiliza el modelo `consents` del base §2.3.

### 2.1 Base legal

| Base | Alcance en el producto |
|-------|------------------------|
| Ley 26842, Ley General de Salud | Acto médico con consentimiento informado; historia clínica y su registro por el establecimiento |
| Ley 29733 y su reglamento | Datos de salud como **sensibles**; consentimiento libre, previo, informado, expreso e inequívoco; bancos de datos con titularidad; derechos ARCO |
| Registro de la sesión de teleinterconsulta (IPRESS) | Identidad del personal presente, permiso verbal para personal adicional y registro de la sesión por los establecimientos |

### 2.2 Reutilización del modelo base

El producto no crea tablas nuevas: usa `consents` del base §2.3 con `template_code`, `version`,
`signed_at`, `evidence_attachment_id` y `status`. `template_code = consent.pe.teleinterconsulta`.
Estados: `pending → signed → revoked` / `expired`. La evidencia firmada es un `attachment`
con `sha256` y retención propia; nunca se borra físicamente.

### 2.3 Campos del formulario (tipificados)

| Campo | Tipo | Obligatorio | Regla |
|-------|------|-------------|-------|
| `patient_full_name` | Texto | Sí | Nombres y apellidos; se completa en **LETRAS MAYÚSCULAS** |
| `patient_doc_type` / `patient_doc_number` | Catálogo + texto | Sí | DNI o documento de identidad |
| `patient_age` / `form_date` | Entero + fecha | Sí | Edad al momento de la firma y fecha de la firma |
| `medical_record_number` | Texto | Sí | N.° de historia clínica |
| `guardian_full_name` / `guardian_doc_number` | Texto + texto | No | Representante o apoderado; obligatorio si el paciente es menor o no puede consentir; se registra el vínculo |
| `informed_by` | Texto | Sí | Profesional de salud que informa |
| `consulting_center` (`(*)`) / `consultor_center` (`(**)`) | Referencia a IPRESS | Sí | Par de centros, con domicilio y correo para ARCO (tabla §2.7) |
| `act_consent` | Booleano | Sí | `SI` / `NO` al acto médico; sin `SI` no hay teleinterconsulta |
| `recording_consent` + `recording_types` | Booleano + conjunto | Sí | `SI` / `NO` a la grabación y tipos autorizados (§2.6) |
| `truthfulness_commitment` | Declaración | Sí | Compromiso de informar con la verdad los datos solicitados |
| `patient_signature` / `patient_thumbprint` | Evidencia | Sí | Firma y huella del paciente o del representante |
| `professional_signature` | Evidencia | Sí | Firma del profesional que informa |

Declaraciones del formulario: información sobre ventajas, beneficios y riesgos; preguntas
absueltas; confidencialidad de los datos; identidad del personal y permiso ante personal adicional.

### 2.4 Finalidades y transferencia consultante → consultor

| Código | Finalidad | Base de licitud | Datos | Retención |
|--------|-----------|-----------------|-------|-----------|
| `F1` | Realizar el acto médico de teleinterconsulta | Consentimiento expreso e inequívoco | Identificación y salud | Historia clínica |
| `F2` | Registrar el acto en la historia clínica del centro consultante | Obligación legal (Ley 26842) | Salud | Plazo de historia clínica |
| `F3` | **Transferir** los datos al Centro Consultor para la evaluación | Consentimiento expreso del titular | Salud | Según el centro consultor |
| `F4` | Registrar y auditar la sesión por los establecimientos participantes | Obligación legal | Salud y metadatos de sesión | Plazo de auditoría |

- La transferencia **consultante → consultor** es la única habilitada por este consentimiento;
  sin `SI` en el acto médico (§2.6) no se habilita `F3`.
- El producto **no es titular**: actúa como encargado de cada centro y no puede ampliar finalidades.
- Toda transferencia registra origen, destino, finalidad y `trace_id`; si la finalidad no la
  autoriza, el envío se bloquea.
- Transferencia internacional: solo con finalidad declarada y base de licitud; el producto
  registra el destino y bloquea el envío cuando la finalidad no lo autoriza.

### 2.5 Bancos de datos por centro

| Banco | Titularidad | Rol del producto | Alcance |
|-------|-------------|------------------|---------|
| Banco del Centro Consultante | Centro Consultante (`(*)`) | Encargado | Historia clínica y datos de la sesión |
| Banco del Centro Consultor | Centro Consultor (`(**)`) | Encargado | Datos transferidos para la evaluación |

El paciente es informado de que sus datos se tratan en **ambos** bancos, con titularidad de cada centro respectivamente; el producto no declara titularidad propia ni crea un banco único.

### 2.6 Matriz de casillas (autorización expresa)

**Acto médico**

| Decisión | Efecto en el sistema |
|----------|----------------------|
| `SI` | Autoriza el acto médico vía teleinterconsulta; habilita la sesión |
| `NO` | No autoriza; **bloqueo duro**: la teleinterconsulta no inicia (§2.8) |

**Grabación** (una marca por tipo; `todo` abarca todos los tipos)

| Tipo | Casilla `SI` | Casilla `NO` |
|------|--------------|--------------|
| Imágenes de ayuda diagnóstica | Autoriza su grabación | Prohíbe su grabación |
| Fotografías | Autoriza su grabación | Prohíbe su grabación |
| Video | Autoriza su grabación | Prohíbe su grabación |
| Audio | Autoriza su grabación | Prohíbe su grabación |
| Todo | Autoriza todos los tipos | Prohíbe todos los tipos |

Nota de fidelidad: confirmado en el `.docx` (§2.9), la tabla de grabación agrupa los tipos en dos
filas: **Sí, consiento que sea grabado** con Imágenes de ayuda diagnóstica y Fotografías, y
**No, consiento que sea grabado** con Video, Audio y Todo. El sistema normaliza cada tipo a una
casilla `SI`/`NO` propia y `todo` es inclusivo.

### 2.7 Derechos ARCO (comunicación escrita a cada IPRESS)

El titular, o su representante, ejerce sus derechos de la Ley 29733 mediante **comunicación
escrita** dirigida a cada establecimiento que participa en la teleinterconsulta:

| IPRESS | Domicilio | Correo electrónico |
|--------|-----------|--------------------|
| `(*)` Centro Consultante | `<domicilio consultante>` | `<correo consultante>` |
| `(**)` Centro Consultor | `<domicilio consultor>` | `<correo consultor>` |

- Domicilio y correo se parametrizan por tenant; los valores reales los aporta cada centro.
- La comunicación se presenta ante **cada centro por separado**: cada IPRESS responde por su banco.
- El producto genera el formato, la registra y conserva la constancia; **no responde** por el centro.
  Exige identificación del titular antes de responder y registra solicitud, vencimiento y estado
  (plazo máximo legal en días hábiles, pendiente de precisión en §10).
- La oposición al tratamiento no borra el dato; lo marca y documenta la base que persiste.

### 2.8 Reglas de sistema

1. **Versionado:** `template_code` + `version` + paciente + episodio + par de centros (`(*)`/`(**)`); se conserva la versión vigente al momento del acto médico.
2. **Evidencia:** el documento firmado se archiva como PDF (con el escaneo) en un `attachment` con `sha256` y nunca se borra físicamente.
3. **Bloqueo del acto médico:** sin `SI` no se agenda ni se inicia la teleinterconsulta; el bloqueo es duro y el intento denegado se audita.
4. **Grabación restringida:** solo se graban o almacenan los tipos con `SI`; `todo` habilita todos los tipos y sin autorización no se inicia grabación.
5. **Auditoría de accesos:** toda lectura, escritura, descarga o transferencia del consentimiento y su evidencia escribe `audit_log` con actor, motivo y `trace_id`; los accesos denegados también se registran.
6. **Consentimiento y veracidad:** firma el paciente o su representante, con compromiso de veracidad, y el profesional informante queda en `informed_by`.
7. **Revocación:** `signed → revoked` bloquea nuevas teleinterconsultas y conserva el histórico y la evidencia firmada.

### 2.9 Evidencia escaneada fuera del seed

Las imágenes de casillas, firmas y huellas del `.docx` original quedan como **evidencia escaneada** (PDF o imagen) ligada al `attachment` del consentimiento firmado; no forman parte del seed, que solo contiene el texto tipificado y las plantillas sin datos personales reales.

## 3. Facturación Perú

### 3.1 Reglas comunes

| Aspecto | Regla |
|---------|-------|
| Moneda | `PEN`. Todo monto se almacena en soles con 2 decimales |
| IGV | 18% parametrizable: tabla de parámetros por tenant y fecha de vigencia |
| Base de cálculo | El IGV se aplica sobre el valor de venta; el total es valor + IGV |
| Redondeo | Redondeo a 2 decimales por línea y por documento; sin diferencias silenciosas |
| Correlación | Serie y correlativo por tipo de comprobante, sin huecos ni reutilización |
| Retenciones | Fuera de MVP1 (heredado de §2.5 del base) |

### 3.2 Catálogos UBL mínimos (v1)

| Catálogo | Valores mínimos |
|----------|-----------------|
| Tipo de comprobante | `01` Factura, `03` Boleta, `07` Nota de crédito, `08` Nota de débito |
| Tipo de documento de identidad | `1` DNI, `6` RUC, `4` Carné de extranjería |
| Tipo de afectación del IGV | `10` Gravado, `20` Exonerado, `30` Inafecto, `40` Exportación |
| Moneda | `PEN` (Soles) |
| Unidad de medida | `NIU` (unidad), `ZZ` (servicio), `KGM`, `MTR`, `HUR` |
| Forma de pago | `1` Contado, `2` Crédito |
| Tipo de nota | Crédito / Débito con documento que modifica |

### 3.3 Factura local manual (MVP1)

- Sin conexión a SUNAT: el comprobante se numera con **folio interno** del tenant
  (por ejemplo `INT-2025-000001`) y queda registrado como documento interno.
- Estados: `borrador → emitida → anulada`. `anulada` exige motivo y queda auditada;
  una factura anulada no vuelve a `emitida`.
- El estado fiscal es independiente del estado comercial del base
  (`draft/issued/paid/partially_paid/voided`); el base §2.5 ya separa `fiscal_status`.
- El switch a SUNAT es una decisión del admin por tenant; al activarlo, los documentos
  nuevos pasan a la ruta electrónica y los manuales previos se conservan como histórico.

## 4. Switch a SUNAT (emisión electrónica)

### 4.1 Adaptador

- Interfaz del base: `FiscalAdapter.emit(invoice) -> folio/status`.
- El core no contiene lógica fiscal ni del proveedor; **solo los workers** llaman al adaptador.
- `fiscal_adapter` identifica la implementación activa (`sunat_v1`, `manual_v1`).
- El payload fiscal crudo se guarda inmutable en `fiscal_payload` para auditoría y replay.

### 4.2 Cola, reintentos y modo degradado

| Aspecto | Regla |
|---------|-------|
| Reintentos | 5 intentos con backoff 1 m / 5 m / 30 m / 2 h / 6 h (base §5.3) |
| Idempotencia | `Idempotency-Key` por comprobante; reintento no duplica folio |
| Estados fiscales | `pending → sent → accepted` / `rejected` / `contingency` |
| Modo degradado | Si SUNAT no responde: `fiscal_status=contingency` con folio interno y reintento |
| Bloqueo | Ningún fallo fiscal bloquea la atención ni la caja; se encola y se reintenta |
| Observabilidad | Estado, intentos y último error visibles en el panel de caja |

### 4.3 Activación del switch

- Por defecto el tenant arranca en modo manual. El admin activa SUNAT explícitamente.
- La activación exige: entorno elegido, credenciales SOL válidas y certificado cargado.
- Si la validación falla, el switch no se activa y el modo manual sigue operativo.
- El cambio de modo queda auditado con actor, antes y después, y `trace_id`.

## 5. Admin UI de conexión SUNAT

### 5.1 Campos

| Campo | Tipo | Regla |
|-------|------|-------|
| Usuario SOL | Texto | Identificación tributaria; no es secreto, se muestra enmascarado parcial |
| Clave SOL | Secreto | Solo entrada; nunca se devuelve en claro por API ni UI |
| Certificado digital | Archivo + clave | Valida vigencia y titular; la clave va al vault |
| Entorno | Selección | `beta` (pruebas) o `prod` (producción); confirmación reforzada para `prod` |
| RUC emisor | Texto | Debe coincidir con el titular del certificado |

### 5.2 Validación sin exponer secretos

1. El formulario envía los secretos por HTTPS a un endpoint que los cifra de inmediato.
2. La validación "probar conexión" usa los secretos **en memoria** y no los persiste en claro.
3. La respuesta solo indica resultado (`ok` / `error` con código), nunca el valor del secreto.
4. Un secreto inválido no se guarda; se descarta de memoria al terminar la solicitud.
5. Los campos de secreto nunca se registran en logs, trazas ni mensajes de error.

### 5.3 Rotación y revocación

- **Rotación:** el admin carga credenciales nuevas; la versión anterior queda inactiva pero
  auditable, y se destruye según la política de retención del vault.
- **Revocación:** desactiva el uso del secreto de inmediato; los reintentos en curso fallan
  de forma controlada y pasan a `contingency`.
- Cada movimiento (alta, rotación, revocación) escribe en `audit_log` con `diff` enmascarado.
- La operación sensible exige MFA del admin (base §5 de seguridad).

## 6. Vault de secretos

| Aspecto | Regla |
|---------|-------|
| Cifrado | Envelope encryption AES-256-GCM; clave maestra en KMS/`age`, no en la BD |
| Almacenamiento | La BD guarda solo `secret_ref` y metadata; nunca el valor en claro |
| Acceso | Solo el servicio worker de facturación y `ti_admin` con MFA |
| Logs | Prohibido escribir secretos en logs, trazas, errores o payloads de auditoría |
| Backups | Los backups cifran el volumen completo; sin secretos en claro en dumps |
| Rotación | Programada y a demanda; cada versión de secreto se identifica y se puede revocar |
| Auditoría | Toda lectura/escritura de secreto deja rastro con actor, motivo y `trace_id` |

## 7. Auditoría de facturación y datos

- `audit_log` append-only para altas, rotaciones, revocaciones, cambios de modo y anulaciones.
- El `diff` de eventos con secretos se enmascara antes de persistir.
- Toda denegación de permiso de facturación/caja escribe `access.denied` con `trace_id`.
- Toda factura anulada requiere actor, motivo y marca de tiempo.
- El payload fiscal crudo es inmutable y de solo lectura para el rol de aplicación.

## 8. Criterios de salida (MVP1 Perú)

1. Factura manual: crear `borrador`, emitir con folio interno y anular con motivo, todo auditado.
2. IGV 18% correcto y parametrizable; cambio de tasa sin desplegar código.
3. Switch SUNAT: activación, validación y revocación probadas en entorno `beta`.
4. Reintentos y modo degradado observables: un fallo de SUNAT no bloquea la caja.
5. Payload fiscal crudo recuperable y legible para auditoría.
6. Ningún secreto SOL en claro en BD, logs ni backups (prueba de búsqueda negativa).
7. Consentimiento: texto real cargado y versionado; teleinterconsulta bloqueada sin `SI` al acto médico y grabación limitada a los tipos autorizados.
8. Casos de denegación de caja y alcance cubiertos según base §3.5.

## 9. Riesgos SUNAT

| Riesgo | Impacto | Mitigación | Señal temprana |
|--------|---------|------------|----------------|
| Validaciones fiscales subestimadas | Rechazo de comprobantes | Piloto con contador desde la semana 1; modo degradado listo | Rechazos sin causa mapeada |
| Cambio normativo o de esquema UBL | Retrabajo del adaptador | Catálogos parametrizables; adaptador aislado | Avisos del ente o del proveedor |
| Fuga de credenciales SOL | Crítico legal y fiscal | Vault, MFA, cero secretos en logs/backups, rotación | Secreto en un log o backup en claro |
| Certificado vencido | Emisión detenida | Aviso previo y validación de vigencia en la UI | Fallo de conexión por certificado |
| Caída o lentitud de SUNAT | Caja bloqueada | Cola con reintentos y `contingency`; nunca bloquear | Cola fiscal creciendo |
| Numeración duplicada por reintento | Inconsistencia fiscal | Idempotencia por comprobante y folio reservado | Huecos o duplicados en correlativo |

## 10. Pendientes

| # | Pendiente | Bloquea | Dueño de la decisión |
|---|-----------|---------|----------------------|
| 1 | Domicilio y correo reales de cada IPRESS (`(*)` y `(**)`) | Notificación ARCO de la §2.7 | Usuario/negocio |
| 2 | Plazos legales exactos de ARCO y retención | Purga programada y textos legales | Legal/normativa |
| 3 | Proveedor o conexión SUNAT definitiva (modo) | Configuración de producción | Usuario/negocio |
| 4 | Validación con contador de series y correlativos | Emisión electrónica real | Negocio/contador |
| 5 | Agrupamiento `SI`/`NO` de las casillas de grabación contra el `.docx` original | **Resuelto** (§2.6): el `.docx` confirma la agrupación en dos filas | — |

## 11. Onboarding de primer arranque

**Disparo:** la base está vacía: cero tenants o `app_state` sin `initialized_at`; el wizard corre una sola vez y no se reabre con un tenant ya inicializado.

| # | Paso | Dato capturado |
|---|------|----------------|
| 1 | Organizador | Razón social, RUC y domicilio fiscal |
| 2 | Sedes IPRESS | Por par `(*)`/`(**)`: nombre, domicilio y correo ARCO |
| 3 | Identidad | Logo, nombre visible y responsable del tratamiento |
| 4 | Facturación | Manual por defecto; SUNAT y credenciales SOL opcionales |
| 5 | Administrador | Usuario admin con MFA obligatorio |
| 6 | Revisión | Resumen y confirmación de los datos |
| 7 | Acta de alta | Acta firmada, versionada e inmutable |

- **Validaciones:** RUC con dígito verificador, domicilio y correo ARCO por IPRESS, logo y formato válidos y MFA activo; el paso no avanza sin los datos obligatorios.
- **Bloqueo de rutas:** hasta cerrar el acta, toda ruta de negocio responde `onboarding_pending`.
- **Idempotencia y reanudación:** el alta usa `idempotency_key` y no duplica el tenant; el wizard se reanuda en el último paso confirmado.
- **Auditoría del alta:** cada paso escribe `audit_log` (actor, `diff`, `trace_id`); el acta es inmutable.
- **Placeholders del consentimiento:** razón social y RUC alimentan el encabezado; cada IPRESS resuelve `<domicilio …>` y `<correo …>` de §2.7 por tenant (`(*)` consultante, `(**)` consultor).
