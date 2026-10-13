import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { closeDatabasePool, pool } from '../src/config/database.js';

if (process.env.APPLY_SCHEMA !== 'true') {
  console.error('Migración bloqueada: usa APPLY_SCHEMA=true solo después de revisar y autorizar los cambios.');
  process.exitCode = 1;
} else {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (filename)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const directory = resolve('database');
    const files = (await readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
    for (const filename of files) {
      const [applied] = await pool.execute('SELECT filename FROM schema_migrations WHERE filename = ? LIMIT 1', [filename]);
      if (applied[0]) continue;
      const sql = await readFile(resolve(directory, filename), 'utf8');
      const statements = sql.split(/;\s*(?:\r?\n|$)/).map((item) => item.replace(/--.*$/gm, '').trim()).filter(Boolean);
      for (const statement of statements) await pool.query(statement);
      await pool.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
      console.log(`Migración aplicada: ${filename}`);
    }
    console.log('Migraciones completadas correctamente.');
  } finally {
    await closeDatabasePool();
  }
}
