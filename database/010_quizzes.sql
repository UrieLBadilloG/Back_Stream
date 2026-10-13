-- Evaluaciones (quizzes) entre las clases de un curso. Compatible con MySQL 5.7.
-- Una evaluacion es una fila de lessons con kind quiz mas una fila en quizzes con el mismo id.
-- Las tablas son idempotentes. El ALTER de lessons va al final.

CREATE TABLE IF NOT EXISTS quizzes (
  lesson_id BIGINT UNSIGNED NOT NULL,
  label ENUM('diagnostica', 'repaso', 'final', 'otro') NOT NULL DEFAULT 'otro',
  passing_percent TINYINT UNSIGNED NOT NULL DEFAULT 70,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NULL,
  show_answers ENUM('never', 'after_submit', 'after_pass') NOT NULL DEFAULT 'after_submit',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (lesson_id),
  CONSTRAINT fk_quizzes_lesson FOREIGN KEY (lesson_id) REFERENCES lessons (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_questions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  quiz_id BIGINT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL,
  type ENUM('single', 'multiple', 'true_false') NOT NULL DEFAULT 'single',
  prompt TEXT NOT NULL,
  explanation TEXT NULL,
  points TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_quiz_questions_quiz (quiz_id, position),
  CONSTRAINT fk_quiz_questions_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes (lesson_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  question_id BIGINT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL,
  option_text VARCHAR(500) NOT NULL,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_quiz_options_question (question_id, position),
  CONSTRAINT fk_quiz_options_question FOREIGN KEY (question_id) REFERENCES quiz_questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  quiz_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  attempt_no SMALLINT UNSIGNED NOT NULL,
  earned_points INT UNSIGNED NOT NULL DEFAULT 0,
  total_points INT UNSIGNED NOT NULL DEFAULT 0,
  score_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  correct_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  passed TINYINT(1) NOT NULL DEFAULT 0,
  answers JSON NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quiz_attempts_user_attempt (quiz_id, user_id, attempt_no),
  KEY idx_quiz_attempts_user (user_id, quiz_id),
  KEY idx_quiz_attempts_submitted (quiz_id, submitted_at),
  CONSTRAINT fk_quiz_attempts_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes (lesson_id) ON DELETE CASCADE,
  CONSTRAINT fk_quiz_attempts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE lessons
  ADD COLUMN kind ENUM('video', 'quiz') NOT NULL DEFAULT 'video' AFTER section_id,
  ADD KEY idx_lessons_course_kind (course_id, kind);
