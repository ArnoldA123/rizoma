# Guía de la API pública de Rizoma

Gestión de claves de API y suscripciones a webhooks. Todo lo descrito aquí
está verificado contra el código (`apps/api/src/auth/api-keys*.ts`,
`apps/api/src/webhooks/webhooks*.ts`, `apps/workers/src/webhook-*.ts`).
La referencia formal vive en `openapi.yaml`.

Base: `https://<tu-despliegue>/v1`.

## 1. Emitir una clave de API

Solo un administrador del tenant (`ti_admin` o `direccion`) puede gestionar
claves. Las llamadas autenticadas con `X-Api-Key` reciben `role.denied`;
la gestión requiere una sesión humana de administración.

```bash
curl -X POST https://api.ejemplo.com/v1/api-keys \
  -H "Authorization: Bearer <sesion-admin>" \
  -H "Content-Type: application/json" \
  -d '{"name": "ETL nocturno", "scopes": [], "validTo": null}'
```

Respuesta (201). El campo `secret` (`rizoma_...`) aparece **exactamente una
vez**: guárdelo en un gestor de secretos. El servidor solo conserva su
resumen SHA-256, por lo que un secreto perdido no se puede recuperar;
revoque la clave y emita una nueva.

Listar (`GET /v1/api-keys`) muestra identificación sin secretos (`keyPrefix`
permite saber qué clave es cada fila). Revocar (`POST
/v1/api-keys/:id/revoke`) desactiva la clave con efecto en la próxima
petición; es idempotente. Los campos validados: `name` de 1 a 120
caracteres, `scopes` como arreglo de textos, `validTo` ISO-8601 futuro o
nulo (sin vencimiento).

Las llamadas máquina envían el secreto en la cabecera `X-Api-Key`. Una
clave desconocida, revocada o fuera de vigencia responde 401
`auth.api_key_invalid` sin alternativa (falla cerrada).

## 2. Suscribir un webhook

```bash
curl -X POST https://api.ejemplo.com/v1/webhooks/subscriptions \
  -H "Authorization: Bearer <sesion-admin>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://receptor.ejemplo.com/rizoma", "events": ["invoice.paid", "stock.posted"]}'
```

Respuesta (201). El campo `secret` (`whsec_...`) aparece **exactamente una
vez**: es el secreto de firma HMAC, distinto de las claves `rizoma_`.
Eventos disponibles: `invoice.issued`, `invoice.paid`, `invoice.voided`,
`stock.posted`, `stock.reversed`, `onboarding.closed`. La URL acepta los
esquemas `http` y `https` (use `https` en producción), máximo 2000
caracteres; `events` requiere al menos un evento sin duplicados.

Operación posterior: `GET /v1/webhooks/subscriptions` lista sin secretos;
`PATCH /v1/webhooks/subscriptions/:id` edita `url`, `events` o `active`
(requiere al menos un campo); `POST
/v1/webhooks/subscriptions/:id/rotate` reemplaza el secreto (se muestra una
vez; las entregas ya encoladas conservan sus bytes); `DELETE
/v1/webhooks/subscriptions/:id` elimina solo suscripciones **sin** historial
de entregas: con historial responde 409 `webhook.subscription_in_use` y debe
desactivarla con `PATCH {"active": false}`.

## 3. Verificar la firma

Cada entrega es un `POST` con el cuerpo JSON exacto más cuatro cabeceras:

| Cabecera | Contenido |
|---|---|
| `x-webhook-signature` | `sha256=<hex>` de `HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")` |
| `x-webhook-timestamp` | Segundos Unix del momento de firma |
| `x-webhook-event` | Nombre del evento (`invoice.paid`, ...) |
| `x-webhook-delivery` | Id de entrega, para idempotencia del receptor |

La firma cubre **bytes**, no el objeto interpretado: serialice una vez y
verifique sobre esa cadena. Ejemplo (Node, sin dependencias):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCIA_SEGUNDOS = 300; // Ventana de replay según webhook-signer.ts

export function verificar({ secreto, cuerpo, timestamp, firma, ahoraSeg }) {
  const ahora = ahoraSeg ?? Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(ahora - Number(timestamp)) > TOLERANCIA_SEGUNDOS) return false;
  if (!firma.startsWith('sha256=')) return false;
  const presentado = firma.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/.test(presentado)) return false;
  const esperado = createHmac('sha256', secreto)
    .update(`${timestamp}.${cuerpo}`, 'utf8').digest('hex');
  const a = Buffer.from(presentado, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Reglas: rechace marcas de tiempo fuera de la ventana de 300 segundos,
rechace formatos inválidos sin lanzar excepciones y compare en tiempo
constante. Use `x-webhook-delivery` como clave de idempotencia: una entrega
puede reintentarse y llegar más de una vez.

## 4. Reintentos y observabilidad

Cualquier 2xx marca la entrega como `sent`. Ante otro estado o un error de
transporte, la fila vuelve a `queued` con `next_retry_at` según el
retroceso `[60, 300, 1800, 7200, 21600]` segundos; agotados los reintentos
pasa a `failed`. Los reintentos viven en la fila (no en la cola), por lo que
sobreviven reinicios y son observables:

```bash
curl "https://api.ejemplo.com/v1/webhooks/deliveries?status=failed&event=invoice.paid" \
  -H "Authorization: Bearer <sesion-admin>"
```

`GET /v1/webhooks/deliveries` acepta los filtros opcionales
`subscriptionId`, `status` (`queued`, `sent`, `failed`) y `event`; un filtro
malformado responde 400 en lugar de ignorarse. `GET
/v1/webhooks/deliveries/:id` devuelve una entrega con su estado de reintento
(`attempts`, `nextRetryAt`). Las listas devuelven como máximo 200 filas, de
la más reciente a la más antigua.

## 5. Contadores de uso (`usage_counters`)

El servidor cuenta las llamadas máquina respondidas con 2xx por (tenant,
clave, endpoint, hora UTC): un incremento best-effort que nunca falla la
petición servida. Solo se cuentan llamadas con `X-Api-Key`; el tráfico JWT u
operativo queda fuera. **No existe endpoint público de lectura** para estos
contadores: son observabilidad interna (tabla `usage_counters`,
`metric = 'api.calls'`), no parte de la superficie pública documentada en
`openapi.yaml`.
