// Guard mirror tests — the UI matrix must equal the API matrix, action by action.
//
// These are the tests that make the negative rows explicit: `caja` never reads
// clinical data, `medico` never issues an invoice, `trabajador` holds exactly
// two actions. If someone edits `lib/access.ts` without editing
// `apps/api/src/auth/policy.ts`, the parity assertions here fail first.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTION_CODES,
  ORG_SCOPED_SITE_ROLES,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  decideAccess,
  decideRouteAccess,
  isActionCode,
  isRoleCode,
  permittedActions,
  rolePermitsAction,
  resolveSiteAccess,
} from '../lib/access.ts';
import { matchRoute, navItemsFor, routeAllows, routeByPath, sanitizeNextPath, skinForPath } from '../lib/navigation.ts';

test('matriz: 14 roles del realm y 12 acciones del demo, sin duplicados', () => {
  assert.equal(ROLE_CODES.length, 14);
  assert.equal(new Set(ROLE_CODES).size, 14);
  assert.equal(ACTION_CODES.length, 12);
  assert.equal(new Set(ACTION_CODES).size, 12);
  assert.equal(Object.keys(ROLE_PERMISSIONS).length, 14);
});

test('matriz: solo otorga acciones declaradas', () => {
  for (const role of ROLE_CODES) {
    for (const action of ROLE_PERMISSIONS[role]) {
      assert.ok(isActionCode(action), `acción no declarada: ${action}`);
    }
  }
});

test('caja nunca ve clínica', () => {
  assert.equal(rolePermitsAction('caja', 'invoice.issue'), true);
  assert.equal(rolePermitsAction('caja', 'patient.read'), false);
  assert.equal(rolePermitsAction('caja', 'patient.write'), false);
  assert.equal(rolePermitsAction('caja', 'episode.write'), false);
  assert.equal(rolePermitsAction('caja', 'agenda.read'), false);
  assert.equal(rolePermitsAction('caja', 'attendance.mark'), false);
});

test('médico nunca emite comprobantes', () => {
  assert.equal(rolePermitsAction('medico', 'invoice.issue'), false);
  assert.equal(rolePermitsAction('medico', 'patient.read'), true);
  assert.equal(rolePermitsAction('medico', 'episode.write'), true);
});

test('trabajador solo marca asistencia y lee obra', () => {
  assert.deepEqual(permittedActions('trabajador'), ['attendance.mark', 'site.read']);
  assert.equal(rolePermitsAction('trabajador', 'attendance.approve'), false);
  assert.equal(rolePermitsAction('trabajador', 'stock.consume'), false);
});

test('recepción registra pero no lee la ficha', () => {
  assert.equal(rolePermitsAction('recepcion', 'patient.write'), true);
  assert.equal(rolePermitsAction('recepcion', 'appointment.write'), true);
  assert.equal(rolePermitsAction('recepcion', 'patient.read'), false);
  assert.equal(rolePermitsAction('recepcion', 'episode.write'), false);
});

test('rol o acción desconocidos deniegan por defecto', () => {
  assert.equal(rolePermitsAction('rol_fantasma', 'patient.read'), false);
  assert.equal(rolePermitsAction('medico', 'episode.delete'), false);
  assert.equal(isRoleCode('medico'), true);
  assert.equal(isRoleCode('medico_fantasma'), false);
  assert.deepEqual(permittedActions('rol_fantasma'), []);
});

test('decideAccess respeta el orden de la regla formal', () => {
  const base = {
    userActive: true,
    membershipActive: true,
    now: '2026-09-25T12:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    entityOrgNodeId: 'sede-1',
    scopeSubtree: ['sede-1'],
    rolePermits: true,
    stateAllows: true,
    moduleActive: true,
  } as const;

  assert.deepEqual(decideAccess({ ...base }), { allow: true, reason: 'allow' });
  assert.equal(decideAccess({ ...base, userActive: false }).reason, 'user.inactive');
  assert.equal(decideAccess({ ...base, membershipActive: false }).reason, 'membership.inactive');
  assert.equal(decideAccess({ ...base, now: 'no-es-fecha' }).reason, 'time.invalid');
  assert.equal(
    decideAccess({ ...base, validFrom: '2027-01-01T00:00:00.000Z' }).reason,
    'membership.not_yet_valid',
  );
  assert.equal(
    decideAccess({ ...base, validTo: '2026-01-01T00:00:00.000Z' }).reason,
    'membership.expired',
  );
  assert.equal(
    decideAccess({ ...base, entityOrgNodeId: 'sede-2' }).reason,
    'scope.outside_subtree',
  );
  assert.equal(decideAccess({ ...base, rolePermits: false }).reason, 'role.denied');
  assert.equal(decideAccess({ ...base, stateAllows: false }).reason, 'state.denied');
  assert.equal(decideAccess({ ...base, moduleActive: false }).reason, 'module.inactive');
});

test('resolveSiteAccess: la asignación es la clave, salvo alcance de organización', () => {
  // Assignment present → allowed even without the role grant.
  const assigned = resolveSiteAccess({
    role: 'trabajador',
    siteId: 'obra-1',
    entityOrgNodeId: 'obra-1',
    scopeSubtree: ['obra-1'],
    assignedSiteIds: ['obra-1'],
  });
  assert.deepEqual(assigned, { allow: true, reason: 'allow' });

  // Assignment absent → denied with the API's own reason.
  const unassigned = resolveSiteAccess({
    role: 'trabajador',
    siteId: 'obra-2',
    entityOrgNodeId: 'obra-2',
    scopeSubtree: ['obra-1', 'obra-2'],
    assignedSiteIds: ['obra-1'],
  });
  assert.deepEqual(unassigned, { allow: false, reason: 'no_active_assignment' });

  // Org-scoped manager reaches its subtree without an assignment.
  for (const role of ORG_SCOPED_SITE_ROLES) {
    assert.deepEqual(
      resolveSiteAccess({
        role,
        siteId: 'obra-2',
        entityOrgNodeId: 'obra-2',
        scopeSubtree: ['obra-1', 'obra-2'],
        assignedSiteIds: [],
      }),
      { allow: true, reason: 'allow' },
    );
  }

  // Outside the subtree the central rule denies before the assignment key.
  assert.equal(
    resolveSiteAccess({
      role: 'jefe_obra',
      siteId: 'obra-9',
      entityOrgNodeId: 'obra-9',
      scopeSubtree: ['obra-1', 'obra-2'],
      assignedSiteIds: ['obra-9'],
    }).reason,
    'scope.outside_subtree',
  );

  // A role without site.read never reaches the assignment term.
  assert.equal(
    resolveSiteAccess({
      role: 'vendedor',
      siteId: 'obra-1',
      entityOrgNodeId: 'obra-1',
      scopeSubtree: ['obra-1'],
      assignedSiteIds: ['obra-1'],
    }).reason,
    'role.denied',
  );
});

test('decideRouteAccess: modo any para pacientes, all para el resto', () => {
  const pacientes = decideRouteAccess('recepcion', {
    path: '/salud/pacientes',
    actions: ['patient.read', 'patient.write'],
    mode: 'any',
  });
  assert.equal(pacientes.allow, true);
  assert.deepEqual(pacientes.permitted, ['patient.write']);
  assert.deepEqual(pacientes.denied, ['patient.read']);

  // `all` would refuse the same legitimate role, which is why mode matters.
  const allMode = decideRouteAccess('recepcion', {
    path: '/salud/pacientes',
    actions: ['patient.read', 'patient.write'],
    mode: 'all',
  });
  assert.equal(allMode.allow, false);

  assert.equal(
    decideRouteAccess('caja', {
      path: '/salud/caja',
      actions: ['invoice.issue'],
      mode: 'all',
    }).allow,
    true,
  );
  assert.equal(
    decideRouteAccess('medico', { path: '/salud/caja', actions: ['invoice.issue'], mode: 'all' })
      .reason,
    'role.denied',
  );

  const open = decideRouteAccess('vendedor', { path: '/', actions: [], mode: 'all' });
  assert.equal(open.allow, true);
  assert.equal(open.reason, 'allow');
});

test('registry: cada pantalla del MVP1 tiene ruta, skin y tarea', () => {
  const expected = [
    '/',
    '/salud/pacientes',
    '/salud/agenda',
    '/salud/caja',
    '/obras',
    '/obras/[siteId]',
  ];
  for (const path of expected) {
    const matched = matchRoute(path);
    assert.ok(matched !== undefined, `ruta ausente del registro: ${path}`);
    assert.ok(matched.route.stage.length > 0);
    assert.ok(matched.route.label.length > 0);
  }
  assert.equal(skinForPath('/salud/agenda'), 'salud');
  assert.equal(skinForPath('/obras/[siteId]'), 'obras');
  assert.equal(skinForPath('/'), 'neutral');
  assert.equal(skinForPath('/ruta-inexistente'), 'neutral');
});

test('registry: matchRoute resuelve parámetros dinámicos', () => {
  const matched = matchRoute('/obras/11111111-1111-4111-8111-111111111111');
  assert.equal(matched?.route.path, '/obras/[siteId]');
  assert.equal(matched?.params.siteId, '11111111-1111-4111-8111-111111111111');
  assert.equal(matchRoute('/obras/a/b'), undefined);
});

test('nav: cada rol ve solo lo que puede alcanzar', () => {
  const caja = navItemsFor('caja').map((route) => route.path);
  assert.deepEqual(caja, ['/', '/salud/caja']);
  assert.equal(caja.includes('/salud/imports'), false);
  assert.equal(caja.includes('/obras'), false);

  const medico = navItemsFor('medico').map((route) => route.path);
  assert.deepEqual(medico, ['/', '/salud/pacientes', '/salud/agenda', '/salud/imports']);
  assert.equal(medico.includes('/salud/caja'), false);
  assert.equal(medico.includes('/obras'), false);

  // The construction roles hold `site.read`, so the obras section entry and the
  // static empresa board are advertised; the site detail screen is `navHidden`
  // (a nav link would carry the literal `[siteId]` segment) and the CSV
  // importers need `site.write` or `assignment.write` and stay out.
  const trabajador = navItemsFor('trabajador').map((route) => route.path);
  assert.deepEqual(trabajador, ['/', '/obras', '/obras/tablero']);
  assert.equal(trabajador.includes('/obras/imports'), false);
  assert.equal(trabajador.includes('/salud/imports'), false);

  const gerente = navItemsFor('gerente').map((route) => route.path);
  assert.deepEqual(gerente, ['/', '/obras', '/obras/tablero', '/obras/imports']);

  // Jefatura de obra holds `assignment.write` but not `site.write`: the import
  // entry is `any`, so it is advertised for the workers load it may run.
  const jefeObra = navItemsFor('jefe_obra').map((route) => route.path);
  assert.deepEqual(jefeObra, ['/', '/obras', '/obras/tablero', '/obras/imports']);

  const vendedor = navItemsFor('vendedor').map((route) => route.path);
  assert.deepEqual(vendedor, ['/']);
});

test('nav: tableros e importaciones se anuncian por matriz; la ruta dinámica queda fuera', () => {
  // `/obras/tablero` is static and gated on `site.read`: every construction role
  // that can open the vertical is offered the company board, and no clinical or
  // billing role ever sees it.
  const siteReadRoles = ['auditor', 'gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'];
  for (const role of siteReadRoles) {
    assert.ok(
      navItemsFor(role).some((route) => route.path === '/obras/tablero'),
      `${role} debería ver /obras/tablero`,
    );
  }
  for (const role of ['ti_admin', 'direccion', 'medico', 'enfermeria', 'recepcion', 'caja']) {
    assert.equal(
      navItemsFor(role).some((route) => route.path === '/obras/tablero'),
      false,
      `${role} no debería ver /obras/tablero`,
    );
  }

  // Importers: `any(site.write, assignment.write)` in obras and `patient.write`
  // in salud, so the visible set follows the action each endpoint really needs.
  for (const role of ['gerente', 'jefe_obra']) {
    assert.ok(navItemsFor(role).some((route) => route.path === '/obras/imports'), role);
  }
  for (const role of ['capataz', 'almacen', 'auditor', 'medico', 'caja']) {
    assert.equal(
      navItemsFor(role).some((route) => route.path === '/obras/imports'),
      false,
      `${role} no debería ver /obras/imports`,
    );
  }
  for (const role of ['medico', 'recepcion']) {
    assert.ok(navItemsFor(role).some((route) => route.path === '/salud/imports'), role);
  }
  for (const role of ['caja', 'enfermeria', 'auditor', 'trabajador']) {
    assert.equal(
      navItemsFor(role).some((route) => route.path === '/salud/imports'),
      false,
      `${role} no debería ver /salud/imports`,
    );
  }

  // `/salud/tableros/[role]` needs the `[role]` segment, so it cannot be a nav
  // entry (the link would be unresolvable); it stays `navHidden` and is reached
  // from the screen that owns the role. What is pinned instead is *reachability*,
  // which is the part the role matrix decides.
  assert.equal(routeByPath('/salud/tableros/[role]')?.navHidden, true);
  assert.equal(
    navItemsFor('caja').some((route) => route.path === '/salud/tableros/[role]'),
    false,
  );
  for (const role of ['recepcion', 'caja', 'medico', 'enfermeria', 'auditor']) {
    assert.equal(routeAllows(role, '/salud/tableros/[role]').allow, true, role);
  }
  for (const role of ['trabajador', 'almacen', 'capataz', 'vendedor', 'soporte']) {
    assert.equal(routeAllows(role, '/salud/tableros/[role]').allow, false, role);
  }
});

test('sanitizeNextPath cierra la redirección abierta', () => {
  assert.equal(sanitizeNextPath('/salud/caja'), '/salud/caja');
  assert.equal(sanitizeNextPath('/obras/abc'), '/obras/abc');
  assert.equal(sanitizeNextPath('https://evil.example'), '/');
  assert.equal(sanitizeNextPath('//evil.example'), '/');
  assert.equal(sanitizeNextPath('/ruta-desconocida'), '/');
  assert.equal(sanitizeNextPath('/salud/caja?x=1'), '/salud/caja?x=1');
  assert.equal(sanitizeNextPath(undefined), '/');
  assert.equal(sanitizeNextPath('/salud\\caja'), '/');
});
