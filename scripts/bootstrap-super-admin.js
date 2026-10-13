import bcrypt from 'bcryptjs';

import { closeDatabasePool, pool } from '../src/config/database.js';
import { normalizeEmail } from '../src/lib/users.js';

const name = String(process.env.BOOTSTRAP_SUPER_ADMIN_NAME ?? '').trim();
const email = normalizeEmail(process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL);
const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD ?? '';

if (!name || !email || password.length < 10) {
  console.error('Define BOOTSTRAP_SUPER_ADMIN_NAME, BOOTSTRAP_SUPER_ADMIN_EMAIL y BOOTSTRAP_SUPER_ADMIN_PASSWORD (mínimo 10 caracteres).');
  process.exitCode = 1;
} else {
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing[0]) throw new Error('Ya existe un usuario con ese correo; no se modificó nada.');
    await pool.execute('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, \'super_admin\')', [name, email, await bcrypt.hash(password, 12)]);
    console.log('Super administrador creado correctamente.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDatabasePool();
  }
}
