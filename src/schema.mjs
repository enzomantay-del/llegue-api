/** Tablas Fase 2 — se puede llamar al arrancar para migrar DBs viejas. */
export function ensureSchema(db) {
  db.exec(`
PRAGMA journal_mode = WAL;

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

CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_places_family ON places(family_id);
CREATE INDEX IF NOT EXISTS idx_routines_kid ON routines(kid_id);
CREATE INDEX IF NOT EXISTS idx_trips_kid_status ON trips(kid_id, status);
CREATE INDEX IF NOT EXISTS idx_events_kid_created ON events(kid_id, created_at);
CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, created_at);
`);

  // Migración suave para DBs creadas antes de install_id / location_ok
  const cols = db.prepare(`PRAGMA table_info(devices)`).all().map((c) => c.name);
  if (!cols.includes('install_id')) {
    db.exec(`ALTER TABLE devices ADD COLUMN install_id TEXT`);
  }
  if (!cols.includes('location_ok')) {
    db.exec(`ALTER TABLE devices ADD COLUMN location_ok INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.includes('app_state')) {
    db.exec(`ALTER TABLE devices ADD COLUMN app_state TEXT NOT NULL DEFAULT 'unknown'`);
  }
  if (!cols.includes('app_background_at')) {
    db.exec(`ALTER TABLE devices ADD COLUMN app_background_at TEXT`);
  }
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!userCols.includes('email')) {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  } catch {
    // índice ya existe o hay duplicados nulos
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_install ON devices(install_id)`);
  } catch {
    // índice ya existe
  }

  db.exec(`
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
`);

  // Radio más preciso: defaults viejos (100 / 120 m del seed) → 60 m
  try {
    db.prepare(
      `UPDATE places SET radius_m = 60 WHERE radius_m IN (100, 120)`,
    ).run();
  } catch {
    // tabla todavía no existe en installs muy viejas
  }
}
