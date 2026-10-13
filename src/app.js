import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { accountRouter } from './routes/account.routes.js';
import { categoriesAdminRouter, categoriesRouter } from './routes/categories.routes.js';
import { certificatesRouter } from './routes/certificates.routes.js';
import { certificatePublicRouter } from './routes/certificates-public.routes.js';
import { courseBuilderRouter } from './routes/course-builder.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { coursesRouter } from './routes/courses.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { managementRouter, superAdminRouter } from './routes/management.routes.js';
import { adminPaymentsRouter, paymentsRouter, superPaymentsRouter } from './routes/payments.routes.js';
import { quizzesAdminRouter, quizzesLearnerRouter } from './routes/quizzes.routes.js';
import { uploadsRouter } from './routes/uploads.routes.js';
import { certificateShareRouter, shareConfigRouter, shareRouter } from './routes/share.routes.js';
import { adminWorkspaceRouter, superWorkspaceRouter } from './routes/workspaces.routes.js';

const app = express();

app.disable('x-powered-by');
// Detrás de un proxy (Render, Railway, Nginx, Cloudflare) request.ip sería la IP del proxy: fija TRUST_PROXY.
if (env.trustProxy !== false) app.set('trust proxy', env.trustProxy);
app.use(helmet());
const localDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

app.use(
  cors({
    // Permite al navegador leer el código de la constancia en descargas cross-origin.
    exposedHeaders: ['Content-Disposition', 'X-Certificate-Code'],
    origin(origin, callback) {
      // Requests sin Origin (curl, server-to-server) no pasan por CORS.
      if (!origin) return callback(null, true);
      if (env.corsOrigin === '*' || env.corsOrigin.split(',').map((item) => item.trim()).includes(origin)) {
        return callback(null, origin);
      }
      // En desarrollo, Vite puede cambiar de puerto si el 5173 está ocupado.
      if (env.nodeEnv !== 'production' && localDevOrigin.test(origin)) {
        return callback(null, origin);
      }
      return callback(null, false);
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/', (_request, response) => {
  response.json({
    name: 'artifiel-buss-api',
    status: 'ok',
    endpoints: {
      health: '/api/health',
      databaseHealth: '/api/health/db',
      auth: '/api/auth',
      courses: '/api/courses',
      management: '/api/admin',
      superAdministration: '/api/super',
      uploads: '/api/uploads/signature',
      instructorWorkspace: '/api/admin/overview',
      superWorkspace: '/api/super/overview',
      account: '/api/account/overview',
      categories: '/api/categories',
      payments: '/api/payments',
      certificates: '/api/certificates/verify/:code',
      share: '/c/:slug',
      certificateShare: '/v/:code',
      courseEditor: '/api/admin/courses/:courseId/editor',
    },
  });
});

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/account', accountRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/super/payments', superPaymentsRouter);
app.use('/api/admin/payments', adminPaymentsRouter);
app.use('/api/admin', courseBuilderRouter);
app.use('/api/admin', quizzesAdminRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/courses', certificatesRouter);
app.use('/api/courses', quizzesLearnerRouter);
app.use('/api/certificates', certificatePublicRouter);
app.use('/c', shareRouter);
app.use('/v', certificateShareRouter);
app.use('/api/share', shareConfigRouter);
app.use('/api/admin', managementRouter);
app.use('/api/super', superAdminRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/admin', adminWorkspaceRouter);
app.use('/api/super', superWorkspaceRouter);
app.use('/api/super/categories', categoriesAdminRouter);

app.use((request, response) => {
  response.status(404).json({
    status: 'error',
    message: `Ruta no encontrada: ${request.method} ${request.originalUrl}`,
  });
});

app.use((error, _request, response, _next) => {
  const statusCode = Number.isInteger(error.statusCode)
    ? error.statusCode
    : 500;

  if (statusCode >= 500) {
    console.error(error.cause ?? error);
  }

  response.status(statusCode).json({
    status: 'error',
    message: error.expose ? error.message : 'Error interno del servidor',
    ...(error.expose && error.publicCode ? { code: error.publicCode } : {}),
  });
});

export default app;
