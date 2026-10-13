CREATE TABLE IF NOT EXISTS course_materials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id BIGINT UNSIGNED NOT NULL,
  type ENUM('file', 'link') NOT NULL,
  title VARCHAR(180) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  url VARCHAR(2048) NOT NULL,
  public_id VARCHAR(255) NULL,
  original_filename VARCHAR(255) NULL,
  mime_type VARCHAR(150) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_course_materials_course (course_id, created_at),
  CONSTRAINT fk_course_materials_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
