// Spanish UI copy for the shared vocabularies (roles, actions, sections).
//
// Kept out of `access.ts` on purpose: that module mirrors the API's rule and
// must stay language-neutral, while this one is pure presentation. One map per
// vocabulary means the nav, the session chip and the denial panel all name the
// same thing the same way.
//
// The same split governs the Salud catalogs below: `@rizoma/contracts` owns the
// statuses and the validation *codes*, and every Spanish string a user reads
// lives here, so a rule never carries copy and a copy change never touches a
// rule.
import {
  type AppointmentStatus,
  type AttendanceStatus,
  type BillingDocumentType,
  type ConsentStatus,
  type DashboardRole,
  type DraftIssue,
  type DraftIssueCode,
  type DocumentType,
  type SiteStatus,
} from '@rizoma/contracts';
import type { ActionCode, RoleCode } from './access.ts';
import type { SectionId } from './navigation.ts';

/** Role names as the realm describes them, in neutral Spanish. */
export const ROLE_LABELS: Record<RoleCode, string> = {
  ti_admin: 'Admin TI',
  direccion: 'Dirección',
  medico: 'Médico',
  enfermeria: 'Enfermería',
  recepcion: 'Recepción',
  caja: 'Caja',
  auditor: 'Auditor',
  gerente: 'Gerente',
  jefe_obra: 'Jefe de obra',
  almacen: 'Almacén',
  capataz: 'Capataz',
  trabajador: 'Trabajador',
  vendedor: 'Ventas',
  soporte: 'Soporte',
};

/** Human name of an action code, for showing what a role may (not) do. */
export const ACTION_LABELS: Record<ActionCode, string> = {
  'agenda.read': 'Ver la agenda',
  'patient.read': 'Ver la ficha clínica',
  'patient.write': 'Registrar y editar la ficha',
  'episode.write': 'Abrir y cerrar episodios',
  'appointment.write': 'Programar citas',
  'invoice.issue': 'Emitir comprobantes',
  'attendance.mark': 'Marcar asistencia',
  'attendance.approve': 'Aprobar asistencia',
  'stock.consume': 'Consumir stock',
  'site.read': 'Ver la obra',
  'site.write': 'Crear y editar obras',
  'assignment.write': 'Asignar personal',
};

/** Section names for the shell header and the home page. */
export const SECTION_LABELS: Record<SectionId, string> = {
  inicio: 'Inicio',
  salud: 'Salud',
  obras: 'Obras',
};

/** Name of a role code, falling back to a generic Spanish phrase when unknown. */
export function roleLabel(role: string | null | undefined): string {
  if (role === null || role === undefined) return 'Sin rol';
  return ROLE_LABELS[role as RoleCode] ?? 'su rol';
}

/** Name of an action code, falling back to a generic Spanish phrase when unknown. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action as ActionCode] ?? 'esta acción';
}

// ============ Salud catalogs ============

/** §2.3 document catalog, as the form and the file header name it. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  dni: 'DNI',
  ce: 'Carné de extranjería',
  pasaporte: 'Pasaporte',
};

/** Name of a document type as it arrives on a row (a plain string), or the raw value. */
export function documentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABELS[type as DocumentType] ?? type;
}

/** `appointments.status`, in the order the state machine advances. */
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Programada',
  confirmed: 'Confirmada',
  checked_in: 'En espera',
  in_care: 'En atención',
  completed: 'Atendida',
  no_show: 'No asistió',
  cancelled: 'Anulada',
  derived: 'Derivada',
};

/** `episodes.status`: the two states the UI can produce, plus the reserved one. */
export const EPISODE_STATUS_LABELS: Record<string, string> = {
  open: 'Abierto',
  closed: 'Cerrado',
  cancelled: 'Anulado',
};

/** Consent lifecycle of §2.8. */
export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = {
  pending: 'Pendiente de firma',
  signed: 'Firmado',
  revoked: 'Revocado',
  expired: 'Vencido',
};

/** §2.6 recording types, plus the inclusive `todo` scope. */
export const RECORD_TYPE_LABELS: Record<string, string> = {
  imagenes_ayuda: 'Imágenes de ayuda',
  fotografias: 'Fotografías',
  video: 'Video',
  audio: 'Audio',
  todo: 'Todo el alcance',
};

/** Name of an appointment status, falling back to the raw value. */
export function appointmentStatusLabel(status: string): string {
  return APPOINTMENT_STATUS_LABELS[status as AppointmentStatus] ?? status;
}

/** Badge variant for an appointment status, so the day reads at a glance. */
export function appointmentStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'completed') return 'tinted';
  if (status === 'in_care' || status === 'checked_in') return 'accent';
  if (status === 'no_show' || status === 'cancelled') return 'danger';
  return 'outline';
}

/** Badge variant for a consent status. */
export function consentStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'signed') return 'tinted';
  if (status === 'pending') return 'outline';
  if (status === 'revoked' || status === 'expired') return 'danger';
  return 'neutral';
}

/** Name of a recording type, falling back to the raw value. */
export function recordTypeLabel(type: string): string {
  return RECORD_TYPE_LABELS[type] ?? type;
}

/**
 * Spanish copy of the live-validation codes. The codes live in
 * `@rizoma/contracts` (language-neutral, tested); their wording lives here, so
 * the message a user reads never has to travel through the rule.
 */
export const DRAFT_ISSUE_MESSAGES: Record<DraftIssueCode, string> = {
  required: 'Este dato es obligatorio.',
  too_long: 'El texto supera la longitud permitida.',
  invalid_uuid: 'Debe ser un identificador UUID.',
  invalid_date: 'Use una fecha real en formato AAAA-MM-DD.',
  invalid_datetime: 'Use una fecha y hora válidas.',
  invalid_document_type: 'Tipo de documento no admitido.',
  dni_digits: 'Un DNI tiene exactamente 8 dígitos.',
  invalid_sha256: 'La evidencia se sella con 64 caracteres hexadecimales.',
  not_positive_integer: 'Indique minutos enteros, entre 1 y 480.',
  invalid_serie: 'La serie admite de 1 a 8 caracteres alfanuméricos.',
  invalid_document_number: 'El número no corresponde al tipo: 8 dígitos para DNI y 11 para RUC.',
  invalid_amount: 'Indique un importe con hasta dos decimales.',
  invalid_number: 'Indique un número válido dentro del rango admitido.',
  invalid_rate: 'La tasa de IGV va entre 0 y 1 (18 % = 0.18).',
  amount_exceeds_pending: 'El importe supera el saldo pendiente del comprobante.',
};

/** Spanish message of one field issue. */
export function draftIssueMessage(issue: DraftIssue): string {
  return DRAFT_ISSUE_MESSAGES[issue.code];
}

/** True when a check verdict blocks submission. */
export function isBlocking(issue: DraftIssue | null): boolean {
  return issue !== null;
}

// ============ Billing and board catalogs (W3) ============
//
// The statuses live in `@rizoma/contracts` (they are the database CHECK
// constraints); their wording lives here, so a copy change never touches a
// state catalog and a catalog change is a compile error in this file.

/** `invoices.customer_doc_type` catalog, including the fiscal `ruc`. */
export const BILLING_DOCUMENT_TYPE_LABELS: Record<BillingDocumentType, string> = {
  dni: 'DNI',
  ce: 'Carné de extranjería',
  pasaporte: 'Pasaporte',
  ruc: 'RUC',
};

/** Name of a billing document type, falling back to the raw value. */
export function billingDocumentTypeLabel(type: string): string {
  return BILLING_DOCUMENT_TYPE_LABELS[type as BillingDocumentType] ?? type;
}

/** `quotes.status`. */
export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  expired: 'Vencida',
};

/** `invoices.status` — the commercial axis. */
export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  issued: 'Emitido',
  partially_paid: 'Pago parcial',
  paid: 'Pagado',
  voided: 'Anulado',
};

/** `invoices.fiscal_status` — the fiscal axis, independent of the commercial one. */
export const FISCAL_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  sent: 'Enviado',
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  contingency: 'Contingencia',
};

/** `payments.status`. */
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  registered: 'Registrado',
  reconciled: 'Conciliado',
  reversed: 'Revertido',
};

/** Payment methods the caja screen offers one field per. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  plin: 'Plin',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
};

/** `import_jobs.status`. */
export const IMPORT_JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'En cola',
  running: 'En proceso',
  completed: 'Completado',
  failed: 'Fallido',
};

/** Board roles §6.3 ships. */
export const BOARD_ROLE_LABELS: Record<DashboardRole, string> = {
  recepcion: 'Recepción',
  caja: 'Caja',
  medico: 'Médico',
};

/** Name of a quote status, falling back to the raw value. */
export function quoteStatusLabel(status: string): string {
  return QUOTE_STATUS_LABELS[status] ?? status;
}

/** Name of an invoice status, falling back to the raw value. */
export function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABELS[status] ?? status;
}

/** Name of a fiscal status, falling back to the raw value. */
export function fiscalStatusLabel(status: string): string {
  return FISCAL_STATUS_LABELS[status] ?? status;
}

/** Name of a payment method, falling back to the raw value. */
export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/** Name of an import job status, falling back to the raw value. */
export function importJobStatusLabel(status: string): string {
  return IMPORT_JOB_STATUS_LABELS[status] ?? status;
}

/** Name of a board role, falling back to the raw value. */
export function boardRoleLabel(role: string): string {
  return BOARD_ROLE_LABELS[role as DashboardRole] ?? role;
}

/** Badge variant for an invoice status, so a caja list reads at a glance. */
export function invoiceStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'paid') return 'tinted';
  if (status === 'issued') return 'accent';
  if (status === 'partially_paid') return 'outline';
  if (status === 'voided') return 'danger';
  return 'neutral';
}

/**
 * Badge variant for a fiscal status. `pending` is the state the caja screen has
 * to keep visible, so it is the loud one: an invoice the adapter has not accepted
 * yet is not an invoice that is finished.
 */
export function fiscalStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'accepted') return 'tinted';
  if (status === 'pending') return 'accent';
  if (status === 'rejected') return 'danger';
  if (status === 'contingency') return 'outline';
  return 'neutral';
}

// ============ Obras catalogs (W4) ============
//
// The statuses live in `@rizoma/contracts` (they mirror the database CHECKs);
// their wording lives here, so a copy change never touches a state catalog.

/** `sites.status`, in the order the site advances. */
export const SITE_STATUS_LABELS: Record<SiteStatus, string> = {
  planned: 'Planificada',
  active: 'En ejecución',
  suspended: 'Suspendida',
  closing: 'En cierre',
  closed: 'Cerrada',
  cancelled: 'Anulada',
};

/** Name of a site status, falling back to the raw value. */
export function siteStatusLabel(status: string): string {
  return SITE_STATUS_LABELS[status as SiteStatus] ?? status;
}

/** Badge variant for a site status, so the list reads at a glance. */
export function siteStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'active') return 'accent';
  if (status === 'closing') return 'outline';
  if (status === 'closed') return 'tinted';
  if (status === 'suspended') return 'danger';
  if (status === 'cancelled') return 'danger';
  return 'neutral';
}

/** `attendance.status`. */
export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  registered: 'Registrada',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  adjusted: 'Ajustada',
};

/** Name of an attendance status, falling back to the raw value. */
export function attendanceStatusLabel(status: string): string {
  return ATTENDANCE_STATUS_LABELS[status as AttendanceStatus] ?? status;
}

/** Badge variant for an attendance status. */
export function attendanceStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'approved') return 'tinted';
  if (status === 'registered') return 'accent';
  if (status === 'rejected') return 'danger';
  if (status === 'adjusted') return 'outline';
  return 'neutral';
}

/**
 * Labels the assignment form offers for `assignments.role_in_site`. The column
 * is free text in the API (it is the worker's job in *this* obra, not a realm
 * role), so this is a suggestion list the operator may overwrite.
 */
export const SITE_ROLE_SUGGESTIONS: readonly string[] = [
  'capataz',
  'operario',
  'oficial',
  'almacenero',
  'supervisor',
];

/** Spanish copy of the `obra.*` envelope codes the obras screens classify. */
export const OBRA_DENIAL_REASONS: Record<string, string> = {
  no_active_assignment: 'Sin asignación activa a esta obra',
  'scope.outside_subtree': 'La obra queda fuera del subárbol de su organización',
  'membership.expired': 'La membresía venció',
  'role.denied': 'Su rol no habilita esta operación',
  'state.not_registered': 'La marca ya no está registrada',
  'crew.mismatch': 'La marca pertenece a una cuadrilla que no lidera',
  'site.out_of_scope': 'La obra queda fuera de su alcance',
};

/** Spanish sentence for one `obra.*` denial reason, or the raw token. */
export function obraDenialReasonLabel(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason === '') return 'motivo no informado';
  return OBRA_DENIAL_REASONS[reason] ?? reason;
}

// ============ Obras operation catalogs (W5) ============
//
// Same split as the W4 catalogs: `@rizoma/contracts` owns the status values (they
// are the database CHECKs) and this file owns the Spanish wording a person reads.

/** `assets.status`, in the order the state machine advances. */
export const ASSET_STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  assigned: 'Asignado',
  maintenance: 'En mantenimiento',
  retired: 'Retirado',
};

/** `stock_moves.kind`. */
export const STOCK_MOVE_KIND_LABELS: Record<string, string> = {
  in: 'Ingreso',
  out: 'Consumo',
  transfer: 'Transferencia',
};

/** `stock_moves.status`. */
export const STOCK_MOVE_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  posted: 'Contabilizado',
  reversed: 'Revertido',
};

/** `site_logs.status`. */
export const SITE_LOG_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  published: 'Publicada',
};

/** `milestones.status`; `late` is decided by the database clock, not the form. */
export const MILESTONE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  done: 'Cumplido',
  late: 'Vencido',
};

/** `import_jobs.kind` of the two obras importers. */
export const OBRAS_IMPORT_KIND_LABELS: Record<string, string> = {
  workers_csv: 'Trabajadores',
  assets_csv: 'Equipos',
};

/** Name of an asset status, falling back to the raw value. */
export function assetStatusLabel(status: string): string {
  return ASSET_STATUS_LABELS[status] ?? status;
}

/** Badge variant for an asset status. */
export function assetStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'available') return 'tinted';
  if (status === 'assigned') return 'accent';
  if (status === 'retired') return 'danger';
  return 'outline';
}

/** Name of a stock move kind, falling back to the raw value. */
export function stockMoveKindLabel(kind: string): string {
  return STOCK_MOVE_KIND_LABELS[kind] ?? kind;
}

/** Name of a stock move status, falling back to the raw value. */
export function stockMoveStatusLabel(status: string): string {
  return STOCK_MOVE_STATUS_LABELS[status] ?? status;
}

/** Badge variant for a stock move status: `posted` is the live one. */
export function stockMoveStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'posted') return 'tinted';
  if (status === 'reversed') return 'danger';
  return 'outline';
}

/** Name of a site log status, falling back to the raw value. */
export function siteLogStatusLabel(status: string): string {
  return SITE_LOG_STATUS_LABELS[status] ?? status;
}

/** Badge variant for a site log status: a draft is not yet the record. */
export function siteLogStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'published') return 'tinted';
  return 'outline';
}

/** Name of a milestone status, falling back to the raw value. */
export function milestoneStatusLabel(status: string): string {
  return MILESTONE_STATUS_LABELS[status] ?? status;
}

/** Badge variant for a milestone status; `late` is the loud one. */
export function milestoneStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'done') return 'tinted';
  if (status === 'late') return 'danger';
  return 'outline';
}

/** Name of an obras import kind, falling back to the raw value. */
export function obrasImportKindLabel(kind: string): string {
  return OBRAS_IMPORT_KIND_LABELS[kind] ?? kind;
}
