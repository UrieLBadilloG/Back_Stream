import { Router } from 'express';

import { checkDatabaseConnection } from '../config/database.js';

export const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'artifiel-buss-api',
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/db', async (_request, response, next) => {
  try {
    const database = await checkDatabaseConnection();

    response.json({
      status: 'ok',
      database,
      timestamp: new Date().toISOString(),
    });
  } catch (cause) {
    const error = new Error('La base de datos no está disponible', { cause });
    error.statusCode = 503;
    error.expose = true;
    next(error);
  }
});
