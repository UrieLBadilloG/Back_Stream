CREATE TABLE IF NOT EXISTS course_promo_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id BIGINT UNSIGNED NOT NULL,
  image_url VARCHAR(2048) NOT NULL,
  public_id VARCHAR(255) NULL,
  alt_text VARCHAR(200) NULL,
  position INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_course_promo_images_course (course_id, position),
  CONSTRAINT fk_course_promo_images_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE course_materials
  ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'document' AFTER type,
  ADD COLUMN position INT UNSIGNED NOT NULL DEFAULT 0 AFTER category,
  ADD KEY idx_course_materials_order (course_id, position);

UPDATE course_materials m
SET m.position = (SELECT COUNT(*) FROM (SELECT id, course_id FROM course_materials) x WHERE x.course_id = m.course_id AND x.id >= m.id);

ALTER TABLE courses ADD COLUMN certificate_template VARCHAR(64) NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS certificates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  template VARCHAR(64) NOT NULL,
  certificate_code VARCHAR(32) NOT NULL,
  recipient_name VARCHAR(120) NOT NULL,
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_certificates_user_course (user_id, course_id),
  UNIQUE KEY uq_certificates_code (certificate_code),
  KEY idx_certificates_course (course_id),
  CONSTRAINT fk_certificates_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_certificates_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE courses SET certificate_template = 'mujer-legaltech', updated_at = updated_at WHERE title = 'Mujer LegalTech';
