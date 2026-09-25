// Public surface of `@rizoma/contracts`.
//
// Consumers (web today, workers and API later) import only from this entry
// point, so the internal file layout stays free to change. Every schema is a
// plain Zod object: parse to validate a payload, `z.infer` for the static type.
//
// Versioning rule: the modules mirror the `/v1` HTTP surface. A shape change in
// the API services is a change here in the same work unit — never a silent
// drift, because the web client parses with these schemas instead of trusting
// `any`.
export * from './common.ts';
export * from './salud.ts';
export * from './salud-draft.ts';
export * from './imports.ts';
export * from './billing.ts';
export * from './obras.ts';
export * from './obras-operations.ts';
export * from './boards.ts';
export * from './api-keys.ts';
export * from './webhooks.ts';
export * from './notify.ts';
export * from './policy.ts';
export * from './views.ts';
export * from './custom-fields.ts';
export * from './state-transitions.ts';
