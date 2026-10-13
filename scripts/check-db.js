import {
  checkDatabaseConnection,
  closeDatabasePool,
} from '../src/config/database.js';

try {
  const database = await checkDatabaseConnection();
  console.log('Conexión MySQL correcta:');
  console.table(database);
} catch (error) {
  console.error('No se pudo conectar a MySQL.');
  console.error(`Código: ${error.code ?? 'desconocido'}`);
  console.error(`Detalle: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeDatabasePool();
}
