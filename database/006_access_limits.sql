-- 006: límites de acceso por curso e inscripción (NULL = indefinido / sin vencimiento).
ALTER TABLE courses
  ADD COLUMN access_days INT NULL DEFAULT NULL AFTER price_cents;
ALTER TABLE enrollments
  ADD COLUMN expires_at DATETIME NULL DEFAULT NULL AFTER enrolled_by_id,
  ADD KEY idx_enrollments_course_expires (course_id, expires_at);
