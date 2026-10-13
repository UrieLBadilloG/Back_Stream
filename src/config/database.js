import mysql from 'mysql2/promise';

import { env } from './env.js';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.name,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  connectTimeout: env.db.connectTimeoutMs,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

export async function checkDatabaseConnection() {
  const [rows] = await pool.query(`
    SELECT
      1 AS connected,
      DATABASE() AS database_name,
      CURRENT_USER() AS authenticated_user,
      VERSION() AS server_version
  `);

  return rows[0];
}

export async function closeDatabasePool() {
  await pool.end();
}
