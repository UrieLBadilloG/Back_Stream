import app from './app.js';
import {
  checkDatabaseConnection,
  closeDatabasePool,
} from './config/database.js';
import { env } from './config/env.js';
import { collectStartupWarnings } from './lib/startup-warnings.js';

const server = app.listen(env.port, async () => {
  console.log(`API disponible en http://localhost:${env.port}`);
  for (const warning of collectStartupWarnings(env)) console.warn(`[config] ${warning}`);

  try {
    const database = await checkDatabaseConnection();
    console.log(
      `MySQL conectado: ${database.database_name} (${database.server_version})`,
    );
  } catch (error) {
    console.error(`MySQL no disponible: ${error.message}`);
  }
});

server.on('error', (error) => {
  console.error(`No se pudo iniciar el servidor: ${error.message}`);
  process.exitCode = 1;
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`\n${signal} recibido; cerrando servidor...`);

  server.close(async (serverError) => {
    try {
      await closeDatabasePool();
    } catch (databaseError) {
      console.error(`No se pudo cerrar MySQL: ${databaseError.message}`);
      process.exitCode = 1;
    }

    if (serverError) {
      console.error(`No se pudo cerrar HTTP: ${serverError.message}`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
