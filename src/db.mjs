import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalDbUrl, isPostgresUrl, toPgParams } from './sql.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim().replace(/^"|"$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function nodeEnv() {
  return process.env.NODE_ENV || 'development';
}

function isProduction() {
  return nodeEnv() === 'production';
}

function sqlitePath() {
  const root = path.join(__dirname, '..');
  const dataDir = path.join(root, 'data');
  return process.env.LLEGUE_DB_PATH || path.join(dataDir, 'llegue.db');
}

function wrapStatement(runGetAll) {
  return {
    get: (...params) => runGetAll('get', params),
    all: (...params) => runGetAll('all', params),
    run: (...params) => runGetAll('run', params),
  };
}

async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = sqlitePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);

  return {
    dialect: 'sqlite',
    persistent: false,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return wrapStatement(async (kind, params) => {
        if (kind === 'get') return stmt.get(...params);
        if (kind === 'all') return stmt.all(...params);
        return stmt.run(...params);
      });
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async ping() {
      raw.prepare('SELECT 1 AS ok').get();
      return true;
    },
    async close() {
      raw.close();
    },
    info() {
      return { dialect: 'sqlite', persistent: false, path: dbPath };
    },
  };
}

function sslConfig(url) {
  if (isLocalDbUrl(url)) return undefined;
  if (/sslmode=disable/i.test(url)) return false;
  if (/sslmode=/i.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

async function openPostgres(databaseUrl) {
  const pg = await import('pg');
  const { Pool } = pg.default ?? pg;
  const poolCfg = {
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 5),
  };
  const ssl = sslConfig(databaseUrl);
  if (ssl !== undefined) poolCfg.ssl = ssl;

  const pool = new Pool(poolCfg);
  await pool.query('SELECT 1');

  return {
    dialect: 'postgres',
    persistent: true,
    prepare(sql) {
      const text = toPgParams(sql);
      return wrapStatement(async (kind, params) => {
        const result = await pool.query(text, params);
        if (kind === 'get') return result.rows[0];
        if (kind === 'all') return result.rows;
        return { changes: result.rowCount ?? 0 };
      });
    },
    async exec(sql) {
      const text = String(sql).replace(/ON CONFLICT\s*\(/gi, 'ON CONFLICT (');
      await pool.query(text);
    },
    async ping() {
      await pool.query('SELECT 1');
      return true;
    },
    async close() {
      await pool.end();
    },
    info() {
      return { dialect: 'postgres', persistent: true };
    },
  };
}

/**
 * Postgres si hay DATABASE_URL.
 * SQLite solo en desarrollo (el disco de Render Free se borra al sleep/redeploy).
 */
export async function openDatabase() {
  const url = String(process.env.DATABASE_URL ?? '').trim();
  if (url) {
    if (!isPostgresUrl(url)) {
      throw new Error(
        'DATABASE_URL debe ser postgres:// o postgresql:// (Neon, Supabase o Render Postgres).',
      );
    }
    return openPostgres(url);
  }
  if (isProduction()) {
    throw new Error(
      'En producción hace falta DATABASE_URL (Postgres). ' +
        'SQLite en el disco de Render se borra al sleep o al redeploy.',
    );
  }
  return openSqlite();
}

export function assertProdJwtSecrets() {
  if (!isProduction()) return;
  const secret = process.env.JWT_SECRET ?? '';
  const refresh = process.env.JWT_REFRESH_SECRET ?? '';
  if (!secret || secret === 'llegue-dev-secret') {
    throw new Error(
      'En producción JWT_SECRET debe estar definido y ser estable (no lo cambies en cada deploy).',
    );
  }
  if (!refresh || refresh === 'llegue-dev-refresh') {
    throw new Error(
      'En producción JWT_REFRESH_SECRET debe estar definido y ser estable (no lo cambies en cada deploy).',
    );
  }
}
