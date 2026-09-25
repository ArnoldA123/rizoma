# @rizoma/web — MVP1

Web Next.js 15 (App Router) del MVP1, operando en local contra el API verificado. Datos sintéticos
de demostración; sin datos clínicos reales.

La unidad **W6** cierra la feature: 12 pantallas declaradas (13 rutas de página compiladas, contando
`/_not-found`), los flujos críticos auditados en accesibilidad AA, las comprobaciones de
`scripts/probes/web_probes.sh` y este documento. Cada pantalla sigue exigiendo en la interfaz la
misma acción que el endpoint que consume; el API es la única autoridad.

## Puesta en marcha

```bash
# 1. Contratos (el web los consume desde dist)
npm run build --workspace @rizoma/contracts

# 2. API en http://127.0.0.1:3001
npm run start:dev --workspace @rizoma/api

# 3. Web en http://localhost:3000
npm run dev --workspace @rizoma/web
```

Comprobaciones:

```bash
npm run build     --workspace @rizoma/contracts
npm run build     --workspace @rizoma/web
npm run typecheck --workspace @rizoma/web
npm run test      --workspace @rizoma/web
npm run test      --workspace @rizoma/contracts
npm run test      --workspace @rizoma/api

# Comprobaciones de cierre del web: sin servicios, solo estáticas
bash scripts/probes/web_probes.sh

# Las mismas más las HTTP (requieren web + API + Keycloak arriba)
WEB_PROBE_LIVE=1 bash scripts/probes/web_probes.sh
```

`test` y `typecheck` del web construyen `@rizoma/contracts` antes de ejecutarse, de modo que no
dependen del orden en que se invoquen. `npm run test --workspace @rizoma/web` ejecuta los nueve
archivos enumerados en su script `test` (access, tenant, api-client, proxy, obras-api, obras-query,
board-cache, salud-download, salud-select): si se añade una prueba nueva, se agrega a esa lista,
porque el runner es `node --test` con archivos explícitos.

## Variables de entorno

Todas tienen valor por defecto de demostración, así que el web arranca sin archivo de entorno.
Para sobrescribirlas, crear `apps/web/.env.local` (ignorado por git; nunca versionar secretos).

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `RIZOMA_API_ORIGIN` | `http://127.0.0.1:3001` | Origen del API. Solo servidor. |
| `NEXT_PUBLIC_API_BASE` | — | Alias público del mismo origen; si existe, tiene prioridad. |
| `RIZOMA_WEB_ORIGIN` | `http://localhost:3000` | Origen público del web; de aquí sale la `redirect_uri`. |
| `KEYCLOAK_URL` | `http://localhost:8080` | Igual que en el API. |
| `KEYCLOAK_REALM` | `rizoma` | Igual que en el API. |
| `KEYCLOAK_CLIENT_ID` | `rizoma-web` | Cliente público del realm (`infra/keycloak/realm-rizoma.json`). |
| `RIZOMA_ALLOW_DEV_HEADERS` | `true` fuera de producción | Habilita la identidad local del proxy. |
| `NEXT_PUBLIC_ALLOW_DEV_HEADERS` | `false` | El navegador envía `x-tenant-id`/`x-user-id`/`x-scopes`. |
| `NEXT_PUBLIC_DEV_TENANT_ID` | — | UUID v4 del tenant local. |
| `NEXT_PUBLIC_DEV_USER_ID` | — | UUID del usuario local. |
| `NEXT_PUBLIC_DEV_SCOPES` | — | Alcances separados por espacio o coma. |
| `NEXT_PUBLIC_DEV_ROLE` | — | Rol del realm para el espejo de la guarda (solo interfaz). |
| `NEXT_PUBLIC_DEV_ORG_NODE_ID` | — | Sede que prefijan los formularios cuando el API aún no devolvió una. |
| `WEB_ORIGIN` (probe) | `http://127.0.0.1:3000` | Origen que consulta `web_probes.sh` en modo en vivo. |

`redirect_uri` que debe estar autorizada en el realm:
`http://localhost:3000/api/auth/callback`.

`NEXT_PUBLIC_*` se incorpora en tiempo de compilación: para cambiar la identidad local hay que
reiniciar `next dev` (o recompilar) después de editar el entorno.

`NEXT_PUBLIC_DEV_ROLE` existe porque el API resuelve el rol desde `memberships` en la base de
datos, no desde una cabecera: sin él, una sesión local tendría tenant y usuario pero ningún rol, y
ninguna pantalla sería alcanzable. Afecta solo al espejo de la interfaz — el API autoriza contra la
membresía real, así que un rol inventado aquí engaña a la pantalla pero no abre ningún dato.

## Rutas y roles

La columna «exige» es el espejo literal de la acción que el endpoint detrás de la pantalla vuelve a
decidir. `any` significa que el endpoint no usa una sola acción: la página habilita cada capacidad
por separado en lugar de negar a un rol legítimo.

| Ruta | Pantalla | Exige | Alcanzan |
| --- | --- | --- | --- |
| `/login` | Acceso OIDC y traducción de fallos | — | todos |
| `/` | Inicio: sesión, API, accesos y acciones del rol | — | todos |
| `/salud/pacientes` | Lista y registro de fichas (`any`) | `patient.read` / `patient.write` | médico, enfermería, recepción |
| `/salud/pacientes/[id]` | Ficha 360 (detalle; fuera de la navegación) | `patient.read` | médico, enfermería |
| `/salud/agenda` | Agenda del día y programación de citas | `agenda.read` | recepción, médico, enfermería, auditoría, dirección, ti |
| `/salud/caja` | Turno, cotizaciones, comprobantes y cobros | `invoice.issue` | caja |
| `/salud/imports` | Carga de pacientes por CSV | `patient.write` | recepción, médico |
| `/salud/tableros/[role]` | Tablero de recepción, caja o médico | `any(agenda.read, invoice.issue)` | recepción, caja, médico, enfermería, auditoría, dirección, ti |
| `/obras` | Obras del alcance y tablero de empresa | `site.read` | gerencia, jefatura de obra, capataz, almacén, trabajador, auditoría |
| `/obras/tablero` | Tablero de empresa (subárbol) | `site.read` | los mismos que `/obras` |
| `/obras/imports` | Carga de trabajadores y equipos por CSV | `any(site.write, assignment.write)` | gerencia, jefatura de obra |
| `/obras/[siteId]` | Ficha de obra: personal, asistencia, operación y avance | `site.read` + asignación activa o alcance de organización | gerencia, jefatura de obra, capataz, almacén, trabajador (con asignación) |

`/salud/tableros/[role]` es alcanzable por URL y desde la pantalla que posee el rol, pero no aparece
en la navegación: un enlace de navegación no puede llevar el segmento `[role]`. La página decide dos
veces —el API exige que quien consulta *sea* el rol del tablero y el cliente lo espeja con
`boardRoleFor` antes de emitir la petición.

Operar en una obra es una segunda decisión, independiente de abrir su ficha: exige una asignación
activa, salvo para los roles con alcance de organización (`gerente`, `jefe_obra`). Un trabajador
fuera de obra o con la asignación cerrada ve el motivo (`no_active_assignment`), no un botón que
fallaría.

### Flujos críticos

1. **Registro → consentimiento → cita → cobro → factura.** Recepción registra la ficha y programa
   la cita; la ficha 360 abre consentimientos y episodios; caja emite el comprobante y registra el
   cobro. La ficha clínica no muestra importes y caja no muestra contenido clínico: son dos
   contratos separados por diseño, no dos vistas del mismo objeto.
2. **Asistencia → avance.** La cuadrilla marca su asistencia (la marca es propia: el `userId` nunca
   se envía) y jefatura aprueba; el avance se registra como partida contra una línea de presupuesto
   y el tablero de la obra lo agrega. Un consumo de stock queda en `posted` y descuenta disponible
   de inmediato.

## Cadencia de lectura automática

Los tableros se refrescan en el cliente dentro de una banda explícita y el temporizador se **pausa**
mientras la pestaña está oculta, con un refresco al volver. Cada pantalla dice cuándo leyó por
última vez.

| Pantalla | Banda | Valor inicial | Cómo se cambia |
| --- | --- | --- | --- |
| `/salud/agenda` | 1–5 min | 2 min fijos | — |
| `/salud/tableros/[role]` | 1–5 min | 3 min | botones 1 / 3 / 5 min |
| `/obras/[siteId]` (tablero) | 5–15 min | 10 min | botones 5 / 10 / 15 min |
| `/obras/tablero` | 5–15 min | 10 min | botones 5 / 10 / 15 min |

Las bandas salen de `@rizoma/contracts` (`BOARD_POLL_*`, `OBRAS_BOARD_POLL_*`) y no se escriben a
mano en las pantallas. La banda de obras es más lenta a propósito: un tablero de obra agrega avance,
stock e hitos, y el día operativo no se mueve al ritmo de una cola de recepción.

Además de la lectura automática, cada tablero guarda una **caché de cliente de un minuto** por
identidad de la lectura (`rol|sede|día`, `site|obra|día`, `company|nodo|día`), de modo que cambiar
el día o la sede no deja la pantalla en blanco. Una entrada vencida se descarta al leerla, así que
el mapa no crece con la sesión. Es una caché de *pantalla*, no de decisión: el API sigue siendo la
única fuente de verdad.

## Importaciones CSV: la clave de repetición es el hash del archivo

`POST /v1/salud/imports/patients`, `POST /v1/obras/imports/workers` y
`POST /v1/obras/imports/assets` derivan su clave de repetición del **SHA-256 del CSV**. La pantalla
calcula el mismo digest con `lib/browser-hash.ts` y lo envía como `Idempotency-Key`:

- volver a subir los **mismos bytes** responde el job original —con su CSV de errores— en lugar de
  importar dos veces, venga de la pestaña que venga, incluso después de una respuesta perdida;
- los mismos bytes apuntados a **otra sede** son un `409`, porque es otra intención de carga y no
  un reintento;
- `crypto.subtle` solo existe en contexto seguro, así que la importación exige HTTPS o `localhost`;
  si no está disponible, la operación falla con un mensaje explícito en lugar de viajar con una
  clave aleatoria.

El resto de mutaciones críticas (emisión, cobro, anulación, consentimiento, marca de asistencia)
llevan una clave nueva por **intención** —una por clic, nunca una por reintento—.

El detalle del job devuelve los contadores y, si hubo filas rechazadas, el texto del CSV de errores;
la pantalla lo materializa como descarga con el nombre que llega en `content-disposition` (o el
nombre local `import-<jobId>-errores.csv` cuando el encabezado falta o es inseguro). MVP1 no expone
un listado de importaciones: el identificador del job es la vía de auditoría de una carga anterior.

## Estado local a la sesión (ledgers)

Tres cosas viven solo en la pestaña y están declaradas como tales en la interfaz:

- **Comprobantes de la sesión de caja.** MVP1 no tiene endpoint de listado de comprobantes
  (`GET /v1/billing/invoices/:id` es la única lectura), así que la pantalla conserva los emitidos en
  esta sesión y permite abrir cualquier otro por identificador. Un cobro o una anulación devuelven el
  comprobante actualizado y la fila se reemplaza en el sitio (`mergeInvoice`); uno nuevo entra
  arriba.
- **Identidad del tablero de empresa.** `GET /v1/obras/board` no acepta parámetros: el API agrega el
  subárbol y devuelve el nodo que usó. La clave de caché se construye con la **respuesta** y la
  última identidad se recuerda para que volver a la pantalla no empiece en el esqueleto.
- **Caché de tableros de un minuto** (arriba). Ninguna de las tres es una segunda fuente de verdad.

Las listas del API están capadas a 200 filas y no tienen cursor ni búsqueda, así que el filtro y la
paginación de pacientes y agenda corren en el navegador y el paginador dice cuántas filas de la
página cargada está mostrando.

## Fotos y archivos: solo metadata

MVP1 no tiene endpoints de archivos (`files/` solo expone `paths.ts`), así que **ningún byte de
imagen viaja**:

- la bitácora de obra recibe `attachmentIds` como identificadores y la pantalla lo dice;
- la evidencia de un consentimiento se registra como metadata (tipo y referencia), con la
  advertencia visible de que no hay archivo asociado;
- la descarga del CSV de errores de una importación es la única transferencia de archivo del MVP1, y
  va del API al directorio de descargas del navegador.

## Accesibilidad (AA) en los flujos críticos

Lo verificado en W6, en los dos flujos del enunciado (registro→consentimiento→cita→cobro→factura y
asistencia→avance):

- **Etiquetas e identificadores.** Todo control de formulario tiene `<label htmlFor>` con el mismo
  `id`; los campos que solo se explican por contexto (fecha del tablero, filtro de pacientes,
  identificador de comprobante) usan etiqueta `sr-only`. Las tablas de datos declaran
  `scope="col"` en sus encabezados.
- **Estado programático.** El selector de cadencia de cada tablero expone su opción activa con
  `aria-pressed` y está agrupado con `role="group"` y `aria-label="Lectura automática"`: la elección
  no depende solo del color. El interruptor de la matriz de consentimiento ya usaba
  `role="switch"` + `aria-checked`.
- **Veredictos anunciados.** El mensaje por campo vive ahora en una **región viva estable**
  (`aria-live="polite"` que se monta una vez y solo cambia su texto): una región insertada junto con
  su contenido no se anuncia en todos los lectores de pantalla. El campo inválido lleva además
  `aria-invalid`. La altura reservada pasó de `h-4` a `min-h-4`, así que un mensaje largo envuelve en
  lugar de solaparse con la fila siguiente.
- **Orden de foco.** Los formularios siguen el orden del documento y ninguna superficie usa tabindex
  positivo; los botones de selección de tablero («Preparar consumo», «Preparar lectura», «Usar
  hito») son `<button>` reales, así que responden a Tab, Enter y Espacio.
- **Foco visible.** Un único tratamiento global: `:focus-visible { outline: 2px solid
  var(--base-focus) }`, con 2 px de separación. Ningún componente borra el contorno del navegador
  (`outline: none` / `outline-none` no existe en el código de la interfaz).
- **Contraste en los paneles nuevos** (mínimos medidos sobre los tokens del diseño, texto normal
  exige 4.5:1): `--base-muted` sobre papel 5.0:1 y sobre tarjeta 5.2:1; acento de salud sobre papel
  8.7:1 y sobre su tinte 8.1:1; acento de obras sobre papel 6.5:1 y sobre su tinte 6.1:1; peligro
  sobre su tinte 8.1:1. En tema oscuro: `--base-muted` 7.1:1, acentos 8.4–8.6:1, peligro 9.4:1.
- **Movimiento reducido.** La regla global colapsa transiciones y animaciones; las pieles de salud y
  obras neutralizan su barrido (`sd-*`, `ob-*`) y el CTA magnético no se desplaza (se apaga, no se
  acorta); el desplazamiento suave de la ficha de obra pasa a `auto`. El magnético además ignora
  punteros `touch`.
- **Un CTA magnético por pantalla**, siempre el que envía la intención de esa pantalla.

`bash scripts/probes/web_probes.sh` comprueba estáticamente estos puntos (foco, región viva,
`aria-pressed`, `scope="col"`, ramas de reduced-motion y una comparación numérica de las bandas).
La lista de comprobaciones manuales que requieren una sesión real —denegación visible sin llamadas
previas, recorrido con teclado, `reduce motion`— la imprime el propio probe al terminar.

## Procedencia de los datos y límites de la guarda

La guarda del web es **preventiva, no una frontera de seguridad**: el navegador siempre puede
saltársela, así que cada endpoint del API vuelve a decidir y es la única autoridad. Una denegación
se renderiza con el mismo `{code, reason, traceId}` que devolvería el API y sin ningún dato del
tenant.

## Arquitectura

### Autenticación (Authorization Code + PKCE, resuelta en el servidor)

`/api/auth/login` guarda el verificador PKCE y el `state` en una cookie `HttpOnly` y redirige al
realm. `/api/auth/callback` valida el `state`, canjea el código por tokens y guarda el conjunto en
una cookie de sesión `HttpOnly`. Consecuencias deliberadas:

- El navegador **nunca** ve el token de acceso, así que un XSS no lo puede exfiltrar.
- El endpoint de token se llama desde el servidor: **no hace falta añadir origen CORS a Keycloak**.
- `rizoma-web` es un cliente público, así que PKCE sustituye al secreto.

El middleware de Next solo responde a «¿hay sesión usable?». La autorización no se decide ahí: una
denegación tiene que renderizar su panel con la ruta y el rol que la produjeron, y eso es trabajo
de página (`components/route-guard.tsx`).

### Proxy del API

`apps/api/src/main.ts` no llama a `enableCors`, y el web no lo cambia. Todo llamado del navegador
pasa por el Route Handler `app/api/proxy/[...path]/route.ts`:

| Entrada | Salida |
| --- | --- |
| `/api/proxy/<ruta>` | `${RIZOMA_API_ORIGIN}/v1/<ruta>` |
| `/api/proxy/health` | `${RIZOMA_API_ORIGIN}/health` (fuera del prefijo `/v1`) |
| Cookie de sesión | `Authorization: Bearer <token>` |
| Cabecera entrante `Idempotency-Key` | Reenviada tal cual |
| Cabecera entrante `x-trace-id` | Reenviada; el API la devuelve y el proxy la conserva |
| `x-tenant-id`/`x-user-id`/`x-scopes` | Solo sin sesión y solo fuera de producción |

La respuesta del API se devuelve sin tocar: un 403 sigue siendo 403 y conserva
`{code, reason, traceId}`. El cliente lo tipa con `ApiRequestError`.

### Guarda de interfaz

`lib/access.ts` es un espejo literal de `apps/api/src/auth/guard.ts` y
`apps/api/src/auth/policy.ts`: mismos códigos de acción, misma matriz rol × acción, mismos `reason`
y mismo orden de evaluación. `lib/navigation.ts` declara, por pantalla, las acciones que exige y la
tarea ODD que la entrega; `components/route-guard.tsx` convierte la decisión en una de tres
pantallas: sesión requerida, acceso denegado o la pantalla real —y en ese orden, para que un rol
denegado nunca monte un panel que vaya a leer datos—.

`resolveSiteAccess` reproduce la clave de construcción de `obras.service.ts`: una asignación activa
concede acceso, y los roles con alcance de organización (`gerente`, `jefe_obra`) alcanzan su
subárbol sin asignación. El resto se resuelve con `no_active_assignment`.

### Diseño visual

`app/globals.css` define una rampa neutra única (tinta sobre papel, con borde de línea fina y un
slot de acento) en claro y oscuro invertido, y la expone a Tailwind v4 con `@theme inline` y nombres
de token compatibles con shadcn/ui. Las pieles `salud` y `obras` sobrescriben **solo** el acento
(`--skin-accent`, `--skin-accent-ink`, `--skin-tint`) mediante el atributo `data-skin`; no bifurcan
la base. La trama de fondo es CSS puro (`@utility bg-grid`), conmutable con `data-grid`.

## Estructura

```
apps/web/
  app/
    layout.tsx                 raíz: tema, skin, shell
    page.tsx                   inicio: sesión, API, accesos y capacidades del rol
    login/page.tsx             acceso + traducción de fallos OIDC
    salud/pacientes/page.tsx            registro + lista paginada en cliente
    salud/pacientes/[id]/page.tsx       ficha 360: cabecera, consentimientos, episodios, citas
    salud/agenda/page.tsx               agenda del día + programación
    salud/caja/page.tsx                 turno, cotizaciones, emisión, cobro y anulación
    salud/imports/page.tsx              importación de fichas por CSV
    salud/tableros/[role]/page.tsx      tablero por rol con lectura automática
    obras/page.tsx                      obras del alcance + alta de obra
    obras/[siteId]/page.tsx             ficha: personal, asistencia, equipos, stock, avance, bitácora
    obras/tablero/page.tsx              tablero de empresa
    obras/imports/page.tsx              importación de trabajadores y equipos por CSV
    api/auth/*                 login, callback, logout, session
    api/proxy/[...path]/       proxy del API
  components/                  shell, navegación, paneles por vertical y primitivas ui/
  lib/                         access, navigation, tenant, session, proxy, clientes de vertical, selectores y cachés
  test/                        pruebas de node --test (matriz, transporte, verticales)
  middleware.ts                puerta de autenticación + ruta de la petición
```

Convención de importación: `lib/**` usa extensiones `.ts` explícitas para que los módulos puros
sigan siendo cargables por `node --test`; `app/**` y `components/**` usan la convención de Next.

## Contratos compartidos

`@rizoma/contracts` expone esquemas Zod de los registros que consume el web: fichas, episodios y
citas; consentimientos con su compuerta derivada; caja, cotización, comprobante y pago; obra,
asignación, personal y asistencia; equipos, stock, avance y bitácora; importaciones; y los tableros
de Salud y de Obras. Las respuestas del API se validan en el borde, de modo que un cambio de forma
falla como `api.contract_mismatch` en lugar de propagarse como datos incompletos.

## Alcance diferido (MVP2 / F2)

Fuera de esta entrega, documentado para no confundirlo con un olvido:

- **Triaje y receta.** No hay endpoints (`003_salud.sql` declara las tablas sin controlador): la UI
  muestra estado «no disponible» con un marcador tipificado.
- **Archivos.** Solo `files/paths.ts`; sin subida ni descarga con URL firmada. La bitácora y la
  evidencia de consentimiento degradan a metadata (arriba).
- **Onboarding HTTP.** El servicio existe sin controlador, así que la ruta `/onboarding` no se
  expone en el web.
- **Listado de comprobantes.** Sin `GET /v1/billing/invoices`: el listado de caja es de sesión y la
  lectura es por identificador.
- **Listas de equipos y de stock.** La vertical no expone listados: los identificadores llegan desde
  el tablero de la obra (mantenimiento, stock crítico, hitos) y desde ahí se opera.
- **Paginación por cursor, OpenAPI generado y caché Redis en tableros.** El API capa las listas a 200
  filas y el web pagina en el navegador; los tableros usan la caché de cliente descrita arriba.
- **Webhooks, claves de API públicas, BI completa, builder de flujos, WhatsApp/SMS plenos.** No
  entran en el MVP1.
- **Refresco de token.** La sesión dura 8 horas; al vencer, el middleware redirige a `/login`. El
  `refresh_token` se guarda pero todavía no se usa.
- **Sin E2E de navegador.** No se instaló Playwright ni ningún runner de navegador; la cobertura de
  interfaz es estática (probe) y de lógica pura (`node --test`).
