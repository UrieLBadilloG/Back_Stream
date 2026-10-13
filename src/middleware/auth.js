import jwt from 'jsonwebtoken';

import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import { httpError } from '../lib/http-error.js';
import { serializeUser } from '../lib/users.js';

export function createAccessToken(user) {
  return jwt.sign(
    { role: user.role },
    env.auth.jwtSecret,
    { subject: String(user.id), expiresIn: env.auth.jwtExpiresIn },
  );
}

export async function requireAuth(request, _response, next) {
  try {
    const [scheme, token] = String(request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw httpError(401, 'Se requiere un token de acceso.');
    }

    const payload = jwt.verify(token, env.auth.jwtSecret);
    const [rows] = await pool.execute(
      'SELECT id, full_name, email, role, is_active, created_at FROM users WHERE id = ? LIMIT 1',
      [payload.sub],
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      throw httpError(401, 'La sesión no es válida o el usuario está inactivo.');
    }

    request.user = serializeUser(user);
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(httpError(401, 'La sesión expiró o no es válida.'));
      return;
    }
    next(error);
  }
}

export function requireRole(...allowedRoles) {
  return (request, _response, next) => {
    if (!request.user || !allowedRoles.includes(request.user.role)) {
      next(httpError(403, 'No tienes permisos para realizar esta acción.'));
      return;
    }
    next();
  };
}
