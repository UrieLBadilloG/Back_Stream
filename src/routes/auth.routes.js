import bcrypt from 'bcryptjs';
import { Router } from 'express';

import { pool } from '../config/database.js';
import { assert, httpError } from '../lib/http-error.js';
import { normalizeEmail, serializeUser } from '../lib/users.js';
import { createAccessToken, requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

function validateCredentials({ fullName, email, password }, requiresName = false) {
  const normalizedEmail = normalizeEmail(email);
  if (requiresName) {
    assert(typeof fullName === 'string' && fullName.trim().length >= 2 && fullName.trim().length <= 120, 400, 'El nombre debe tener entre 2 y 120 caracteres.');
  }
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail), 400, 'Ingresa un correo válido.');
  assert(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, 'La contraseña debe tener entre 10 y 128 caracteres.');
  return normalizedEmail;
}

function sessionResponse(user) {
  return { user: serializeUser(user), accessToken: createAccessToken(user) };
}

authRouter.post('/register', async (request, response) => {
  const { fullName, email, password } = request.body ?? {};
  const normalizedEmail = validateCredentials({ fullName, email, password }, true);
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const [result] = await pool.execute(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, \'student\')',
      [fullName.trim(), normalizedEmail, passwordHash],
    );
    const [rows] = await pool.execute(
      'SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ?',
      [result.insertId],
    );
    response.status(201).json(sessionResponse(rows[0]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw httpError(409, 'Ya existe una cuenta con ese correo.');
    }
    throw error;
  }
});

authRouter.post('/login', async (request, response) => {
  const { email, password } = request.body ?? {};
  const normalizedEmail = validateCredentials({ email, password });
  const [rows] = await pool.execute(
    'SELECT id, full_name, email, password_hash, role, is_active, created_at FROM users WHERE email = ? LIMIT 1',
    [normalizedEmail],
  );
  const user = rows[0];
  const isValid = user && user.is_active && await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    throw httpError(401, 'Correo o contraseña incorrectos.');
  }
  response.json(sessionResponse(user));
});

authRouter.get('/me', requireAuth, (request, response) => {
  response.json({ user: request.user });
});
