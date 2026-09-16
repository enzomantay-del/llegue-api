const DDL = `
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  family_id TEXT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT,
  pin_hash TEXT,
  birth_date TEXT,
  relationship_label TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  name_hint TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  deep_link_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  pin_hash TEXT,
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  install_id TEXT,
  platform TEXT NOT NULL,
  push_token TEXT,
  location_permission TEXT NOT NULL,
  notifications_permission TEXT NOT NULL,
  permissions_completed_at TEXT,
  last_seen_at TEXT NOT NULL,
  battery_level INTEGER,
  location_ok INTEGER NOT NULL DEFAULT 1,
  app_state TEXT NOT NULL DEFAULT 'unknown',
  app_background_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 60,
  type TEXT NOT NULL DEFAULT 'favorite',
  suggested_by_kid_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id)
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  kid_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  label TEXT NOT NULL,
  days_of_week TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (kid_id) REFERENCES users(id),
  FOREIGN KEY (place_id) REFERENCES places(id)
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  kid_id TEXT NOT NULL,
  routine_id TEXT,
  origin_place_id TEXT,
  destination_place_id TEXT,
  status TEXT NOT NULL,
  expected_return_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  phase TEXT,
  departed_at TEXT,
  created_by_user_id TEXT,
  created_by_name TEXT,
  FOREIGN KEY (kid_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kid_id TEXT NOT NULL,
  trip_id TEXT,
  type TEXT NOT NULL,
  place_id TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  message TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (kid_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (recipient_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS account_profiles (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  email TEXT,
  city TEXT,
  kids_count INTEGER,
  kids_ages TEXT,
  main_concern TEXT,
  how_found TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_places_family ON places(family_id);
CREATE INDEX IF NOT EXISTS idx_routines_kid ON routines(kid_id);
CREATE INDEX IF NOT EXISTS idx_trips_kid_status ON trips(kid_id, status);
CREATE INDEX IF NOT EXISTS idx_events_kid_created ON events(kid_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, created_at);
`;

function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function execStatements(db, sql) {
  if (db.dialect === 'sqlite') {
    await db.exec(sql);
    return;
  }
  for (const stmt of splitStatements(sql)) {
    await db.exec(stmt);
  }
}

async function addColumn(db, table, definition) {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/duplicate column|already exists/i.test(msg)) throw e;
  }
}

async function tryIndex(db, sql) {
  try {
    await db.exec(sql);
  } catch {
    // índice ya existe o hay duplicados nulos
  }
}

/** Tablas Fase 2 — se puede llamar al arrancar para migrar DBs viejas. */
export async function ensureSchema(db) {
  if (db.dialect === 'sqlite') {
    await db.exec('PRAGMA journal_mode = WAL;');
  }

  await execStatements(db, DDL);

  // Migración suave para DBs creadas antes de columnas nuevas
  await addColumn(db, 'devices', 'install_id TEXT');
  await addColumn(db, 'devices', 'location_ok INTEGER NOT NULL DEFAULT 1');
  await addColumn(db, 'devices', `app_state TEXT NOT NULL DEFAULT 'unknown'`);
  await addColumn(db, 'devices', 'app_background_at TEXT');
  await addColumn(db, 'users', 'email TEXT');
  await addColumn(db, 'trips', 'phase TEXT');
  await addColumn(db, 'trips', 'departed_at TEXT');
  await addColumn(db, 'trips', 'created_by_user_id TEXT');
  await addColumn(db, 'trips', 'created_by_name TEXT');

  await tryIndex(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  await tryIndex(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_install ON devices(install_id)`);

  // Radio más preciso: defaults viejos (100 / 120 m del seed) → 60 m
  try {
    await db.prepare(`UPDATE places SET radius_m = 60 WHERE radius_m IN (100, 120)`).run();
  } catch {
    // tabla todavía no existe en installs muy viejas
  }

  // Especiales canceladas: si el destino no es casa/colegio ni tiene rutina, dejar de monitorearlo.
  try {
    await db.exec(`
      UPDATE places SET status = 'inactive'
      WHERE status = 'active'
        AND type NOT IN ('home', 'school')
        AND id IN (
          SELECT destination_place_id FROM trips
          WHERE status = 'cancelled'
            AND routine_id IS NULL
            AND destination_place_id IS NOT NULL
        )
        AND id NOT IN (
          SELECT destination_place_id FROM trips
          WHERE status IN ('active', 'overdue')
            AND destination_place_id IS NOT NULL
        )
        AND id NOT IN (
          SELECT place_id FROM routines WHERE active = 1
        )
    `);
  } catch {
    // tablas todavía no existen en installs muy viejas
  }
}
