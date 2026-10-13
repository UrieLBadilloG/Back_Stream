import { httpError } from './http-error.js';

export const DEFAULT_ACCESS_DAYS = 45;
export const MIN_ACCESS_DAYS = 1;
export const MAX_ACCESS_DAYS = 3650;
export const EXPIRING_SOON_DAYS = 7;

const SECONDS_PER_DAY = 86400;

// Fragmento SELECT: todo el cálculo de tiempo ocurre en MySQL con UTC_TIMESTAMP()
// para no depender de la zona horaria del proceso Node (mysql2 convierte DATETIME a Date local).
export function enrollmentAccessColumns(alias = 'e') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Alias de tabla no válido.');
  return `DATE_FORMAT(${alias}.expires_at, '%Y-%m-%dT%H:%i:%sZ') AS expires_at_iso, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), ${alias}.expires_at) AS access_seconds_remaining`;
}

// Vencimiento para una inscripción NUEVA (snapshot de access_days del curso en este momento). Un placeholder: id del curso.
export const SNAPSHOT_EXPIRES_SQL = `(SELECT CASE WHEN c.access_days IS NULL THEN NULL
  ELSE DATE_ADD(UTC_TIMESTAMP(), INTERVAL c.access_days DAY) END
  FROM courses c WHERE c.id = ?)`;

// Renovación que nunca acorta. Placeholders: enrolled_by_id, enrollment id.
// Sin efecto si la inscripción ya es indefinida (expires_at IS NULL).
export const RENEW_ENROLLMENT_SQL = `UPDATE enrollments e JOIN courses c ON c.id = e.course_id
  SET e.enrolled_by_id = ?, e.expires_at = CASE WHEN c.access_days IS NULL THEN NULL
    ELSE GREATEST(e.expires_at, DATE_ADD(UTC_TIMESTAMP(), INTERVAL c.access_days DAY)) END
  WHERE e.id = ? AND e.expires_at IS NOT NULL`;

// Versión pura de SNAPSHOT_EXPIRES_SQL / RENEW_ENROLLMENT_SQL (mismas reglas), usada en pruebas.
// Sin acceso previo: now + días (o null si el curso es indefinido). Con acceso previo: null se mantiene
// indefinido y un vencimiento nunca se acorta.
export function computeAccessExpiry({ accessDays, existingExpiresAt, now }) {
  if (accessDays === null || accessDays === undefined) return null;
  const nowMs = new Date(now).getTime();
  const candidate = nowMs + Number(accessDays) * SECONDS_PER_DAY * 1000;
  if (existingExpiresAt === undefined) return new Date(candidate);
  if (existingExpiresAt === null) return null;
  return new Date(Math.max(new Date(existingExpiresAt).getTime(), candidate));
}

export function parseAccessDays(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const isDigits = typeof value === 'string' && /^\d{1,5}$/.test(value.trim());
  const days = typeof value === 'number' ? value : isDigits ? Number(value.trim()) : NaN;
  if (!Number.isInteger(days) || days < MIN_ACCESS_DAYS || days > MAX_ACCESS_DAYS) {
    throw httpError(400, 'Los días de acceso deben ser un entero entre 1 y 3650, o null para acceso indefinido.');
  }
  return days;
}

export function describeAccess(row = {}) {
  const iso = row?.expires_at_iso ?? null;
  const rawSeconds = row?.access_seconds_remaining;
  if (!iso || rawSeconds === null || rawSeconds === undefined) {
    return { hasLimit: false, expiresAt: null, daysRemaining: null, isExpired: false, isExpiringSoon: false };
  }
  const seconds = Number(rawSeconds);
  if (seconds <= 0) {
    return { hasLimit: true, expiresAt: iso, daysRemaining: 0, isExpired: true, isExpiringSoon: false };
  }
  const daysRemaining = Math.ceil(seconds / SECONDS_PER_DAY);
  return { hasLimit: true, expiresAt: iso, daysRemaining, isExpired: false, isExpiringSoon: daysRemaining <= EXPIRING_SOON_DAYS };
}

export function formatExpiryDate(iso) {
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function assertEnrollmentActive(row) {
  const access = describeAccess(row);
  if (access.isExpired) {
    throw httpError(403, `Tu acceso a este curso venció el ${formatExpiryDate(access.expiresAt)}.`, true, 'ACCESS_EXPIRED');
  }
}
