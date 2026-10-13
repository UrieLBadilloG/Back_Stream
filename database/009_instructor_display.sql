-- 009: instructor visible por curso (NULL = usar el nombre del propietario y el texto por defecto).
ALTER TABLE courses
  ADD COLUMN instructor_name VARCHAR(120) NULL DEFAULT NULL AFTER thumbnail_url,
  ADD COLUMN instructor_title VARCHAR(160) NULL DEFAULT NULL AFTER instructor_name;
