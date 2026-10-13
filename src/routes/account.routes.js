import bcrypt from 'bcryptjs';
import { Router } from 'express';

import { pool } from '../config/database.js';
import { describeAccess, enrollmentAccessColumns } from '../lib/access.js';
import { numberLessons } from '../lib/course-structure.js';
import { assert, httpError } from '../lib/http-error.js';
import { countedLessonSql } from '../lib/quiz-logic.js';
import { instructorDisplay, serializeUser } from '../lib/users.js';
import { requireAuth } from '../middleware/auth.js';

export const accountRouter = Router();

accountRouter.use(requireAuth);

accountRouter.get('/overview', async (request, response) => {
  const [users] = await pool.execute('SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ? LIMIT 1', [request.user.id]);
  const [enrollments] = await pool.execute(
    `SELECT e.id, e.created_at, c.id AS course_id, c.title AS course_title, c.slug AS course_slug, c.status AS course_status, c.price_cents, c.access_days, c.thumbnail_url, c.certificate_template, owner.full_name AS owner_name, c.instructor_name, c.instructor_title,
      (SELECT COUNT(*) FROM course_materials cm WHERE cm.course_id = c.id) AS document_count,
      ${enrollmentAccessColumns('e')},
      COALESCE(lc.lesson_count, 0) AS lesson_count, COALESCE(cp.completed_lessons, 0) AS completed_lessons, cp.last_activity_at
     FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users owner ON owner.id = c.owner_id
     LEFT JOIN (SELECT l.course_id, COUNT(*) AS lesson_count FROM lessons l WHERE ${countedLessonSql('l')} GROUP BY l.course_id) lc ON lc.course_id = c.id
     LEFT JOIN (
       SELECT l.course_id, lp.user_id, COUNT(CASE WHEN lp.completed_at IS NOT NULL AND ${countedLessonSql('l')} THEN 1 END) AS completed_lessons, MAX(lp.updated_at) AS last_activity_at
       FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id GROUP BY l.course_id, lp.user_id
     ) cp ON cp.course_id = c.id AND cp.user_id = e.user_id
     WHERE e.user_id = ? ORDER BY e.created_at DESC`,
    [request.user.id],
  );
  const nextLessonByCourse = new Map();
  if (enrollments.length > 0) {
    const courseIds = enrollments.map((row) => Number(row.course_id));
    const [courseLessons] = await pool.execute(
      `SELECT l.id, l.course_id, l.kind, l.title, l.position, s.position AS section_position, lp.completed_at,
        (${countedLessonSql('l')}) AS is_counted
       FROM lessons l
       LEFT JOIN course_sections s ON s.id = l.section_id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
       WHERE l.course_id IN (${courseIds.map(() => '?').join(', ')})`,
      [request.user.id, ...courseIds],
    );
    for (const courseId of courseIds) {
      const ordered = numberLessons(courseLessons.filter((lesson) => Number(lesson.course_id) === courseId));
      const next = ordered.find((lesson) => Number(lesson.is_counted) === 1 && !lesson.completed_at);
      nextLessonByCourse.set(courseId, next ? { id: Number(next.id), lessonNumber: next.lessonNumber, title: next.title, kind: next.kind } : null);
    }
  }
  const courses = enrollments.map((row) => ({
    enrollmentId: Number(row.id), enrolledAt: row.created_at,
    course: { id: Number(row.course_id), slug: row.course_slug, title: row.course_title, status: row.course_status, priceCents: Number(row.price_cents), accessDays: row.access_days === null ? null : Number(row.access_days), thumbnailUrl: row.thumbnail_url, ownerName: row.owner_name, ...instructorDisplay(row, row.owner_name), hasCertificate: Boolean(row.certificate_template) },
    documentCount: Number(row.document_count), nextLesson: nextLessonByCourse.get(Number(row.course_id)) ?? null,
    lessonCount: Number(row.lesson_count), completedLessons: Number(row.completed_lessons),
    progressPercent: Number(row.lesson_count) > 0 ? Math.round((Number(row.completed_lessons) / Number(row.lesson_count)) * 100) : 0,
    lastActivityAt: row.last_activity_at,
    ...describeAccess(row),
  }));
  response.json({
    user: serializeUser(users[0]),
    metrics: {
      enrolledCourses: courses.length,
      completedCourses: courses.filter((course) => course.lessonCount > 0 && course.completedLessons >= course.lessonCount).length,
      activeCourses: courses.filter((course) => !course.isExpired).length,
      expiringSoonCourses: courses.filter((course) => course.isExpiringSoon).length,
      expiredCourses: courses.filter((course) => course.isExpired).length,
      averageProgress: courses.length ? Math.round(courses.reduce((total, course) => total + course.progressPercent, 0) / courses.length) : 0,
    },
    enrollments: courses,
  });
});

accountRouter.patch('/profile', async (request, response) => {
  const fullName = String(request.body?.fullName ?? '').trim();
  assert(fullName.length >= 2 && fullName.length <= 120, 400, 'El nombre debe tener entre 2 y 120 caracteres.');
  await pool.execute('UPDATE users SET full_name = ? WHERE id = ?', [fullName, request.user.id]);
  const [rows] = await pool.execute('SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ?', [request.user.id]);
  response.json({ user: serializeUser(rows[0]) });
});

accountRouter.post('/change-password', async (request, response) => {
  const currentPassword = request.body?.currentPassword;
  const newPassword = request.body?.newPassword;
  assert(typeof currentPassword === 'string' && currentPassword.length > 0, 400, 'Ingresa tu contraseña actual.');
  assert(typeof newPassword === 'string' && newPassword.length >= 10 && newPassword.length <= 128, 400, 'La contraseña nueva debe tener entre 10 y 128 caracteres.');
  const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [request.user.id]);
  if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw httpError(401, 'La contraseña actual es incorrecta.');
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 12), request.user.id]);
  response.json({ message: 'Contraseña actualizada correctamente.' });
});
