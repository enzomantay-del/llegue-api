/**
 * Vacía todas las tablas. No borra la estructura.
 *
 * NO se ejecuta solo. Hace falta confirmación:
 *   npm run reset-db -- BORRAR
 *   o  RESET_CONFIRM=yes npm run reset-db
 *
 * Si hay DATABASE_URL (Neon), borra ESA base. No imprime la contraseña.
 */
import { openDatabase } from './db.mjs';
import { ensureSchema } from './schema.mjs';

const TABLES = [
  'notifications',
  'events',
  'alert_prefs',
  'routines',
  'trips',
  'places',
  'invitations',
  'devices',
  'otp_codes',
  'refresh_tokens',
  'account_profiles',
  'users',
  'families',
];

function confirmed() {
  if (process.env.RESET_CONFIRM === 'yes') return true;
  return process.argv.slice(2).includes('BORRAR');
}

async function count(db, table) {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

async function main() {
  if (!confirmed()) {
    console.error('Esto borra TODAS las familias, personas, lugares, avisos y sesiones.');
    console.error('La estructura de las tablas se conserva.');
    console.error('');
    console.error('Para confirmar, en la carpeta llegue-api:');
    console.error('  npm run reset-db -- BORRAR');
    console.error('');
    console.error('Si DATABASE_URL apunta a Neon, se borra esa base (producción).');
    process.exit(1);
  }

  const db = await openDatabase();
  await ensureSchema(db);
  const info = typeof db.info === 'function' ? db.info() : { dialect: db.dialect };
  console.log(`Base: ${info.dialect || db.dialect}`);
  if ((info.dialect || db.dialect) === 'postgres') {
    console.log('ATENCIÓN: es Postgres (Neon / producción). Se van a borrar los datos.');
  }

  let total = 0;
  for (const table of TABLES) {
    const before = await count(db, table);
    if (before === 0) {
      console.log(`${table}: 0`);
      continue;
    }
    await db.prepare(`DELETE FROM ${table}`).run();
    const after = await count(db, table);
    const removed = before - after;
    total += removed;
    console.log(`${table}: ${removed} filas borradas`);
  }
  console.log(`Total filas borradas: ${total}`);
  const users = await count(db, 'users');
  console.log(`users ahora: ${users}`);
  await db.close?.();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
