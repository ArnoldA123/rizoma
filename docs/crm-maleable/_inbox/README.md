# Inbox temporal — Consentimiento Perú (Ley 29733)

Buzón de entrega para el documento de consentimiento informado y sus recursos.
Su contenido se incorpora al anexo y la carpeta se elimina después. No es un almacén permanente.

## Por qué existe esta carpeta

La ruta de Windows indicada por el usuario (unidad `C:`, por ejemplo `C:\...\consentimiento.docx`)
no es legible desde este entorno: el proceso corre sobre Linux y no puede montar unidades locales
de Windows. Por eso se solicita dejar aquí una copia de los archivos.

## Qué entregar

1. El documento de consentimiento informado en `.docx` (o `.pdf` si ya es la versión final).
2. Los textos y recursos en Markdown (`.md`): finalidades, cláusulas, tablas de terceros.
3. Logos, imágenes o plantillas en la misma carpeta, si el documento los usa.

## Formato esperado

- Nombre del documento: `<organizacion>-consentimiento-<vertical>-v<n>.docx`
  (ejemplo: `demo-consentimiento-salud-v1.docx`).
- Los `.md` deben ser texto plano UTF-8, sin dependencias externas ni enlaces rotos.
- Sin macros, sin contraseñas y sin datos personales reales en los ejemplos: usar datos ficticios.
- Si el `.docx` depende de una plantilla o fuente externa, incluir también esa plantilla.

## Qué se extraerá (y se tipificará en el anexo)

| Bloque | Se extrae |
|--------|-----------|
| Finalidades | Para qué se tratan los datos y la base de licitud de cada finalidad |
| Datos tratados | Categorías de datos, datos sensibles y datos de salud |
| Derechos ARCO | Cómo se ejercen acceso, rectificación, cancelación y oposición |
| Retención | Plazos de conservación y criterio de purga o anonimización |
| Terceros | Encargados, transferencias y transferencia internacional |
| Evidencia | Formato de firma o registro, versión del texto y fecha de vigencia |

## Compromiso de borrado

Cuando el contenido quede incorporado al anexo (`docs/crm-maleable/peru-anexo-v1.md`), los
archivos de esta carpeta se eliminan. No se copian a otros directorios, no se incluyen en
controles de versión y no se reutilizan para fines distintos a la redacción del anexo.

## Estado

- [ ] Documento de consentimiento recibido
- [ ] Recursos `.md` recibidos
- [ ] Contenido incorporado al anexo
- [ ] Carpeta purgada
