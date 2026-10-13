import bcrypt from 'bcryptjs';
import { Router } from 'express';

import { pool } from '../config/database.js';
import { describeAccess, enrollmentAccessColumns } from '../lib/access.js';
import { numberLessons } from '../lib/course-structure.js';
import { assert, httpError } from '../lib/http-error.js';
import { countedLessonSql } from '../lib/quiz-logic.js';
import { serializeUser } from '../lib/users.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const adminWorkspaceRouter = Router();
export const superWorkspaceRouter = Router();

function idOf(value, label = 'identificador') {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, 400, `El ${label} no es válido.`);
  return id;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((Number(numerator) / Number(denominator)) * 100) : 0;
}

async function managedCourse(user, courseId) {
  const [rows] = await pool.execute('SELECT id, owner_id, title, access_days FROM courses WHERE id = ? LIMIT 1', [courseId]);
  const course = rows[0];
  if (!course) throw httpError(404, 'Curso no encontrado.');
  if (user.role !== 'super_admin' && Number(course.owner_id) !== user.id) {
    throw httpError(403, 'No puedes consultar datos de este curso.');
  }
  return course;
}

async function courseMetrics(user) {
  const where = user.role === 'super_admin' ? '1 = 1' : 'c.owner_id = ?';
  const values = user.role === 'super_admin' ? [] : [user.id];
  const [rows] = await pool.execute(
    `SELECT c.id, c.owner_id, c.title, c.slug, c.status, c.category, c.level, c.thumbnail_url, c.access_days, c.updated_at,
      COALESCE(lc.lesson_count, 0) AS lesson_count,
      COUNT(DISTINCT e.id) AS enrollment_count,
      COUNT(DISTINCT CASE WHEN e.expires_at > UTC_TIMESTAMP() AND e.expires_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY) THEN e.id END) AS expiring_soon_count,
      COUNT(DISTINCT CASE WHEN e.expires_at <= UTC_TIMESTAMP() THEN e.id END) AS expired_count,
      COUNT(DISTINCT CASE WHEN lc.lesson_count > 0 AND COALESCE(cp.completed_lessons, 0) >= lc.lesson_count THEN e.id END) AS completion_count,
      COALESCE(ROUND(AVG(CASE WHEN lc.lesson_count > 0 THEN (100 * COALESCE(cp.completed_lessons, 0) / lc.lesson_count) END)), 0) AS average_progress
     FROM courses c
     LEFT JOIN (SELECT l.course_id, COUNT(*) AS lesson_count FROM lessons l WHERE ${countedLessonSql('l')} GROUP BY l.course_id) lc ON lc.course_id = c.id
     LEFT JOIN enrollments e ON e.course_id = c.id
     LEFT JOIN (
       SELECT l.course_id, lp.user_id, COUNT(*) AS completed_lessons
       FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
       WHERE lp.completed_at IS NOT NULL AND ${countedLessonSql('l')}
       GROUP BY l.course_id, lp.user_id
     ) cp ON cp.course_id = c.id AND cp.user_id = e.user_id
     WHERE ${where}
     GROUP BY c.id, c.owner_id, c.title, c.slug, c.status, c.category, c.level, c.thumbnail_url, c.access_days, c.updated_at, lc.lesson_count
     ORDER BY c.updated_at DESC`,
    values,
  );
  return rows.map((row) => ({
    id: Number(row.id), ownerId: Number(row.owner_id), title: row.title, slug: row.slug, status: row.status,
    category: row.category, level: row.level, thumbnailUrl: row.thumbnail_url, updatedAt: row.updated_at,
    lessonCount: Number(row.lesson_count), enrollmentCount: Number(row.enrollment_count),
    completionCount: Number(row.completion_count), averageProgress: Number(row.average_progress),
    accessDays: row.access_days === null ? null : Number(row.access_days),
    expiringSoonCount: Number(row.expiring_soon_count), expiredCount: Number(row.expired_count),
  }));
}

adminWorkspaceRouter.use(requireAuth, requireRole('admin', 'super_admin'));

adminWorkspaceRouter.get('/overview', async (request, response) => {
  const courses = await courseMetrics(request.user);
  response.json({
    metrics: {
      totalCourses: courses.length,
      publishedCourses: courses.filter((course) => course.status === 'published').length,
      draftCourses: courses.filter((course) => course.status === 'draft').length,
      totalEnrollments: courses.reduce((total, course) => total + course.enrollmentCount, 0),
      totalCompletions: courses.reduce((total, course) => total + course.completionCount, 0),
      expiringSoonEnrollments: courses.reduce((total, course) => total + course.expiringSoonCount, 0),
      expiredEnrollments: courses.reduce((total, course) => total + course.expiredCount, 0),
    },
    courses,
  });
});

adminWorkspaceRouter.get('/courses/:courseId/students', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'curso');
  const course = await managedCourse(request.user, courseId);
  const [[lessonCount]] = await pool.execute(`SELECT COUNT(*) AS lesson_count FROM lessons l WHERE l.course_id = ? AND ${countedLessonSql('l')}`, [courseId]);
  const [rows] = await pool.execute(
    `SELECT e.id AS enrollment_id, e.created_at AS enrolled_at, ${enrollmentAccessColumns('e')}, u.id, u.full_name, u.email, u.is_active,
      COALESCE(lc.lesson_count, 0) AS lesson_count, COALESCE(cp.completed_lessons, 0) AS completed_lessons,
      cp.last_activity_at,
      EXISTS(SELECT 1 FROM certificates ct WHERE ct.user_id = e.user_id AND ct.course_id = e.course_id) AS certificate_issued
     FROM enrollments e
     JOIN users u ON u.id = e.user_id
     LEFT JOIN (SELECT l.course_id, COUNT(*) AS lesson_count FROM lessons l WHERE ${countedLessonSql('l')} GROUP BY l.course_id) lc ON lc.course_id = e.course_id
     LEFT JOIN (
       SELECT l.course_id, lp.user_id, COUNT(CASE WHEN lp.completed_at IS NOT NULL AND ${countedLessonSql('l')} THEN 1 END) AS completed_lessons, MAX(lp.updated_at) AS last_activity_at
       FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
       GROUP BY l.course_id, lp.user_id
     ) cp ON cp.course_id = e.course_id AND cp.user_id = e.user_id
     WHERE e.course_id = ? ORDER BY e.created_at DESC`,
    [courseId],
  );
  response.json({
    course: { id: Number(course.id), title: course.title, accessDays: course.access_days === null ? null : Number(course.access_days), lessonCount: Number(lessonCount.lesson_count) },
    students: rows.map((row) => ({
      enrollmentId: Number(row.enrollment_id), id: Number(row.id), fullName: row.full_name, email: row.email,
      isActive: Boolean(row.is_active), enrolledAt: row.enrolled_at, lessonCount: Number(row.lesson_count),
      completedLessons: Number(row.completed_lessons), progressPercent: percent(row.completed_lessons, row.lesson_count),
      lastActivityAt: row.last_activity_at, certificateIssued: Boolean(row.certificate_issued), ...describeAccess(row),
    })),
  });
});

adminWorkspaceRouter.get('/courses/:courseId/students/:userId/progress', async (request, response) => {
  const courseId = idOf(request.params.courseId, 'curso');
  const userId = idOf(request.params.userId, 'alumno');
  await managedCourse(request.user, courseId);
  const [students] = await pool.execute(
    'SELECT u.id, u.full_name FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? AND e.user_id = ? LIMIT 1',
    [courseId, userId],
  );
  if (!students[0]) throw httpError(404, 'El alumno no está inscrito en este curso.');
  const [lessons] = await pool.execute(
    `SELECT l.id, l.kind, l.title, l.position, l.duration_seconds, s.title AS section_title, s.position AS section_position,
      lp.completed_at, lp.last_position_seconds, lp.updated_at,
      q.is_required AS quiz_is_required, q.passing_percent AS quiz_passing_percent,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = l.id) AS quiz_question_count
     FROM lessons l
     LEFT JOIN course_sections s ON s.id = l.section_id
     LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
     LEFT JOIN quizzes q ON q.lesson_id = l.id
     WHERE l.course_id = ? ORDER BY COALESCE(s.position, 0) ASC, l.position ASC`,
    [userId, courseId],
  );
  const [attemptRows] = await pool.execute(
    'SELECT a.quiz_id, COUNT(*) AS attempts, MAX(a.score_percent) AS best, MAX(a.passed) AS passed, MAX(a.submitted_at) AS last_attempt_at FROM quiz_attempts a JOIN lessons l ON l.id = a.quiz_id WHERE l.course_id = ? AND a.user_id = ? GROUP BY a.quiz_id',
    [courseId, userId],
  );
  const attemptsByQuiz = new Map(attemptRows.map((row) => [Number(row.quiz_id), row]));
  response.json({
    student: { id: Number(students[0].id), fullName: students[0].full_name },
    lessons: numberLessons(lessons).map((lesson) => {
      const attempts = attemptsByQuiz.get(Number(lesson.id));
      return {
        id: Number(lesson.id), kind: lesson.kind, title: lesson.title, sectionTitle: lesson.section_title || 'Contenido principal', position: Number(lesson.position), lessonNumber: lesson.lessonNumber,
        durationSeconds: Number(lesson.duration_seconds), completedAt: lesson.completed_at ?? null,
        lastPositionSeconds: Number(lesson.last_position_seconds ?? 0), updatedAt: lesson.updated_at ?? null,
        ...(lesson.kind === 'quiz' ? { quiz: { isRequired: Boolean(lesson.quiz_is_required), passingPercent: Number(lesson.quiz_passing_percent), questionCount: Number(lesson.quiz_question_count), attempts: attempts ? Number(attempts.attempts) : 0, bestScorePercent: attempts?.best === null || attempts === undefined ? null : Number(attempts.best), passed: attempts ? Boolean(attempts.passed) : false, lastAttemptAt: attempts?.last_attempt_at ?? null } } : {}),
      };
    }),
  });
});

superWorkspaceRouter.use(requireAuth, requireRole('super_admin'));

superWorkspaceRouter.get('/overview', async (_request, response) => {
  const [[users]] = await pool.execute(
    `SELECT COUNT(*) AS total_users, SUM(is_active = 1) AS active_users,
      SUM(role = 'student') AS students, SUM(role = 'admin') AS admins, SUM(role = 'super_admin') AS super_admins
     FROM users`,
  );
  const [[courses]] = await pool.execute(
    `SELECT COUNT(*) AS total_courses, SUM(status = 'published') AS published_courses,
      SUM(status = 'draft') AS draft_courses FROM courses`,
  );
  const [[enrollments]] = await pool.execute(
    `SELECT COUNT(*) AS total_enrollments,
      COALESCE(SUM(expires_at > UTC_TIMESTAMP() AND expires_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY)), 0) AS expiring_soon_enrollments,
      COALESCE(SUM(expires_at <= UTC_TIMESTAMP()), 0) AS expired_enrollments
     FROM enrollments`,
  );
  const [[completions]] = await pool.execute(
    `SELECT COUNT(*) AS completed_enrollments FROM (
       SELECT e.id
       FROM enrollments e
       JOIN (SELECT l.course_id, COUNT(*) AS lesson_count FROM lessons l WHERE ${countedLessonSql('l')} GROUP BY l.course_id) lc ON lc.course_id = e.course_id
       LEFT JOIN (
         SELECT l.course_id, lp.user_id, COUNT(*) AS completed_lessons
         FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
         WHERE lp.completed_at IS NOT NULL AND ${countedLessonSql('l')} GROUP BY l.course_id, lp.user_id
       ) cp ON cp.course_id = e.course_id AND cp.user_id = e.user_id
       WHERE lc.lesson_count > 0 AND COALESCE(cp.completed_lessons, 0) >= lc.lesson_count
     ) completed`,
  );
  response.json({
    metrics: {
      totalUsers: Number(users.total_users), activeUsers: Number(users.active_users || 0), students: Number(users.students || 0),
      admins: Number(users.admins || 0), superAdmins: Number(users.super_admins || 0),
      totalCourses: Number(courses.total_courses), publishedCourses: Number(courses.published_courses || 0),
      draftCourses: Number(courses.draft_courses || 0), totalEnrollments: Number(enrollments.total_enrollments),
      completedEnrollments: Number(completions.completed_enrollments),
      expiringSoonEnrollments: Number(enrollments.expiring_soon_enrollments), expiredEnrollments: Number(enrollments.expired_enrollments),
    },
  });
});

superWorkspaceRouter.get('/users/:userId', async (request, response) => {
  const userId = idOf(request.params.userId, 'usuario');
  const [users] = await pool.execute('SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ? LIMIT 1', [userId]);
  const user = users[0];
  if (!user) throw httpError(404, 'Usuario no encontrado.');
  const [ownedCourses] = await pool.execute(
    `SELECT c.id, c.title, c.status, c.updated_at, COUNT(DISTINCT e.id) AS enrollment_count
     FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id WHERE c.owner_id = ?
     GROUP BY c.id, c.title, c.status, c.updated_at ORDER BY c.updated_at DESC`, [userId],
  );
  const [enrollments] = await pool.execute(
    `SELECT e.id, e.created_at, ${enrollmentAccessColumns('e')}, c.id AS course_id, c.title AS course_title, c.status AS course_status, c.access_days, owner.full_name AS owner_name,
      COALESCE(lc.lesson_count, 0) AS lesson_count, COALESCE(cp.completed_lessons, 0) AS completed_lessons, cp.last_activity_at
     FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users owner ON owner.id = c.owner_id
     LEFT JOIN (SELECT l.course_id, COUNT(*) AS lesson_count FROM lessons l WHERE ${countedLessonSql('l')} GROUP BY l.course_id) lc ON lc.course_id = c.id
     LEFT JOIN (
       SELECT l.course_id, lp.user_id, COUNT(CASE WHEN lp.completed_at IS NOT NULL AND ${countedLessonSql('l')} THEN 1 END) AS completed_lessons, MAX(lp.updated_at) AS last_activity_at
       FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id GROUP BY l.course_id, lp.user_id
     ) cp ON cp.course_id = c.id AND cp.user_id = e.user_id
     WHERE e.user_id = ? ORDER BY e.created_at DESC`, [userId],
  );
  response.json({
    user: serializeUser(user),
    ownedCourses: ownedCourses.map((course) => ({ id: Number(course.id), title: course.title, status: course.status, updatedAt: course.updated_at, enrollmentCount: Number(course.enrollment_count) })),
    enrollments: enrollments.map((enrollment) => ({ id: Number(enrollment.id), enrolledAt: enrollment.created_at, course: { id: Number(enrollment.course_id), title: enrollment.course_title, status: enrollment.course_status, accessDays: enrollment.access_days === null ? null : Number(enrollment.access_days), ownerName: enrollment.owner_name }, lessonCount: Number(enrollment.lesson_count), completedLessons: Number(enrollment.completed_lessons), progressPercent: percent(enrollment.completed_lessons, enrollment.lesson_count), lastActivityAt: enrollment.last_activity_at, ...describeAccess(enrollment) })),
  });
});

superWorkspaceRouter.get('/enrollments', async (_request, response) => {
  const [rows] = await pool.execute(
    `SELECT e.id, e.created_at, ${enrollmentAccessColumns('e')}, student.id AS student_id, student.full_name AS student_name, student.email AS student_email,
      c.id AS course_id, c.title AS course_title, c.access_days, owner.full_name AS owner_name,
      granted.full_name AS granted_by_name
     FROM enrollments e JOIN users student ON student.id = e.user_id JOIN courses c ON c.id = e.course_id
     JOIN users owner ON owner.id = c.owner_id LEFT JOIN users granted ON granted.id = e.enrolled_by_id
     ORDER BY e.created_at DESC LIMIT 500`,
  );
  response.json({ enrollments: rows.map((row) => ({ id: Number(row.id), enrolledAt: row.created_at, student: { id: Number(row.student_id), fullName: row.student_name, email: row.student_email }, course: { id: Number(row.course_id), title: row.course_title, accessDays: row.access_days === null ? null : Number(row.access_days), ownerName: row.owner_name }, grantedByName: row.granted_by_name, ...describeAccess(row) })) });
});

superWorkspaceRouter.delete('/enrollments/:enrollmentId', async (request, response) => {
  const enrollmentId = idOf(request.params.enrollmentId, 'inscripción');
  const [result] = await pool.execute('DELETE FROM enrollments WHERE id = ?', [enrollmentId]);
  if (!result.affectedRows) throw httpError(404, 'Inscripción no encontrada.');
  response.status(204).end();
});

superWorkspaceRouter.post('/users/:userId/reset-password', async (request, response) => {
  const userId = idOf(request.params.userId, 'usuario');
  if (userId === request.user.id) throw httpError(400, 'Usa el cambio de contraseña de tu perfil para modificar tu propia contraseña.');
  const password = request.body?.password;
  assert(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, 'La contraseña debe tener entre 10 y 128 caracteres.');
  const [result] = await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), userId]);
  if (!result.affectedRows) throw httpError(404, 'Usuario no encontrado.');
  response.json({ message: 'Contraseña restablecida correctamente.' });
});
