CREATE TABLE IF NOT EXISTS course_sections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  position INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_course_sections_position (course_id, position),
  KEY idx_course_sections_course (course_id, position),
  CONSTRAINT fk_course_sections_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE lessons
  ADD COLUMN section_id BIGINT UNSIGNED NULL AFTER course_id,
  ADD KEY idx_lessons_section (section_id),
  ADD CONSTRAINT fk_lessons_section FOREIGN KEY (section_id) REFERENCES course_sections (id) ON DELETE SET NULL;

INSERT INTO course_sections (course_id, title, description, position)
SELECT c.id, 'Contenido principal', 'Sección creada para conservar las lecciones existentes.', 1
FROM courses c
WHERE NOT EXISTS (SELECT 1 FROM course_sections s WHERE s.course_id = c.id);

UPDATE lessons l
JOIN course_sections s ON s.course_id = l.course_id AND s.position = 1
SET l.section_id = s.id
WHERE l.section_id IS NULL;
