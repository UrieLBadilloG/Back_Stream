export const ROLES = Object.freeze(['student', 'admin', 'super_admin']);

export function serializeUser(user) {
  return {
    id: Number(user.id),
    fullName: user.full_name,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    createdAt: user.created_at,
  };
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Instructor visible para alumnos: override del curso o, si no hay, el nombre del propietario.
export function instructorDisplay(row, ownerName) {
  const name = String(row.instructor_name ?? '').trim();
  const title = String(row.instructor_title ?? '').trim();
  return { instructorName: name || ownerName, instructorTitle: title || null };
}

export function isCourseManager(user, course) {
  return user.role === 'super_admin' || Number(course.owner_id) === Number(user.id);
}
