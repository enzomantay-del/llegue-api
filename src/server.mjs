import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from './schema.mjs';
import { sendPushToToken } from './push.mjs';
import { seedFamilia } from './seed-familia.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
// En Render: disco en /var/data (LLEGUE_DB_PATH o auto-detect).
// Sin disco persistente, cada redeploy borra la familia.
function resolveDbPath() {
  const fromEnv = (process.env.LLEGUE_DB_PATH || '').trim();
  if (fromEnv) return fromEnv;
  const diskDir = '/var/data';
  try {
    if (fs.existsSync(diskDir)) {
      fs.accessSync(diskDir, fs.constants.W_OK);
      return path.join(diskDir, 'llegue.db');
    }
  } catch {
    // sin disco montado
  }
  return path.join(root, 'data', 'llegue.db');
}
const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const dbLooksPersistent =
  dbPath === '/var/data/llegue.db' ||
  dbPath.startsWith('/var/data/') ||
  Boolean((process.env.LLEGUE_DB_PATH || '').trim());

/** APK oficial: GitHub Releases (no hace falta redeploy de la API al actualizar la app). */
const APK_DOWNLOAD_URL = (
  process.env.APK_DOWNLOAD_URL ||
  'https://github.com/enzomantay-del/llegue-mobile/releases/latest/download/Llegue.apk'
).trim();

// Cargar .env simple
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim().replace(/^"|"$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const db = new DatabaseSync(dbPath);
ensureSchema(db);

let seedInfo = null;
try {
  if ((process.env.SEED_FAMILIA ?? 'false') === 'true') {
    seedInfo = seedFamilia(db);
    console.log(
      `Seed familia: ${seedInfo.familyName} · ` +
        `${seedInfo.adultName} (${seedInfo.adultPhone}) · ` +
        `${seedInfo.kidName} (${seedInfo.kidPhone})`,
    );
  }
} catch (e) {
  console.error('Seed familia falló:', e.message || e);
}

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.JWT_SECRET ?? 'llegue-dev-secret';
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET ?? 'llegue-dev-refresh';
const OTP_DEV_CODE = process.env.OTP_DEV_CODE ?? '123456';
const OTP_EXPOSE = (process.env.OTP_EXPOSE_DEV_CODE ?? 'false') === 'true';
/** Zona horaria de la familia (Argentina). Render corre en UTC; sin esto los avisos salen +3h. */
const APP_TZ = process.env.APP_TZ || 'America/Argentina/Buenos_Aires';

/** Preferí URL-PUBLICA.txt (túnel) si existe, sino .env / localhost */
function resolveInviteBase() {
  const urlFile = path.join(root, 'URL-PUBLICA.txt');
  try {
    if (fs.existsSync(urlFile)) {
      const fromFile = fs.readFileSync(urlFile, 'utf8').trim().split(/\r?\n/)[0];
      if (fromFile.startsWith('http')) return fromFile.replace(/\/$/, '');
    }
  } catch (_) {}
  return (process.env.INVITE_PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(
    /\/$/,
    '',
  );
}

function inviteBase() {
  return resolveInviteBase();
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function zonedParts(d = new Date(), timeZone = APP_TZ) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

/** Hora local de la familia (no la del servidor UTC de Render). */
function clockLabel(d = new Date()) {
  const p = zonedParts(d);
  return `${p.hour}:${p.minute}`;
}

/** 1=lunes … 7=domingo en zona APP_TZ */
function todayWeekday(d = new Date()) {
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const wd = zonedParts(d).weekday;
  return map[wd] ?? 1;
}

function localMinutesNow(d = new Date()) {
  const p = zonedParts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Inicio del día local (Argentina) como ISO, para filtrar eventos “de hoy”. */
function startOfLocalDayIso(d = new Date()) {
  const p = zonedParts(d);
  // Argentina no usa DST; offset fijo -03:00
  return `${p.year}-${p.month}-${p.day}T00:00:00.000-03:00`;
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload, secret, expiresSec) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = {
    ...payload,
    jti: uuid(),
    exp: Math.floor(Date.now() / 1000) + expiresSec,
    iat: Math.floor(Date.now() / 1000),
  };
  const mid = b64url(JSON.stringify(body));
  const data = `${header}.${mid}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const [h, m, s] = parts;
  const data = `${h}.${m}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (s !== expected) throw new Error('bad sig');
  const payload = JSON.parse(Buffer.from(m.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(pin, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function randomDigits(n) {
  let out = '';
  while (out.length < n) out += Math.floor(Math.random() * 10);
  return out.slice(0, n);
}

function randomToken(n = 10) {
  return crypto.randomBytes(n).toString('hex').slice(0, n).toUpperCase();
}

function normalizePhone(raw) {
  return String(raw).replace(/\D/g, '');
}

function userPublic(u) {
  return {
    id: u.id,
    familyId: u.family_id,
    role: u.role,
    name: u.name,
    phone: u.phone,
    email: u.email ?? null,
    birthDate: u.birth_date,
    relationshipLabel: u.relationship_label,
    createdAt: u.created_at,
    hasPin: Boolean(u.pin_hash),
  };
}

function profilePublic(row, user) {
  return {
    plan: row?.plan || 'free',
    planLabel: 'Gratis',
    email: row?.email ?? user?.email ?? null,
    city: row?.city ?? null,
    kidsCount: row?.kids_count ?? null,
    kidsAges: row?.kids_ages ?? null,
    mainConcern: row?.main_concern ?? null,
    howFound: row?.how_found ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function getOrCreateProfile(userId) {
  let row = db
    .prepare('SELECT * FROM account_profiles WHERE user_id = ?')
    .get(userId);
  if (!row) {
    const ts = nowIso();
    db.prepare(
      `INSERT INTO account_profiles (user_id, plan, updated_at) VALUES (?, 'free', ?)`,
    ).run(userId, ts);
    row = db
      .prepare('SELECT * FROM account_profiles WHERE user_id = ?')
      .get(userId);
  }
  return row;
}

function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

function emailOtpKey(email) {
  return `e:${normalizeEmail(email)}`;
}

function storeOtp(key) {
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(key);
  db.prepare(
    `INSERT INTO otp_codes (id, phone, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    key,
    OTP_DEV_CODE,
    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    nowIso(),
  );
}

function checkOtp(key, code) {
  const otp = db
    .prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
    .get(key);
  if (!otp || new Date(otp.expires_at) < new Date() || otp.code !== String(code ?? '').trim()) {
    return false;
  }
  return true;
}

function issueTokens(user) {
  const accessToken = signJwt(
    { sub: user.id, role: user.role, familyId: user.family_id },
    JWT_SECRET,
    2 * 60 * 60,
  );
  const refreshToken = signJwt({ sub: user.id, typ: 'refresh' }, JWT_REFRESH, 30 * 24 * 60 * 60);
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    user.id,
    hashToken(refreshToken),
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    nowIso(),
  );
  return { accessToken, refreshToken };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    ...headers,
  });
  res.end(body);
}

function authUser(req) {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  try {
    const payload = verifyJwt(header.slice(7).trim(), JWT_SECRET);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) ?? null;
  } catch {
    return null;
  }
}

/** Usuario autenticado o 401. No confundir sesión vencida con “sin familia”. */
function requireUser(req, res) {
  const user = authUser(req);
  if (!user) {
    send(res, 401, { error: 'Tenés que iniciar sesión.' });
    return null;
  }
  return user;
}

/** Usuario con familia o 401/400 separados. */
function requireFamilyUser(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!user.family_id) {
    send(res, 400, { error: 'Todavía no estás en una familia.' });
    return null;
  }
  return user;
}

/** Solo avisar “dejó de compartir” si alguna vez completó el compartir pleno. */
function deviceEverFullyShared(device) {
  return Boolean(device?.permissions_completed_at);
}

/** La app manda while_in_use; a veces quedó whileInUse en DB. Unificar. */
function normalizeLocationPermission(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'not_asked';
  if (s === 'while_in_use' || s === 'whileInUse') return 'while_in_use';
  if (s === 'always' || s === 'denied' || s === 'not_asked') return s;
  return s;
}

function deviceSharingHealthy(device) {
  return (
    normalizeLocationPermission(device?.location_permission) === 'always' &&
    Number(device?.location_ok) === 1
  );
}

function devicePermissionStoppedSharing(device) {
  const loc = normalizeLocationPermission(device?.location_permission);
  return loc === 'denied' || loc === 'while_in_use' || Number(device?.location_ok) === 0;
}

/** Último evento de presencia real (geocerca / viaje), no ruido de batería/heartbeat. */
function lastPresenceEvent(kidId) {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE kid_id = ?
         AND type IN (
           'arrival','departure','return_prompt','walking_home','going_to',
           'delay','panic','im_ok'
         )
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(kidId);
}

function touchKidDevicesLastSeen(kidId) {
  if (!kidId) return;
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE user_id = ?`).run(nowIso(), kidId);
}

function findInvitation(tokenOrCode) {
  const key = String(tokenOrCode).trim().toUpperCase();
  return db
    .prepare(
      `SELECT i.*, f.name AS family_name
       FROM invitations i
       JOIN families f ON f.id = i.family_id
       WHERE i.deep_link_token = ? OR i.code = ?`,
    )
    .get(key, key);
}

function isAdultRole(role) {
  return role === 'admin_adult' || role === 'adult';
}

function familyHomePlace(familyId) {
  if (!familyId) return null;
  return db
    .prepare(
      `SELECT * FROM places
       WHERE family_id = ? AND type = 'home' AND status = 'active'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(familyId);
}

/** Viaje armado por POST /trips (no el que abre solo un departure de rutina). */
function isPlannedSpecialTrip(trip) {
  return Boolean(trip && !trip.routine_id && trip.destination_place_id);
}

function isLiveTrip(trip) {
  return Boolean(trip && (trip.status === 'active' || trip.status === 'overdue'));
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function coordsFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const loc = body.location && typeof body.location === 'object' ? body.location : null;
  const lat = Number(body.lat ?? body.latitude ?? loc?.lat ?? loc?.latitude);
  const lng = Number(body.lng ?? body.longitude ?? loc?.lng ?? loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function insidePlace(lat, lng, place) {
  if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lng))) {
    return false;
  }
  const radius = Number(place.radius_m) > 0 ? Number(place.radius_m) : 60;
  return distanceM(lat, lng, place.lat, place.lng) <= radius;
}

function specialTripLeftHome(trip) {
  if (!trip) return false;
  if (trip.departed_at) return true;
  const phase = trip.phase || '';
  return phase === 'en_route' || phase === 'at_destination' || phase === 'returning';
}

function specialTripHeadingOut(trip) {
  if (!isPlannedSpecialTrip(trip) || !isLiveTrip(trip)) return false;
  const phase = trip.phase || '';
  if (phase === 'at_destination' || phase === 'returning') return false;
  if (phase === 'en_route') return true;
  return specialTripLeftHome(trip);
}

function specialTripHeadingHome(trip) {
  if (!isPlannedSpecialTrip(trip) || !isLiveTrip(trip)) return false;
  const phase = trip.phase || '';
  return phase === 'at_destination' || phase === 'returning';
}

function liveKidTrip(kidId) {
  return db
    .prepare(
      `SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue') ORDER BY started_at DESC LIMIT 1`,
    )
    .get(kidId);
}

function matchSpecialGeofencePlace(trip, familyId, lat, lng) {
  if (!isPlannedSpecialTrip(trip) || !isLiveTrip(trip)) return null;
  const dest = tripDestinationPlace(trip);
  const home = familyHomePlace(familyId);
  const inDest = dest && insidePlace(lat, lng, dest);
  const inHome = home && insidePlace(lat, lng, home);
  if (inDest && inHome) {
    if (specialTripHeadingOut(trip)) return dest;
    if (specialTripHeadingHome(trip)) return home;
    return dest;
  }
  if (inDest) return dest;
  if (inHome && specialTripHeadingHome(trip)) return home;
  return null;
}

function lookupFamilyPlace(familyId, placeId, placeName, opts = {}) {
  const includeInactive = opts.includeInactive === true;
  if (placeId) {
    const byId = db
      .prepare(
        `SELECT * FROM places WHERE id = ? AND family_id = ? AND status != 'deleted'`,
      )
      .get(placeId, familyId);
    if (byId) return byId;
  }
  const name = String(placeName ?? '').trim().toLowerCase();
  if (!name || !familyId) return null;
  const rows = db
    .prepare(
      includeInactive
        ? `SELECT * FROM places WHERE family_id = ? AND status != 'deleted'`
        : `SELECT * FROM places WHERE family_id = ? AND status = 'active'`,
    )
    .all(familyId);
  return (
    rows.find((p) => String(p.name).trim().toLowerCase() === name) ?? null
  );
}

/** Casa, colegio o lugar con rutina activa: se sigue monitoreando aunque se cancele una especial. */
function isStandingMonitoredPlace(place) {
  if (!place) return false;
  if (place.type === 'home' || place.type === 'school') return true;
  const routine = db
    .prepare(`SELECT id FROM routines WHERE place_id = ? AND active = 1 LIMIT 1`)
    .get(place.id);
  return Boolean(routine);
}

/** Destino de una especial ya cancelada, que no es lugar permanente/rutina. */
function isCancelledSpecialDestination(place, kidId) {
  if (!place || !kidId) return false;
  if (isStandingMonitoredPlace(place)) return false;
  const live = db
    .prepare(
      `SELECT id FROM trips
       WHERE kid_id = ? AND destination_place_id = ? AND status IN ('active','overdue')
       LIMIT 1`,
    )
    .get(kidId, place.id);
  if (live) return false;
  const cancelled = db
    .prepare(
      `SELECT id FROM trips
       WHERE kid_id = ? AND destination_place_id = ?
         AND status = 'cancelled' AND routine_id IS NULL
       LIMIT 1`,
    )
    .get(kidId, place.id);
  return Boolean(cancelled);
}

function retireTripOnlyDestination(place, exceptTripId = null) {
  if (!place || isStandingMonitoredPlace(place)) return false;
  const other = db
    .prepare(
      `SELECT id FROM trips
       WHERE destination_place_id = ? AND status IN ('active','overdue')
         AND (? IS NULL OR id != ?)
       LIMIT 1`,
    )
    .get(place.id, exceptTripId, exceptTripId);
  if (other) return false;
  db.prepare(
    `UPDATE places SET status = 'inactive' WHERE id = ? AND status = 'active'`,
  ).run(place.id);
  return true;
}

function cancelTripRecord(trip) {
  db.prepare(
    `UPDATE trips SET status = 'cancelled', ended_at = ?, phase = NULL WHERE id = ?`,
  ).run(nowIso(), trip.id);
  if (isPlannedSpecialTrip(trip) && trip.destination_place_id) {
    const dest = db.prepare('SELECT * FROM places WHERE id = ?').get(trip.destination_place_id);
    retireTripOnlyDestination(dest, trip.id);
  }
  return db.prepare('SELECT * FROM trips WHERE id = ?').get(trip.id);
}

function stoppedSharingPayload(kid, extra = {}) {
  const payload = { ...(extra && typeof extra === 'object' ? extra : {}) };
  payload.type = 'kid_stopped_sharing';
  payload.kidId = kid.id;
  if (kid.phone) payload.phone = kid.phone;
  else delete payload.phone;
  return payload;
}

function tripDestinationPlace(trip) {
  if (!trip?.destination_place_id) return null;
  return db.prepare('SELECT * FROM places WHERE id = ?').get(trip.destination_place_id);
}

function placeMatchesTripDestination(place, trip) {
  if (!place || !trip?.destination_place_id) return false;
  if (place.id === trip.destination_place_id) return true;
  const dest = tripDestinationPlace(trip);
  if (!dest) return false;
  return (
    String(place.name).trim().toLowerCase() ===
    String(dest.name).trim().toLowerCase()
  );
}

/** Si el celular manda arrival/departure sin placeId, inferir Casa vs destino según la fase. */
function impliedSpecialTripPlace(trip, type, familyId) {
  if (!isPlannedSpecialTrip(trip) || !isLiveTrip(trip)) return null;
  const dest = tripDestinationPlace(trip);
  if (!dest) return null;
  const home = familyHomePlace(familyId);
  const headingOut = specialTripHeadingOut(trip);
  const headingHome = specialTripHeadingHome(trip);
  if (type === 'arrival') {
    if (headingHome && dest.type !== 'home') return home;
    // en_route, o pending ya después de EXIT Casa.
    if (headingOut) return dest;
  }
  if (type === 'departure') {
    if (headingOut || trip.phase === 'pending_departure' || !trip.phase) return home;
    if (headingHome) return dest;
  }
  return null;
}

function placePublic(p) {
  return {
    id: p.id,
    familyId: p.family_id,
    createdByUserId: p.created_by_user_id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    radiusM: p.radius_m,
    type: p.type,
    suggestedByKidId: p.suggested_by_kid_id,
    status: p.status,
    createdAt: p.created_at,
  };
}

function tripPublic(t) {
  const dest = tripDestinationPlace(t);
  return {
    id: t.id,
    kidId: t.kid_id,
    routineId: t.routine_id,
    originPlaceId: t.origin_place_id,
    destinationPlaceId: t.destination_place_id,
    status: t.status,
    expectedReturnAt: t.expected_return_at,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    createdAt: t.created_at,
    phase: t.phase ?? null,
    departedAt: t.departed_at ?? null,
    createdByUserId: t.created_by_user_id ?? null,
    createdByName: t.created_by_name ?? null,
    destination: dest ? placePublic(dest) : null,
    destinationName: dest?.name ?? null,
    destinationType: dest?.type ?? null,
    destinationLat: dest?.lat ?? null,
    destinationLng: dest?.lng ?? null,
    destinationRadiusM: dest?.radius_m ?? null,
  };
}

function monitorGeofencesForKid(kid) {
  if (!kid?.family_id) return [];
  const out = [];
  const seen = new Set();
  const add = (place, reason, tripId = null) => {
    if (!place || seen.has(place.id)) return;
    seen.add(place.id);
    out.push({ ...placePublic(place), reason, tripId });
  };
  add(familyHomePlace(kid.family_id), 'home');
  const trip = liveKidTrip(kid.id);
  if (isPlannedSpecialTrip(trip) && isLiveTrip(trip)) {
    add(tripDestinationPlace(trip), 'special_trip_destination', trip.id);
  }
  return out;
}

function resolveOrCreateTripDestination(user, body) {
  const nested = body.destination && typeof body.destination === 'object' ? body.destination : {};
  const placeId =
    body.destinationPlaceId ||
    nested.id ||
    nested.placeId ||
    body.destination_place_id ||
    null;
  if (placeId) {
    const dest = db
      .prepare(`SELECT * FROM places WHERE id = ? AND family_id = ? AND status = 'active'`)
      .get(placeId, user.family_id);
    if (dest) return dest;
  }
  const name = String(
    body.destinationName ?? nested.name ?? body.placeName ?? '',
  ).trim();
  const lat = Number(body.destinationLat ?? nested.lat ?? body.lat);
  const lng = Number(body.destinationLng ?? nested.lng ?? body.lng);
  if (name.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const radiusRaw = Number(body.destinationRadiusM ?? nested.radiusM ?? nested.radius_m ?? body.radiusM);
  const radius = radiusRaw > 0 ? Math.min(radiusRaw, 500) : 120;
  const nearby = db
    .prepare(`SELECT * FROM places WHERE family_id = ? AND status = 'active'`)
    .all(user.family_id)
    .find(
      (p) =>
        String(p.name).trim().toLowerCase() === name.toLowerCase() &&
        distanceM(lat, lng, p.lat, p.lng) <= 40,
    );
  if (nearby) return nearby;
  const id = uuid();
  db.prepare(
    `INSERT INTO places
     (id, family_id, created_by_user_id, name, lat, lng, radius_m, type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'special', 'active', ?)`,
  ).run(id, user.family_id, user.id, name, lat, lng, radius, nowIso());
  return db.prepare('SELECT * FROM places WHERE id = ?').get(id);
}

function applySpecialTripGeofence(activeTrip, type, place) {
  if (!activeTrip || !isLiveTrip(activeTrip)) return;
  if (type === 'arrival') {
    const arrivedHome = place?.type === 'home';
    const arrivedAtDest = placeMatchesTripDestination(place, activeTrip);
    if (isPlannedSpecialTrip(activeTrip)) {
      if (arrivedHome && !specialTripLeftHome(activeTrip)) {
        return;
      }
      if (arrivedAtDest && !arrivedHome) {
        db.prepare(
          `UPDATE trips SET phase = 'at_destination', departed_at = COALESCE(departed_at, ?) WHERE id = ? AND status IN ('active','overdue')`,
        ).run(nowIso(), activeTrip.id);
        return;
      }
      // Llegó a otro lugar de la familia (ej. Plazoleta) antes del destino:
      // cuenta como “ya salió de Casa” para no bloquear la vuelta.
      if (!arrivedHome && place?.id) {
        db.prepare(
          `UPDATE trips SET phase = CASE WHEN phase IS NULL OR phase = 'pending_departure' THEN 'en_route' ELSE phase END,
           departed_at = COALESCE(departed_at, ?)
           WHERE id = ? AND status IN ('active','overdue')`,
        ).run(nowIso(), activeTrip.id);
      }
      if (arrivedHome) {
        db.prepare(
          `UPDATE trips SET status = 'arrived', ended_at = ? WHERE id = ? AND status IN ('active','overdue')`,
        ).run(nowIso(), activeTrip.id);
      }
      return;
    }
    db.prepare(
      `UPDATE trips SET status = 'arrived', ended_at = ? WHERE id = ? AND status IN ('active','overdue')`,
    ).run(nowIso(), activeTrip.id);
    return;
  }
  if (type === 'departure' && isPlannedSpecialTrip(activeTrip)) {
    const now = nowIso();
    if (place?.type === 'home') {
      db.prepare(
        `UPDATE trips SET phase = 'en_route', departed_at = COALESCE(departed_at, ?) WHERE id = ? AND status IN ('active','overdue')`,
      ).run(now, activeTrip.id);
    } else if (placeMatchesTripDestination(place, activeTrip)) {
      db.prepare(
        `UPDATE trips SET phase = 'returning' WHERE id = ? AND status IN ('active','overdue')`,
      ).run(activeTrip.id);
    }
  }
}

function applyKidLocation(kid, lat, lng, deviceId) {
  if (!kid || kid.role !== 'kid' || !deviceId) return { events: [] };
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, kid.id);
  if (!device) return { events: [] };

  const trip = liveKidTrip(kid.id);
  const home = familyHomePlace(kid.family_id);
  const dest = isPlannedSpecialTrip(trip) ? tripDestinationPlace(trip) : null;
  const inHome = Boolean(home && insidePlace(lat, lng, home));
  const inDest = Boolean(dest && insidePlace(lat, lng, dest));

  let nowPlaceId = null;
  if (inDest && inHome) {
    nowPlaceId = specialTripHeadingOut(trip) ? dest.id : home.id;
  } else if (inDest) {
    nowPlaceId = dest.id;
  } else if (inHome) {
    nowPlaceId = home.id;
  }

  const firstFix = device.last_lat == null && device.last_lng == null;
  const prevPlaceId = device.last_inside_place_id || null;

  db.prepare(
    `UPDATE devices SET last_lat = ?, last_lng = ?, last_inside_place_id = ?, last_seen_at = ? WHERE id = ?`,
  ).run(lat, lng, nowPlaceId, nowIso(), device.id);

  // Primer GPS en casa: no inventar "llegó a Casa" al armar la especial.
  if (firstFix && inHome && !inDest) {
    return { events: [] };
  }

  const events = [];
  if (prevPlaceId && prevPlaceId !== nowPlaceId) {
    const left = createEvent({
      kid,
      type: 'departure',
      placeId: prevPlaceId,
      tripId: trip?.id ?? null,
    });
    if (left?.event && !left.ignored) events.push(left);
  }
  if (nowPlaceId && nowPlaceId !== prevPlaceId) {
    const entered = createEvent({
      kid,
      type: 'arrival',
      placeId: nowPlaceId,
      tripId: trip?.id ?? null,
    });
    if (entered?.event && !entered.ignored) events.push(entered);
  }
  return { events };
}

function eventPublic(e) {
  let payload = null;
  if (e.payload) {
    try {
      payload = JSON.parse(e.payload);
    } catch {
      payload = null;
    }
  }
  return {
    id: e.id,
    kidId: e.kid_id,
    tripId: e.trip_id,
    type: e.type,
    placeId: e.place_id,
    notify: Boolean(e.notify),
    message: e.message,
    payload,
    createdAt: e.created_at,
  };
}

function parseDays(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return String(raw)
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => !Number.isNaN(n));
  }
}

function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function routineMatchesNow(routine, placeId, toleranceMin = 15) {
  if (!routine.active) return false;
  if (placeId && routine.place_id !== placeId) return false;
  const days = parseDays(routine.days_of_week);
  const day = todayWeekday();
  if (!days.includes(day)) return false;
  const nowMin = localMinutesNow();
  const start = minutesOfDay(routine.start_time) - toleranceMin;
  const end = minutesOfDay(routine.end_time) + toleranceMin;
  return nowMin >= start && nowMin <= end;
}

function defaultAlertPrefs() {
  return {
    arrival: true,
    departure: true,
    walking_home: true,
    going_to: true,
    place_suggested: true,
    delay: true,
    panic: true,
    im_ok: true,
    low_battery: true,
    location_lost: true,
    app_closed: true,
    return_prompt: true,
  };
}

function getAlertPrefs(userId) {
  const prefs = defaultAlertPrefs();
  const rows = db
    .prepare(`SELECT event_type, enabled FROM alert_prefs WHERE user_id = ?`)
    .all(userId);
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(prefs, r.event_type)) {
      prefs[r.event_type] = Boolean(r.enabled);
    }
  }
  // pánico siempre on
  prefs.panic = true;
  return prefs;
}

function isAlertEnabled(userId, eventType) {
  if (eventType === 'panic') return true;
  const prefs = getAlertPrefs(userId);
  if (Object.prototype.hasOwnProperty.call(prefs, eventType)) {
    return prefs[eventType] !== false;
  }
  return true;
}

function eventMessage(type, kidName, placeName) {
  const aLugar = placeName ? ` a ${placeName}` : '';
  const deLugar = placeName ? ` de ${placeName}` : '';
  switch (type) {
    case 'arrival':
      return `${kidName} llegó${aLugar}`;
    case 'departure':
      return `${kidName} salió${deLugar}`;
    case 'going_to':
      return placeName
        ? `${kidName} va a ${placeName}`
        : `${kidName} avisó una salida especial`;
    case 'walking_home':
      return `${kidName} regresa a casa`;
    case 'delay':
      return `${kidName} no llegó${aLugar} a horario`;
    case 'panic':
      return `¡${kidName} necesita ayuda ahora!`;
    case 'im_ok':
      return `${kidName} dice: estoy bien`;
    case 'low_battery':
      return `La batería de ${kidName} está baja`;
    case 'location_lost':
      return `${kidName} dejó de compartir ubicación`;
    case 'app_closed':
      return `${kidName} cerró la app Llegué`;
    case 'return_prompt':
      return `${kidName} salió y todavía no dijo a dónde va. ¿Va a casa?`;
    case 'place_suggested':
      return `${kidName} sugiere agregar${aLugar || ' un lugar'}`;
    case 'place_approved':
      return placeName
        ? `Ya podés usar “${placeName}” en Llegué`
        : 'Aceptaron un lugar que sugeriste';
    default:
      return `Novedad de ${kidName}${aLugar}`;
  }
}

function findDeviceByInstall(installId) {
  if (!installId) return null;
  return db
    .prepare(
      `SELECT d.*, u.name AS user_name, u.role AS user_role, u.family_id AS user_family_id, u.phone AS user_phone
       FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE d.install_id = ?`,
    )
    .get(String(installId).trim());
}

/** Un celular (install_id) = un solo integrante.
 *  Si la misma persona reinstala la app, se reata el celular nuevo. */
function bindInstallToUser(installId, user, platform = 'android') {
  const idKey = String(installId ?? '').trim();
  if (idKey.length < 6) {
    return { ok: false, status: 400, error: 'No pudimos identificar este celular. Reinstalá la app.' };
  }

  const byInstall = findDeviceByInstall(idKey);
  if (byInstall && byInstall.user_id !== user.id) {
    return {
      ok: false,
      status: 409,
      error:
        `Este celular ya es de ${byInstall.user_name}. ` +
        'Cada celular es de una sola persona de la familia. ' +
        'Para otra persona, usá otro celular.',
      boundUser: {
        id: byInstall.user_id,
        name: byInstall.user_name,
        role: byInstall.user_role,
      },
    };
  }

  // Misma persona con otro install (reinstaló): liberar el registro viejo
  db.prepare(
    `DELETE FROM devices WHERE user_id = ? AND (install_id IS NULL OR install_id != ?)`,
  ).run(user.id, idKey);

  if (byInstall) {
    db.prepare(
      `UPDATE devices SET user_id = ?, platform = ?, last_seen_at = ? WHERE id = ?`,
    ).run(user.id, platform, nowIso(), byInstall.id);
    return { ok: true, deviceId: byInstall.id };
  }

  const deviceId = uuid();
  db.prepare(
    `INSERT INTO devices
     (id, user_id, install_id, platform, push_token, location_permission, notifications_permission,
      last_seen_at, location_ok, created_at)
     VALUES (?, ?, ?, ?, NULL, 'not_asked', 'not_asked', ?, 1, ?)`,
  ).run(deviceId, user.id, idKey, platform, nowIso(), nowIso());
  return { ok: true, deviceId };
}

function fanOutNotifications(event, familyId, title, body, excludeUserId = null) {
  const adults = db
    .prepare(
      `SELECT * FROM users WHERE family_id = ? AND role IN ('admin_adult','adult')`,
    )
    .all(familyId);
  let count = 0;
  for (const adult of adults) {
    if (excludeUserId && adult.id === excludeUserId) continue;
    if (!isAlertEnabled(adult.id, event.type)) continue;
    const notifId = uuid();
    db.prepare(
      `INSERT INTO notifications
       (id, event_id, recipient_user_id, status, title, body, sent_at, created_at)
       VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)`,
    ).run(notifId, event.id, adult.id, title, body, nowIso(), nowIso());
    count += 1;

    const device = db
      .prepare(
        `SELECT * FROM devices WHERE user_id = ? AND push_token IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(adult.id);
    if (device?.push_token) {
      const urgent =
        title.includes('Ayuda') ||
        event.type === 'panic' ||
        event.type === 'location_lost' ||
        event.type === 'app_closed' ||
        event.type === 'low_battery' ||
        event.type === 'delay';
      const pushData = {};
      if (event.type === 'location_lost' || event.type === 'app_closed') {
        const kidRow = db.prepare('SELECT * FROM users WHERE id = ?').get(event.kid_id);
        Object.assign(pushData, stoppedSharingPayload(kidRow || { id: event.kid_id }));
        pushData.eventType = event.type;
      }
      // fire-and-forget
      sendPushToToken(device.push_token, {
        title,
        body,
        urgent,
        data: Object.keys(pushData).length ? pushData : null,
      }).catch(() => {});
    }
  }
  return count;
}

/** Aviso directo a un hijo/a (solo aceptaciones del adulto). */
function notifyKidUser(kidId, title, body, eventId = null, data = null) {
  if (!kidId) return 0;
  const kid = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'kid'`).get(kidId);
  if (!kid) return 0;
  let resolvedEventId = eventId;
  if (!resolvedEventId) {
    resolvedEventId = uuid();
    db.prepare(
      `INSERT INTO events
       (id, kid_id, trip_id, type, place_id, notify, message, payload, created_at)
       VALUES (?, ?, NULL, 'place_approved', NULL, 0, ?, NULL, ?)`,
    ).run(resolvedEventId, kid.id, body, nowIso());
  }
  const notifId = uuid();
  db.prepare(
    `INSERT INTO notifications
     (id, event_id, recipient_user_id, status, title, body, sent_at, created_at)
     VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(notifId, resolvedEventId, kid.id, title, body, nowIso(), nowIso());
  const device = db
    .prepare(
      `SELECT * FROM devices WHERE user_id = ? AND push_token IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(kid.id);
  if (device?.push_token) {
    sendPushToToken(device.push_token, { title, body, data }).catch(() => {});
  }
  return 1;
}

function checkDeviceHealthAlerts() {
  // “Dejó de compartir” SOLO si cortó permisos/GPS de verdad.
  // App en segundo plano sin heartbeat frecuente ≠ dejó de compartir.
  // (last_seen viejo solo afecta el label “Sin señales recientes” en /family/status.)
  const devices = db
    .prepare(
      `SELECT d.*, u.name AS user_name, u.role AS user_role, u.family_id
       FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE u.family_id IS NOT NULL
         AND u.role = 'kid'
         AND d.permissions_completed_at IS NOT NULL
         AND (
           d.location_permission = 'denied'
           OR d.location_permission = 'whileInUse'
           OR d.location_permission = 'while_in_use'
           OR d.location_ok = 0
         )`,
    )
    .all();

  for (const d of devices) {
    if (!devicePermissionStoppedSharing(d)) continue;
    const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
    if (!kid) continue;
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recent = db
      .prepare(
        `SELECT id FROM events WHERE kid_id = ? AND type = 'location_lost' AND created_at >= ? LIMIT 1`,
      )
      .get(kid.id, since);
    if (recent) continue;
    createEvent({
      kid,
      type: 'location_lost',
      forceNotify: true,
      payload: stoppedSharingPayload(kid, {
        locationPermission: d.location_permission,
        notificationsPermission: d.notifications_permission,
        locationOk: d.location_ok,
        lastSeenAt: d.last_seen_at,
        source: 'heartbeat',
      }),
    });
  }
}

function createEvent({
  kid,
  type,
  placeId = null,
  tripId = null,
  payload = null,
  forceNotify = null,
}) {
  let notify = true;
  if (forceNotify != null) {
    notify = forceNotify;
  }
  // Llegadas y salidas SIEMPRE avisan (rutinas y lugares).
  // La rutina sirve para esperar el horario y detectar demoras, no para callar.
  if (type === 'panic' || type === 'im_ok' || type === 'return_prompt') {
    notify = true;
  }

  if (type === 'location_lost' || type === 'app_closed') {
    payload = stoppedSharingPayload(kid, payload && typeof payload === 'object' ? payload : {});
  }

  let resolvedTripId = tripId || null;
  let providedTrip = resolvedTripId
    ? db.prepare('SELECT * FROM trips WHERE id = ?').get(resolvedTripId)
    : null;
  const providedDeadSpecial =
    providedTrip && !isLiveTrip(providedTrip) && isPlannedSpecialTrip(providedTrip);
  if (providedTrip && !isLiveTrip(providedTrip)) {
    providedTrip = null;
    resolvedTripId = null;
  }

  let resolvedPlaceId = placeId;
  let place = resolvedPlaceId
    ? db.prepare('SELECT * FROM places WHERE id = ?').get(resolvedPlaceId)
    : null;

  if (type === 'arrival' || type === 'departure') {
    const placeGone = place && place.status !== 'active' && place.status !== 'pending_approval';
    if (placeGone || isCancelledSpecialDestination(place, kid.id)) {
      return { event: null, notifiedCount: 0, place: null, ignored: true };
    }
    // La app puede seguir mandando el tripId cancelado (sin placeId = infería el destino).
    if (providedDeadSpecial && !isStandingMonitoredPlace(place)) {
      return { event: null, notifiedCount: 0, place: null, ignored: true };
    }
  }

  // Salida sin viaje activo → abrimos viaje abierto (sin hora de vuelta)
  if (type === 'departure' && !resolvedTripId) {
    const existing = db
      .prepare(
        `SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue')`,
      )
      .get(kid.id);
    if (existing) {
      resolvedTripId = existing.id;
    } else {
      resolvedTripId = uuid();
      db.prepare(
        `INSERT INTO trips
         (id, kid_id, destination_place_id, status, expected_return_at, started_at, created_at)
         VALUES (?, ?, NULL, 'active', NULL, ?, ?)`,
      ).run(resolvedTripId, kid.id, nowIso(), nowIso());
    }
  }
  if (type === 'arrival' && !resolvedTripId) {
    const existing = db
      .prepare(
        `SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue') ORDER BY started_at DESC LIMIT 1`,
      )
      .get(kid.id);
    if (existing) resolvedTripId = existing.id;
  }

  let activeTrip = resolvedTripId
    ? db.prepare('SELECT * FROM trips WHERE id = ?').get(resolvedTripId)
    : null;
  if (activeTrip && !isLiveTrip(activeTrip)) {
    activeTrip = null;
    resolvedTripId = null;
  }

  if (!place && (type === 'arrival' || type === 'departure')) {
    place = impliedSpecialTripPlace(activeTrip, type, kid.family_id);
    if (place) resolvedPlaceId = place.id;
  }

  // Casa ENTER al armar especial (sigue en casa, sin haber salido): no avisar.
  // Si ya hubo llegada a OTRO lugar desde que arrancó el viaje, SÍ es vuelta a Casa.
  if (
    type === 'arrival' &&
    isPlannedSpecialTrip(activeTrip) &&
    place?.type === 'home' &&
    !specialTripLeftHome(activeTrip)
  ) {
    const leftEvidence = db
      .prepare(
        `SELECT id FROM events
         WHERE kid_id = ? AND type = 'arrival'
           AND place_id IS NOT NULL AND place_id != ?
           AND created_at >= ?
         LIMIT 1`,
      )
      .get(kid.id, place.id, activeTrip.started_at || activeTrip.created_at);
    if (!leftEvidence) {
      applySpecialTripGeofence(activeTrip, type, place);
      return { event: null, notifiedCount: 0, place: placePublic(place), ignored: true };
    }
  }

  // Anti-duplicados: mismo tipo+lugar en los últimos 90s (después de resolver el lugar)
  const since = new Date(Date.now() - 90 * 1000).toISOString();
  const dup = db
    .prepare(
      `SELECT * FROM events
       WHERE kid_id = ? AND type = ? AND created_at >= ?
         AND ((? IS NULL AND place_id IS NULL) OR place_id = ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(kid.id, type, since, resolvedPlaceId, resolvedPlaceId);
  if (dup && type !== 'panic' && type !== 'im_ok') {
    applySpecialTripGeofence(activeTrip, type, place);
    return {
      event: eventPublic(dup),
      notifiedCount: 0,
      place: resolvedPlaceId
        ? placePublic(db.prepare('SELECT * FROM places WHERE id = ?').get(resolvedPlaceId))
        : null,
      deduped: true,
    };
  }

  const baseMessage = eventMessage(type, kid.name, place?.name);
  // La hora se muestra en la app desde createdAt (zona del celular).
  // No la incrustamos acá: en Render UTC salía desfasada (+3h en Argentina).
  const message = baseMessage;
  const id = uuid();
  db.prepare(
    `INSERT INTO events
     (id, kid_id, trip_id, type, place_id, notify, message, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kid.id,
    resolvedTripId,
    type,
    resolvedPlaceId,
    notify ? 1 : 0,
    message,
    payload ? JSON.stringify(payload) : null,
    nowIso(),
  );
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);

  // Geocerca viva = el menor sigue compartiendo (aunque la app esté en background).
  if (type === 'arrival' || type === 'departure') {
    touchKidDevicesLastSeen(kid.id);
  }

  applySpecialTripGeofence(activeTrip, type, place);
  if (type === 'arrival' && !isPlannedSpecialTrip(activeTrip)) {
    const arrivedHome = place?.type === 'home';
    if (!activeTrip && (arrivedHome || place)) {
      db.prepare(
        `UPDATE trips SET status = 'arrived', ended_at = ? WHERE kid_id = ? AND status IN ('active','overdue')`,
      ).run(nowIso(), kid.id);
    }
  }
  if (type === 'im_ok') {
    db.prepare(
      `UPDATE trips SET status = 'arrived', ended_at = ? WHERE kid_id = ? AND status = 'overdue'`,
    ).run(nowIso(), kid.id);
  }

  let notifiedCount = 0;
  if (notify && kid.family_id) {
    const title =
      type === 'panic'
        ? '¡Ayuda!'
        : type === 'location_lost'
          ? 'Ubicación cortada'
            : type === 'app_closed'
            ? 'App cerrada'
            : type === 'low_battery'
            ? 'Batería baja'
            : type === 'delay'
              ? 'No llegó a horario'
            : type === 'walking_home'
              ? 'Regresa a casa'
              : type === 'going_to'
                ? 'Salida especial'
                : type === 'place_suggested'
                  ? 'Lugar sugerido'
                  : 'Llegué';
    notifiedCount = fanOutNotifications(
      event,
      kid.family_id,
      title,
      message,
      kid.id,
    );
  }
  return {
    event: eventPublic(event),
    notifiedCount,
    place: place ? placePublic(place) : null,
  };
}

function checkDelayedTrips() {
  const now = nowIso();
  const overdue = db
    .prepare(
      `SELECT * FROM trips
       WHERE status = 'active'
         AND expected_return_at IS NOT NULL
         AND expected_return_at < ?`,
    )
    .all(now);
  for (const trip of overdue) {
    if (trip.phase === 'pending_departure') continue;
    const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(trip.kid_id);
    if (!kid) continue;
    const already = db
      .prepare(
        `SELECT id FROM events WHERE trip_id = ? AND type = 'delay' LIMIT 1`,
      )
      .get(trip.id);
    if (already) continue;
    db.prepare(`UPDATE trips SET status = 'overdue' WHERE id = ?`).run(trip.id);
    createEvent({
      kid,
      type: 'delay',
      placeId: trip.destination_place_id,
      tripId: trip.id,
      forceNotify: true,
    });
  }
}

/** Salidas abiertas SIN destino → recordatorio "¿A casa?". Si ya hay destino (Modista, etc.) no aplica. */
function checkReturnPrompts() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const openTrips = db
    .prepare(
      `SELECT * FROM trips
       WHERE status = 'active'
         AND expected_return_at IS NULL
         AND destination_place_id IS NULL
         AND (
           departed_at <= ?
           OR (
             departed_at IS NULL
             AND (phase IS NULL OR phase = '')
             AND started_at <= ?
           )
         )`,
    )
    .all(cutoff, cutoff);
  for (const trip of openTrips) {
    const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(trip.kid_id);
    if (!kid) continue;
    const already = db
      .prepare(
        `SELECT id FROM events WHERE trip_id = ? AND type = 'return_prompt' LIMIT 1`,
      )
      .get(trip.id);
    if (already) continue;
    createEvent({
      kid,
      type: 'return_prompt',
      placeId: trip.destination_place_id,
      tripId: trip.id,
      forceNotify: true,
      payload: { reason: 'open_trip_no_return' },
    });
  }
}

/** Demora de rutina: ~5 min después del INICIO y todavía no hubo llegada al lugar hoy.
 *  Si después llega, el geofence genera `arrival` y avisa igual. */
function checkRoutineDelays() {
  const graceAfterStartMin = 5;
  const day = todayWeekday();
  const nowMin = localMinutesNow();
  const routines = db.prepare(`SELECT * FROM routines WHERE active = 1`).all();
  const dayStartIso = startOfLocalDayIso();

  for (const routine of routines) {
    const days = parseDays(routine.days_of_week);
    if (!days.includes(day)) continue;

    const startMin = minutesOfDay(routine.start_time);
    const endMin = minutesOfDay(routine.end_time);
    // Todavía no pasó el margen de gracia desde el inicio (ej. 07:05).
    if (nowMin < startMin + graceAfterStartMin) continue;
    // Fuera de la ventana del día de esa rutina (evita avisos a la noche).
    if (nowMin > endMin + 30) continue;

    const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(routine.kid_id);
    if (!kid || kid.role !== 'kid') continue;

    const arrived = db
      .prepare(
        `SELECT id FROM events
         WHERE kid_id = ? AND place_id = ? AND type = 'arrival' AND created_at >= ?
         LIMIT 1`,
      )
      .get(kid.id, routine.place_id, dayStartIso);
    if (arrived) continue;

    const already = db
      .prepare(
        `SELECT id FROM events
         WHERE kid_id = ? AND type = 'delay' AND place_id = ? AND created_at >= ?
         LIMIT 1`,
      )
      .get(kid.id, routine.place_id, dayStartIso);
    if (already) continue;

    createEvent({
      kid,
      type: 'delay',
      placeId: routine.place_id,
      forceNotify: true,
      payload: {
        reason: 'routine_missed_start',
        routineId: routine.id,
        expectedStart: routine.start_time,
        graceMinutes: graceAfterStartMin,
      },
    });
  }
}

function memberPresence(m, lastEvent, activeTrip, healthIssue) {
  if (healthIssue) {
    return {
      presenceStatus: 'alert',
      presenceLabel: healthIssue,
      currentPlaceName: null,
      needsGoHome: false,
    };
  }
  if (m.role !== 'kid') {
    return {
      presenceStatus: 'ok',
      presenceLabel: 'Adulto',
      currentPlaceName: null,
      needsGoHome: false,
    };
  }

  const lastType = lastEvent?.type;
  let placeName = null;
  if (lastEvent?.place_id) {
    const p = db.prepare('SELECT * FROM places WHERE id = ?').get(lastEvent.place_id);
    placeName = p?.name ?? null;
  }

  // No pisar el lugar del último ENTER/EXIT con el destino del viaje:
  // eso dejaba “En Casa” arriba y “llegó a Plazoleta” abajo.
  const tripDestName = (() => {
    if (!activeTrip?.destination_place_id) return null;
    const p = db
      .prepare('SELECT * FROM places WHERE id = ?')
      .get(activeTrip.destination_place_id);
    return p?.name ?? null;
  })();

  const needsGoHome =
    Boolean(activeTrip) &&
    activeTrip.phase !== 'pending_departure' &&
    !activeTrip.destination_place_id &&
    (activeTrip.expected_return_at == null ||
      lastType === 'return_prompt' ||
      activeTrip.status === 'overdue');

  if (lastType === 'panic') {
    return {
      presenceStatus: 'alert',
      presenceLabel: 'Necesita ayuda',
      currentPlaceName: placeName,
      needsGoHome,
    };
  }

  // Fuente de verdad de presencia: último arrival/departure (geocerca).
  if (lastType === 'arrival') {
    return {
      presenceStatus: 'at_place',
      presenceLabel: placeName ? `En ${placeName}` : 'Llegó',
      currentPlaceName: placeName,
      needsGoHome: false,
    };
  }
  if (lastType === 'departure' || lastType === 'return_prompt') {
    // EXIT de X ≠ “en camino a X”. “En camino a dest” solo si hay salida
    // especial armada hacia otro lugar y todavía va hacia allá.
    const headingOut =
      isPlannedSpecialTrip(activeTrip) &&
      specialTripHeadingOut(activeTrip) &&
      tripDestName &&
      tripDestName !== placeName;
    const headingHome =
      isPlannedSpecialTrip(activeTrip) && specialTripHeadingHome(activeTrip);

    if (activeTrip && activeTrip.status === 'overdue' && headingOut) {
      return {
        presenceStatus: 'alert',
        presenceLabel: `Se demora · ${tripDestName}`,
        currentPlaceName: tripDestName,
        needsGoHome: true,
      };
    }
    if (headingOut) {
      return {
        presenceStatus: 'on_trip',
        presenceLabel: `En camino a ${tripDestName}`,
        currentPlaceName: tripDestName,
        needsGoHome: false,
      };
    }
    if (headingHome) {
      return {
        presenceStatus: 'on_trip',
        presenceLabel: placeName ? `Salió de ${placeName}` : 'En camino a Casa',
        currentPlaceName: placeName,
        needsGoHome: true,
      };
    }
    return {
      presenceStatus: 'on_trip',
      presenceLabel: placeName ? `Salió de ${placeName}` : 'Salió',
      currentPlaceName: placeName,
      needsGoHome: true,
    };
  }

  // Sin geocerca reciente: viaje especial aún puede orientar.
  if (activeTrip && activeTrip.phase !== 'pending_departure') {
    if (activeTrip.status === 'overdue') {
      return {
        presenceStatus: 'alert',
        presenceLabel: tripDestName ? `Se demora · ${tripDestName}` : 'Se demora',
        currentPlaceName: tripDestName,
        needsGoHome: true,
      };
    }
    if (activeTrip.phase === 'at_destination') {
      return {
        presenceStatus: 'at_place',
        presenceLabel: tripDestName ? `En ${tripDestName}` : 'Llegó',
        currentPlaceName: tripDestName,
        needsGoHome: false,
      };
    }
    return {
      presenceStatus: 'on_trip',
      presenceLabel: tripDestName ? `En camino a ${tripDestName}` : 'En camino',
      currentPlaceName: tripDestName,
      needsGoHome,
    };
  }
  if (lastType === 'im_ok') {
    return {
      presenceStatus: 'ok',
      presenceLabel: 'Está bien',
      currentPlaceName: placeName,
      needsGoHome: false,
    };
  }
  if (lastType === 'delay') {
    return {
      presenceStatus: 'alert',
      presenceLabel: placeName ? `Demora · ${placeName}` : 'Demora',
      currentPlaceName: placeName,
      needsGoHome: true,
    };
  }
  if (lastType === 'going_to') {
    return {
      presenceStatus: 'on_trip',
      presenceLabel: placeName ? `En camino a ${placeName}` : 'En camino',
      currentPlaceName: placeName,
      needsGoHome: false,
    };
  }
  if (lastType === 'walking_home') {
    return {
      presenceStatus: 'on_trip',
      presenceLabel: 'En camino a Casa',
      currentPlaceName: 'Casa',
      needsGoHome: true,
    };
  }
  return {
    presenceStatus: 'unknown',
    presenceLabel: 'Sin novedades',
    currentPlaceName: null,
    needsGoHome: false,
  };
}

function inviteHtml({
  greeting,
  detail,
  token,
  code,
  roleLabel,
  familyName,
  downloadUrl,
}) {
  const deep = token ? `llegue://join/${token}` : '';
  const download = downloadUrl
    ? `<a class="btn" href="${downloadUrl}">1. Descargar Llegué</a>`
    : '';
  const openBtn = deep
    ? `<a class="btn secondary" href="${deep}">2. Ya la instalé — Entrar</a>`
    : '';
  const tip = token
    ? `<p class="tip">Después de instalar, volvé a esta página y tocá <strong>Entrar</strong>. ` +
      `Si no abre, abrí Llegué → <strong>Me invitaron</strong> y usá el código.</p>`
    : '';
  const codeLine = code
    ? `<p class="code">Código: <strong>${code}</strong></p>`
    : '';
  const badge = roleLabel
    ? `<p class="badge">Vas a entrar como <strong>${roleLabel}</strong>${familyName ? ` en ${familyName}` : ''}</p>`
    : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Llegué</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:0;min-height:100vh;background:linear-gradient(155deg,#0f3d34,#1f8a70 55%,#3d2a1a);color:#fff;display:grid;place-items:center;padding:24px}
main{max-width:420px;width:100%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:24px;padding:28px}
h1{font-family:Georgia,serif;margin:0 0 8px;font-size:2rem}
.hi{font-size:1.35rem;font-weight:700;margin:0 0 10px}
p{margin:0 0 12px;line-height:1.45;color:rgba(255,255,255,.86)}
.badge{background:rgba(255,255,255,.14);border-radius:12px;padding:12px 14px;margin:14px 0}
.btn{display:block;text-align:center;text-decoration:none;color:#0f3d34;background:#fff;font-weight:800;padding:18px;border-radius:16px;margin-top:12px}
.btn.secondary{background:rgba(255,255,255,.18);color:#fff;border:2px solid rgba(255,255,255,.55)}
.code{margin-top:18px;font-size:1.1rem}.tip{margin-top:16px;font-size:.95rem;color:rgba(255,255,255,.75)}
</style></head>
<body><main>
<h1>Llegué</h1>
<p class="hi">${greeting}</p>
<p>${detail}</p>
${badge}
${download}
${openBtn}
${codeLine}
${tip}
</main></body></html>`;
}

function trialLandingHtml({ downloadUrl, otpCode, versionLabel }) {
  const version = versionLabel || '1.0.0';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Probar Llegué</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:0;min-height:100vh;background:linear-gradient(155deg,#0f3d34,#1f8a70 55%,#3d2a1a);color:#fff;display:grid;place-items:center;padding:24px}
main{max-width:440px;width:100%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:24px;padding:28px}
h1{font-family:Georgia,serif;margin:0 0 8px;font-size:2rem}
.tag{display:inline-block;background:rgba(232,184,109,.25);color:#f3e0b8;font-size:.8rem;font-weight:700;padding:6px 10px;border-radius:999px;margin-bottom:14px}
p{margin:0 0 12px;line-height:1.45;color:rgba(255,255,255,.88)}
ol{margin:0 0 18px;padding-left:1.2rem;color:rgba(255,255,255,.9);line-height:1.55}
li{margin-bottom:8px}
.box{background:rgba(255,255,255,.14);border-radius:14px;padding:14px 16px;margin:16px 0}
.box strong{font-size:1.35rem;letter-spacing:.08em}
.warn{background:rgba(232,184,109,.2);border:1px solid rgba(232,184,109,.45);border-radius:14px;padding:12px 14px;margin:14px 0;font-size:.95rem;line-height:1.45}
.btn{display:block;text-align:center;text-decoration:none;color:#0f3d34;background:#fff;font-weight:800;padding:18px;border-radius:16px;margin-top:8px}
.note{margin-top:16px;font-size:.9rem;color:rgba(255,255,255,.7)}
</style></head>
<body><main>
<span class="tag">Prueba cerrada · ${version}</span>
<h1>Llegué</h1>
<p>Tranquilidad al saber que llegaron. Sin pedir que te avisen.</p>
<div class="warn"><strong>Si ya tenés Llegué instalada:</strong> descargá e instalá <em>encima</em>. <strong>No desinstales</strong>: si la borrás, se pierde la sesión de este celular (la familia en el servidor sigue).</div>
<p>Para instalar o actualizar en Android:</p>
<ol>
  <li>Tocá <strong>Descargar Llegué</strong> e instalá encima de la que ya tenés.</li>
  <li>Si es la primera vez: abrí la app, aceptá las bases y entrá con tu teléfono.</li>
  <li>Para confirmar la actualización: Cuenta → abajo del nombre tiene que decir <strong>${version}</strong>.</li>
</ol>
<div class="box">Código de prueba:<br/><strong>${otpCode}</strong></div>
<a class="btn" href="${downloadUrl}">Descargar / actualizar Llegué</a>
<p class="note">La familia vive en el servidor. Las actualizaciones de la app ya no reinician ese servidor. Instalá siempre encima, sin desinstalar.</p>
</main></body></html>`;
}

function publicInviteBase(raw, reqHost) {
  const value = String(raw ?? '').trim().replace(/\/$/, '');
  if (value && /^https?:\/\//i.test(value) && !/localhost|127\.0\.0\.1/i.test(value)) {
    return value;
  }
  if (reqHost && !/localhost|127\.0\.0\.1/i.test(reqHost)) {
    const host = String(reqHost).replace(/\/$/, '');
    const httpsHost = /onrender\.com$/i.test(host.split(':')[0]) ||
      /\.trycloudflare\.com$/i.test(host.split(':')[0]);
    return `${httpsHost ? 'https' : 'http'}://${host}`;
  }
  if (value && /^https?:\/\//i.test(value)) return value;
  return inviteBase();
}

function buildShareMessage({ name, inviteUrl, roleLabel }) {
  // Solo el link al inicio (WhatsApp lo vuelve tocable) + texto corto
  return (
    `${inviteUrl}\n\n` +
    `Hola ${name}, te sumé a Llegué como ${roleLabel}.\n` +
    `Tocá el link, descargá la app y entrá. Tus datos ya están cargados.`
  );
}

function findApkPath() {
  // root = services/api
  const candidates = [
    path.join(root, 'public', 'Llegue.apk'),
    path.join(root, '..', 'Llegue-v2.apk'),
    path.join(root, '..', 'apps', 'mobile', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk'),
    path.join('C:', 'llegue-v2', 'Llegue-v2.apk'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readApkVersionLabel() {
  try {
    const p = path.join(root, 'public', 'LLEGUE-APK-VERSION.txt');
    if (!fs.existsSync(p)) return '1.0.0+6';
    const text = fs.readFileSync(p, 'utf8');
    const name = text.match(/versionName:\s*(\S+)/i)?.[1];
    const code = text.match(/versionCode\s*\/\s*build:\s*(\S+)/i)?.[1];
    if (name && code) return `${name}+${code}`;
    if (name) return name;
  } catch {
    // ignore
  }
  return '1.0.0+6';
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      let users = null;
      try {
        users = db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
      } catch {
        users = null;
      }
      return send(res, 200, {
        ok: true,
        service: 'llegue-api-v2',
        dbPersistent: dbLooksPersistent,
        dbPath: dbLooksPersistent ? '/var/data/llegue.db' : 'ephemeral',
        users,
      });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/probar')) {
      const host = req.headers.host || `localhost:${PORT}`;
      const base = publicInviteBase(process.env.INVITE_PUBLIC_BASE_URL, host);
      const versionLabel = readApkVersionLabel();
      return send(res, 200, trialLandingHtml({
        downloadUrl: `${base}/download/llegue.apk`,
        otpCode: process.env.OTP_DEV_CODE || '123456',
        versionLabel,
      }));
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (pathname === '/download/llegue.apk' || pathname === '/app.apk')
    ) {
      // Preferir GitHub Releases: actualizar la app NO redeploya la API ni toca la DB.
      if (APK_DOWNLOAD_URL && /^https?:\/\//i.test(APK_DOWNLOAD_URL)) {
        res.writeHead(302, {
          location: APK_DOWNLOAD_URL,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        });
        return res.end();
      }
      const apk = findApkPath();
      if (!apk) {
        return send(res, 404, {
          error: 'Todavía no hay APK. Publicá un Release en llegue-mobile o poné public/Llegue.apk.',
        });
      }
      const data = fs.readFileSync(apk);
      const versionLabel = readApkVersionLabel().replace(/\s+/g, '');
      const fileName = `Llegue-${versionLabel || 'update'}.apk`;
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': data.length,
        'content-disposition': `attachment; filename="${fileName}"`,
        'access-control-allow-origin': '*',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(data);
    }

    if (req.method === 'GET' && pathname.startsWith('/i/')) {
      const token = pathname.slice(3).split('?')[0];
      const inv = findInvitation(token);
      const host = req.headers.host || `localhost:${PORT}`;
      const base = publicInviteBase(null, host);
      if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
        return send(res, 404, inviteHtml({
          greeting: 'Este link ya no sirve',
          detail: 'Pedile a tu familia uno nuevo por WhatsApp.',
          token: '',
          code: '',
          roleLabel: '',
          familyName: '',
          downloadUrl: `${base}/download/llegue.apk`,
        }));
      }
      const roleLabel = inv.role === 'kid' ? 'hijo/a' : 'adulto';
      return send(res, 200, inviteHtml({
        greeting: `Hola, ${inv.name_hint}`,
        detail: `Te invitaron a Llegué. Descargá la app y entrá: tu nombre y rol ya están cargados.`,
        token: inv.deep_link_token,
        code: inv.code,
        roleLabel,
        familyName: inv.family_name,
        downloadUrl: `${base}/download/llegue.apk`,
      }));
    }

    // AUTH
    if (req.method === 'POST' && pathname === '/auth/request-otp') {
      const body = await readBody(req);
      const phone = normalizePhone(body.phone ?? '');
      if (phone.length < 8) return send(res, 400, { error: 'Escribí un teléfono válido.' });
      storeOtp(phone);
      const payload = { ok: true, message: 'Te enviamos un código.' };
      if (OTP_EXPOSE) payload.devCode = OTP_DEV_CODE;
      return send(res, 200, payload);
    }

    if (req.method === 'POST' && pathname === '/auth/request-email-otp') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email ?? '');
      if (!email.includes('@') || email.length < 6) {
        return send(res, 400, { error: 'Escribí un mail válido.' });
      }
      storeOtp(emailOtpKey(email));
      const payload = {
        ok: true,
        message: 'Te enviamos un código a tu correo.',
      };
      if (OTP_EXPOSE) payload.devCode = OTP_DEV_CODE;
      return send(res, 200, payload);
    }

    if (req.method === 'POST' && pathname === '/auth/register-titular') {
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const birthDate = String(body.birthDate ?? '').trim() || null;
      const email = normalizeEmail(body.email ?? '');
      const emailCode = String(body.emailCode ?? '').trim();
      const phone = normalizePhone(body.phone ?? '');
      const phoneCode = String(body.phoneCode ?? '').trim();
      const installId = body.installId;
      if (name.length < 2) return send(res, 400, { error: 'Escribí tu nombre completo.' });
      if (!email.includes('@')) return send(res, 400, { error: 'Escribí un mail válido.' });
      if (phone.length < 8) return send(res, 400, { error: 'Escribí un teléfono válido.' });
      if (!checkOtp(emailOtpKey(email), emailCode)) {
        return send(res, 400, { error: 'El código del mail no es válido o venció.' });
      }
      if (!checkOtp(phone, phoneCode)) {
        return send(res, 400, { error: 'El código del teléfono no es válido o venció.' });
      }

      const already = findDeviceByInstall(installId);
      if (already && already.user_id) {
        const bound = db.prepare('SELECT * FROM users WHERE id = ?').get(already.user_id);
        if (bound && bound.phone && bound.phone !== phone) {
          return send(res, 409, {
            error:
              `Este celular ya es de ${already.user_name}. ` +
              'Cada celular es de una sola persona.',
          });
        }
      }

      const byPhone = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (byPhone || byEmail) {
        return send(res, 409, {
          error: 'Ese teléfono o mail ya tiene cuenta. Entrá con “Ya tengo cuenta” o usá otro dato.',
        });
      }

      const id = uuid();
      db.prepare(
        `INSERT INTO users (id, family_id, role, name, phone, email, birth_date, created_at)
         VALUES (?, NULL, 'admin_adult', ?, ?, ?, ?, ?)`,
      ).run(id, name, phone, email, birthDate, nowIso());
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      const bind = bindInstallToUser(installId, user, body.platform ?? 'android');
      if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });

      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(emailOtpKey(email));

      return send(res, 201, {
        user: userPublic(user),
        deviceId: bind.deviceId,
        ...issueTokens(user),
      });
    }

    if (req.method === 'GET' && pathname === '/devices/lookup') {
      const installId = url.searchParams.get('installId') ?? '';
      const bound = findDeviceByInstall(installId);
      if (!bound) return send(res, 200, { bound: false });
      const family = bound.user_family_id
        ? db.prepare('SELECT * FROM families WHERE id = ?').get(bound.user_family_id)
        : null;
      return send(res, 200, {
        bound: true,
        user: {
          id: bound.user_id,
          name: bound.user_name,
          role: bound.user_role,
          phone: bound.user_phone,
        },
        family: family ? { id: family.id, name: family.name } : null,
      });
    }

    if (req.method === 'POST' && pathname === '/auth/verify-otp') {
      const body = await readBody(req);
      const phone = normalizePhone(body.phone ?? '');
      const code = String(body.code ?? '').trim();
      const installId = body.installId;
      const otp = db
        .prepare('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1')
        .get(phone);
      if (!otp || new Date(otp.expires_at) < new Date() || otp.code !== code) {
        return send(res, 400, { error: 'El código no es válido o venció.' });
      }

      // Si este celular ya es de otra persona, no dejar entrar con otro teléfono/rol
      const already = findDeviceByInstall(installId);
      if (already && already.user_phone && already.user_phone !== phone) {
        return send(res, 409, {
          error:
            `Este celular ya es de ${already.user_name}. ` +
            'Cada celular es de una sola persona. Usá otro celular para otra persona.',
          boundUser: {
            id: already.user_id,
            name: already.user_name,
            role: already.user_role,
          },
        });
      }
      if (already && !already.user_phone && already.user_id) {
        // Celular atado a hijo/a con PIN: no permitir OTP de otra persona
        const boundUser = db.prepare('SELECT * FROM users WHERE id = ?').get(already.user_id);
        if (boundUser && boundUser.phone !== phone) {
          return send(res, 409, {
            error:
              `Este celular ya es de ${already.user_name}. ` +
              'Cada celular es de una sola persona. Usá otro celular para otra persona.',
          });
        }
      }

      let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      if (!user) {
        if (already) {
          return send(res, 409, {
            error:
              `Este celular ya es de ${already.user_name}. ` +
              'No se puede crear otra cuenta acá. Usá otro celular.',
          });
        }
        const id = uuid();
        db.prepare(
          `INSERT INTO users (id, family_id, role, name, phone, created_at)
           VALUES (?, NULL, 'adult', ?, ?, ?)`,
        ).run(id, (body.name ?? '').trim() || 'Sin nombre', phone, nowIso());
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      }

      const bind = bindInstallToUser(installId, user, body.platform ?? 'android');
      if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });

      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
      return send(res, 200, {
        user: userPublic(user),
        deviceId: bind.deviceId,
        ...issueTokens(user),
      });
    }

    if (req.method === 'POST' && pathname === '/auth/login-with-pin') {
      const body = await readBody(req);
      const installId = body.installId;
      const inv = findInvitation(body.inviteTokenOrCode ?? '');
      if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
        return send(res, 404, { error: 'Esa invitación no sirve o venció.' });
      }
      if (inv.role !== 'kid' || !inv.pin_hash) {
        return send(res, 400, { error: 'Esta invitación no usa PIN.' });
      }
      if (!verifyPin(String(body.pin ?? ''), inv.pin_hash)) {
        return send(res, 401, { error: 'PIN incorrecto.' });
      }

      const already = findDeviceByInstall(installId);
      if (already && already.user_id) {
        // Si es otro usuario, bloquear; si es reinstalación del mismo, bindInstall lo reata
        const boundUser = db.prepare('SELECT * FROM users WHERE id = ?').get(already.user_id);
        if (boundUser && boundUser.role === 'kid' && boundUser.name === inv.name_hint) {
          // permitir continuar hacia bind
        } else if (already) {
          return send(res, 409, {
            error:
              `Este celular ya es de ${already.user_name}. ` +
              'No se puede entrar como otra persona desde acá. Usá otro celular.',
          });
        }
      }

      let user = db
        .prepare(`SELECT * FROM users WHERE family_id = ? AND role = 'kid' AND name = ?`)
        .get(inv.family_id, inv.name_hint);
      if (!user) {
        const id = uuid();
        db.prepare(
          `INSERT INTO users (id, family_id, role, name, pin_hash, created_at)
           VALUES (?, ?, 'kid', ?, ?, ?)`,
        ).run(id, inv.family_id, inv.name_hint, inv.pin_hash, nowIso());
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      }
      db.prepare(
        `UPDATE invitations SET status = 'accepted', accepted_by_user_id = ? WHERE id = ?`,
      ).run(user.id, inv.id);
      const bind = bindInstallToUser(installId, user, body.platform ?? 'android');
      if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });
      return send(res, 200, {
        user: userPublic(user),
        family: { id: inv.family_id, name: inv.family_name },
        deviceId: bind.deviceId,
        ...issueTokens(user),
      });
    }

    if (req.method === 'POST' && pathname === '/auth/refresh') {
      const body = await readBody(req);
      const token = String(body.refreshToken ?? '').trim();
      if (token.length < 10) {
        return send(res, 400, { error: 'Falta el refresh token.' });
      }
      try {
        const payload = verifyJwt(token, JWT_REFRESH);
        if (payload.typ !== 'refresh') {
          return send(res, 401, { error: 'Sesión inválida.' });
        }
        const hash = hashToken(token);
        const stored = db
          .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
          .get(hash);
        if (
          !stored ||
          stored.user_id !== payload.sub ||
          new Date(stored.expires_at) < new Date()
        ) {
          return send(res, 401, { error: 'Sesión inválida.' });
        }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!user) {
          return send(res, 401, { error: 'Sesión inválida.' });
        }
        db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id);
        return send(res, 200, {
          user: userPublic(user),
          ...issueTokens(user),
        });
      } catch {
        return send(res, 401, { error: 'Sesión vencida.' });
      }
    }

    if (req.method === 'GET' && pathname === '/auth/me') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const family = user.family_id
        ? db.prepare('SELECT * FROM families WHERE id = ?').get(user.family_id)
        : null;
      return send(res, 200, {
        user: userPublic(user),
        family: family ? { id: family.id, name: family.name, createdAt: family.created_at } : null,
      });
    }

    if (req.method === 'GET' && pathname === '/account/profile') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const profile = getOrCreateProfile(user.id);
      const family = user.family_id
        ? db.prepare('SELECT * FROM families WHERE id = ?').get(user.family_id)
        : null;
      return send(res, 200, {
        user: userPublic(user),
        profile: profilePublic(profile, user),
        family: family
          ? { id: family.id, name: family.name, createdAt: family.created_at }
          : null,
      });
    }

    if (req.method === 'PATCH' && pathname === '/account/profile') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      if (user.role !== 'admin_adult' && user.role !== 'adult') {
        return send(res, 403, {
          error: 'Solo un adulto puede completar el perfil de la cuenta.',
        });
      }
      const body = await readBody(req);
      const profile = getOrCreateProfile(user.id);
      const emailRaw = body.email != null ? String(body.email).trim() : profile.email;
      const email =
        emailRaw == null || emailRaw === ''
          ? null
          : normalizeEmail(emailRaw);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { error: 'El correo no parece válido.' });
      }
      const city =
        body.city != null ? String(body.city).trim().slice(0, 80) || null : profile.city;
      let kidsCount = profile.kids_count;
      if (body.kidsCount !== undefined) {
        if (body.kidsCount === null || body.kidsCount === '') {
          kidsCount = null;
        } else {
          const n = Number(body.kidsCount);
          if (!Number.isFinite(n) || n < 0 || n > 20) {
            return send(res, 400, { error: 'Indicá cuántos hijos/as (0 a 20).' });
          }
          kidsCount = Math.round(n);
        }
      }
      const kidsAges =
        body.kidsAges != null
          ? String(body.kidsAges).trim().slice(0, 120) || null
          : profile.kids_ages;
      const allowedConcern = new Set([
        'school_alone',
        'peace_of_mind',
        'routines',
        'after_school',
        'other',
        '',
      ]);
      const allowedFound = new Set([
        'recommendation',
        'school',
        'social',
        'search',
        'other',
        '',
      ]);
      let mainConcern = profile.main_concern;
      if (body.mainConcern !== undefined) {
        const v = String(body.mainConcern ?? '').trim();
        if (!allowedConcern.has(v)) {
          return send(res, 400, { error: 'Elegí un motivo de la lista.' });
        }
        mainConcern = v || null;
      }
      let howFound = profile.how_found;
      if (body.howFound !== undefined) {
        const v = String(body.howFound ?? '').trim();
        if (!allowedFound.has(v)) {
          return send(res, 400, { error: 'Elegí cómo nos conociste de la lista.' });
        }
        howFound = v || null;
      }
      const displayName =
        body.displayName != null
          ? String(body.displayName).trim().slice(0, 60)
          : null;
      if (displayName != null && displayName.length > 0 && displayName.length < 2) {
        return send(res, 400, { error: 'El nombre es muy corto.' });
      }
      const ts = nowIso();
      db.prepare(
        `UPDATE account_profiles
         SET email = ?, city = ?, kids_count = ?, kids_ages = ?,
             main_concern = ?, how_found = ?, plan = 'free', updated_at = ?
         WHERE user_id = ?`,
      ).run(email, city, kidsCount, kidsAges, mainConcern, howFound, ts, user.id);
      if (email != null || displayName) {
        db.prepare(
          `UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name) WHERE id = ?`,
        ).run(email, displayName && displayName.length >= 2 ? displayName : null, user.id);
      }
      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      const updatedProfile = db
        .prepare('SELECT * FROM account_profiles WHERE user_id = ?')
        .get(user.id);
      const family = updatedUser.family_id
        ? db.prepare('SELECT * FROM families WHERE id = ?').get(updatedUser.family_id)
        : null;
      return send(res, 200, {
        user: userPublic(updatedUser),
        profile: profilePublic(updatedProfile, updatedUser),
        family: family
          ? { id: family.id, name: family.name, createdAt: family.created_at }
          : null,
      });
    }

    // FAMILIES
    if (req.method === 'POST' && pathname === '/families') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      if (user.family_id) return send(res, 400, { error: 'Ya estás en una familia.' });
      const body = await readBody(req);
      const familyName = String(body.name ?? '').trim();
      const relationshipLabel = String(body.relationshipLabel ?? '').trim();
      const displayName = String(body.displayName ?? user.name).trim();
      if (familyName.length < 2 || relationshipLabel.length < 2) {
        return send(res, 400, { error: 'Escribí el nombre de la familia y tu rol.' });
      }
      if (body.installId) {
        const bind = bindInstallToUser(body.installId, user, body.platform ?? 'android');
        if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });
      }
      const familyId = uuid();
      db.prepare(`INSERT INTO families (id, name, created_at) VALUES (?, ?, ?)`).run(
        familyId,
        familyName,
        nowIso(),
      );
      db.prepare(
        `UPDATE users SET family_id = ?, role = 'admin_adult', name = ?, relationship_label = ? WHERE id = ?`,
      ).run(familyId, displayName, relationshipLabel, user.id);
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return send(res, 201, {
        family: { id: familyId, name: familyName, createdAt: nowIso() },
        user: userPublic(updated),
        ...issueTokens(updated),
      });
    }

    // INVITATIONS
    if (req.method === 'POST' && pathname === '/invitations') {
      const user = authUser(req);
      // Sin sesión válida → 401 (la app puede refrescar token). No mezclar con 403 de rol.
      if (!user) {
        return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      }
      if (!user.family_id) {
        return send(res, 400, {
          error: 'Todavía no estás en una familia. Creá o aceptá una invitación primero.',
        });
      }
      // Cualquier adulto (titular u otro) puede invitar; solo menores no.
      if (!isAdultRole(user.role)) {
        return send(res, 403, {
          error: 'Solo un adulto de la familia puede invitar. Tu sesión no es de adulto.',
        });
      }
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const role = body.role === 'kid' ? 'kid' : 'adult';
      if (name.length < 2) return send(res, 400, { error: 'Indicá nombre y rol.' });
      let pinHash = null;
      if (role === 'kid' && body.pin) {
        if (!/^\d{4}$/.test(String(body.pin))) {
          return send(res, 400, { error: 'El PIN debe tener 4 números.' });
        }
        pinHash = hashPin(String(body.pin));
      }
      const code = randomDigits(6);
      const deepLinkToken = randomToken(10);
      const id = uuid();
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT INTO invitations
         (id, family_id, created_by_user_id, role, name_hint, code, deep_link_token, status, pin_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(id, user.family_id, user.id, role, name, code, deepLinkToken, pinHash, expiresAt, nowIso());
      const family = db.prepare('SELECT * FROM families WHERE id = ?').get(user.family_id);
      const host = req.headers.host || `localhost:${PORT}`;
      const base = publicInviteBase(body.publicBaseUrl, host);
      const inviteUrl = `${base}/i/${deepLinkToken}`;
      const roleLabel = role === 'kid' ? 'hijo/a' : 'adulto';
      const shareMessage = buildShareMessage({ name, inviteUrl, roleLabel });
      const warnsLocalhost = /localhost|127\.0\.0\.1/i.test(inviteUrl);
      return send(res, 201, {
        invitation: {
          id,
          familyId: user.family_id,
          familyName: family.name,
          role,
          nameHint: name,
          code,
          deepLinkToken,
          status: 'pending',
          expiresAt,
          requiresPin: Boolean(pinHash),
          inviteUrl,
        },
        inviteUrl,
        downloadUrl: `${base}/download/llegue.apk`,
        shareMessage,
        warnsLocalhost,
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/invitations/') && !pathname.endsWith('/accept')) {
      const token = pathname.slice('/invitations/'.length);
      const inv = findInvitation(token);
      if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
        return send(res, 410, { error: 'Esta invitación ya no sirve. Pedí una nueva.' });
      }
      return send(res, 200, {
        invitation: {
          id: inv.id,
          familyId: inv.family_id,
          familyName: inv.family_name,
          role: inv.role,
          nameHint: inv.name_hint,
          code: inv.code,
          deepLinkToken: inv.deep_link_token,
          status: inv.status,
          expiresAt: inv.expires_at,
          requiresPin: Boolean(inv.pin_hash) && inv.role === 'kid',
        },
      });
    }

    if (req.method === 'POST' && pathname.startsWith('/invitations/') && pathname.endsWith('/accept')) {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      if (user.family_id) return send(res, 400, { error: 'Ya estás en una familia.' });
      const token = pathname.slice('/invitations/'.length, -'/accept'.length);
      const inv = findInvitation(token);
      if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
        return send(res, 404, { error: 'Esta invitación no sirve o venció.' });
      }
      const body = await readBody(req);
      if (inv.role === 'kid' && inv.pin_hash) {
        if (!verifyPin(String(body.pin ?? ''), inv.pin_hash)) {
          return send(res, 401, { error: 'PIN incorrecto.' });
        }
      }

      const bind = bindInstallToUser(body.installId, user, body.platform ?? 'android');
      if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });

      db.prepare(
        `UPDATE users SET family_id = ?, role = ?, name = ?, relationship_label = ?, pin_hash = COALESCE(?, pin_hash)
         WHERE id = ?`,
      ).run(
        inv.family_id,
        inv.role === 'kid' ? 'kid' : 'adult',
        inv.name_hint,
        inv.role === 'adult' ? 'Familiar' : null,
        inv.pin_hash,
        user.id,
      );
      db.prepare(
        `UPDATE invitations SET status = 'accepted', accepted_by_user_id = ? WHERE id = ?`,
      ).run(user.id, inv.id);
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return send(res, 200, {
        user: userPublic(updated),
        family: { id: inv.family_id, name: inv.family_name },
        deviceId: bind.deviceId,
        ...issueTokens(updated),
      });
    }

    // DEVICES
    if (req.method === 'POST' && pathname === '/devices/register') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const body = await readBody(req);
      const installId = body.installId;
      if (!installId) {
        return send(res, 400, { error: 'Falta identificar el celular.' });
      }
      const bind = bindInstallToUser(installId, user, body.platform ?? 'android');
      if (!bind.ok) return send(res, bind.status, { error: bind.error, boundUser: bind.boundUser });

      if (body.pushToken) {
        db.prepare(`UPDATE devices SET push_token = ?, last_seen_at = ? WHERE id = ?`).run(
          body.pushToken,
          nowIso(),
          bind.deviceId,
        );
      }
      const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(bind.deviceId);
      return send(res, 201, {
        device: {
          id: device.id,
          installId: device.install_id,
          platform: device.platform,
          locationPermission: device.location_permission,
          notificationsPermission: device.notifications_permission,
          permissionsCompletedAt: device.permissions_completed_at,
          lastSeenAt: device.last_seen_at,
          batteryLevel: device.battery_level,
        },
      });
    }

    if (req.method === 'PATCH' && pathname === '/devices/me/battery') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const body = await readBody(req);
      const level = Number(body.batteryLevel);
      if (!Number.isFinite(level)) {
        return send(res, 400, { error: 'Falta el nivel de batería.' });
      }
      let device = body.deviceId
        ? db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(body.deviceId, user.id)
        : db
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1')
            .get(user.id);
      if (!device) {
        const id = uuid();
        db.prepare(
          `INSERT INTO devices
           (id, user_id, platform, location_permission, notifications_permission, battery_level, last_seen_at, created_at)
           VALUES (?, ?, 'android', 'not_asked', 'not_asked', ?, ?, ?)`,
        ).run(id, user.id, Math.round(level), nowIso(), nowIso());
        device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      } else {
        db.prepare(
          `UPDATE devices SET battery_level = ?, last_seen_at = ? WHERE id = ?`,
        ).run(Math.round(level), nowIso(), device.id);
        device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
      }

      let eventResult = null;
      if (level <= 20 && user.role === 'kid' && user.family_id) {
        const sinceBatt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const recentBatt = db
          .prepare(
            `SELECT id FROM events WHERE kid_id = ? AND type = 'low_battery' AND created_at >= ? LIMIT 1`,
          )
          .get(user.id, sinceBatt);
        if (!recentBatt) {
          eventResult = createEvent({
            kid: user,
            type: 'low_battery',
            payload: { batteryLevel: Math.round(level) },
            forceNotify: true,
          });
        }
      }
      const geoBatt = coordsFromBody(body);
      let locationEvents = [];
      if (geoBatt && user.role === 'kid') {
        locationEvents = applyKidLocation(user, geoBatt.lat, geoBatt.lng, device.id).events;
      }
      return send(res, 200, {
        device: {
          id: device.id,
          batteryLevel: device.battery_level,
          lastSeenAt: device.last_seen_at,
        },
        event: eventResult?.event ?? locationEvents[0]?.event ?? null,
        locationEvents: locationEvents.map((e) => e.event),
      });
    }

    if (req.method === 'PATCH' && pathname === '/devices/me/presence') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const body = await readBody(req);
      const state = String(body.state ?? '').toLowerCase();
      if (state !== 'foreground' && state !== 'background') {
        return send(res, 400, { error: 'Estado inválido.' });
      }
      let device = body.deviceId
        ? db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(body.deviceId, user.id)
        : db
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1')
            .get(user.id);
      if (!device) {
        return send(res, 404, { error: 'No encontramos este celular.' });
      }
      const bgAt = state === 'background' ? nowIso() : null;
      db.prepare(
        `UPDATE devices SET app_state = ?, app_background_at = ?, last_seen_at = ? WHERE id = ?`,
      ).run(state, bgAt, nowIso(), device.id);

      const geo = coordsFromBody(body);
      let locationEvents = [];
      if (geo && user.role === 'kid') {
        locationEvents = applyKidLocation(user, geo.lat, geo.lng, device.id).events;
      }

      let eventResult = null;
      // Solo “cerró la app” si el celular lo confirma de verdad (proceso terminado),
      // no cuando apaga la pantalla o entra en ahorro.
      if (
        state === 'background' &&
        body.immediate === true &&
        user.role === 'kid' &&
        user.family_id
      ) {
        const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const recent = db
          .prepare(
            `SELECT id FROM events WHERE kid_id = ? AND type = 'app_closed' AND created_at >= ? LIMIT 1`,
          )
          .get(user.id, since);
        if (!recent) {
          eventResult = createEvent({
            kid: user,
            type: 'app_closed',
            forceNotify: true,
            payload: stoppedSharingPayload(user, { source: 'presence', immediate: true }),
          });
        }
      }
      return send(res, 200, {
        ok: true,
        appState: state,
        event: eventResult?.event ?? locationEvents[0]?.event ?? null,
        locationEvents: locationEvents.map((e) => e.event),
      });
    }

    if (req.method === 'PATCH' && pathname === '/devices/me/location') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const body = await readBody(req);
      const geo = coordsFromBody(body);
      if (!geo) return send(res, 400, { error: 'Falta la ubicación (lat/lng).' });
      let device = body.deviceId
        ? db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(body.deviceId, user.id)
        : db
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1')
            .get(user.id);
      if (!device) {
        return send(res, 404, { error: 'No encontramos este celular.' });
      }
      let locationEvents = [];
      if (user.role === 'kid') {
        locationEvents = applyKidLocation(user, geo.lat, geo.lng, device.id).events;
      } else {
        db.prepare(
          `UPDATE devices SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE id = ?`,
        ).run(geo.lat, geo.lng, nowIso(), device.id);
      }
      const trip =
        user.role === 'kid' ? liveKidTrip(user.id) : null;
      return send(res, 200, {
        ok: true,
        events: locationEvents.map((e) => e.event),
        trip: trip ? tripPublic(trip) : null,
        geofences: user.role === 'kid' ? monitorGeofencesForKid(user) : [],
      });
    }

    if (req.method === 'PATCH' && pathname === '/devices/me/permissions') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const body = await readBody(req);
      let device = body.deviceId
        ? db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(body.deviceId, user.id)
        : db
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1')
            .get(user.id);
      if (!device) {
        const id = uuid();
        db.prepare(
          `INSERT INTO devices
           (id, user_id, platform, location_permission, notifications_permission, last_seen_at, created_at)
           VALUES (?, ?, 'android', 'not_asked', 'not_asked', ?, ?)`,
        ).run(id, user.id, nowIso(), nowIso());
        device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
      }
      const locationPermission = normalizeLocationPermission(body.locationPermission);
      const locationOk = locationPermission === 'always';
      const notifOk = body.notificationsPermission === 'granted';
      const completed = locationOk && notifOk;
      const gpsOk = body.locationOk === false ? 0 : 1;
      const wasSharing = deviceEverFullyShared(device) && deviceSharingHealthy(device);
      // No borrar el sello de “alguna vez compartió”: si no, el heartbeat vuelve a tratarlo como onboarding.
      const nextCompletedAt = completed
        ? (device.permissions_completed_at || nowIso())
        : device.permissions_completed_at;
      db.prepare(
        `UPDATE devices SET location_permission = ?, notifications_permission = ?,
         permissions_completed_at = ?, last_seen_at = ?, location_ok = ? WHERE id = ?`,
      ).run(
        locationPermission,
        body.notificationsPermission,
        nextCompletedAt,
        nowIso(),
        gpsOk,
        device.id,
      );
      const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);

      // Solo si ANTES compartía bien y ahora no (no en el primer onboarding).
      if (
        user.role === 'kid' &&
        user.family_id &&
        wasSharing &&
        devicePermissionStoppedSharing(updated)
      ) {
        const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const recent = db
          .prepare(
            `SELECT id FROM events WHERE kid_id = ? AND type = 'location_lost' AND created_at >= ? LIMIT 1`,
          )
          .get(user.id, since);
        if (!recent) {
          createEvent({
            kid: user,
            type: 'location_lost',
            forceNotify: true,
            payload: stoppedSharingPayload(user, {
              locationPermission: updated.location_permission,
              locationOk: updated.location_ok,
              source: 'permission_update',
            }),
          });
        }
      }

      return send(res, 200, {
        device: {
          id: updated.id,
          platform: updated.platform,
          locationPermission: updated.location_permission,
          notificationsPermission: updated.notifications_permission,
          permissionsCompletedAt: updated.permissions_completed_at,
          lastSeenAt: updated.last_seen_at,
        },
        permissionsReady: Boolean(updated.permissions_completed_at) && locationOk && notifOk,
      });
    }

    // PLACES
    if (req.method === 'GET' && pathname === '/places') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const includePending = url.searchParams.get('includePending') === '1';
      const rows = db
        .prepare(
          includePending && isAdultRole(user.role)
            ? `SELECT * FROM places WHERE family_id = ? AND status != 'deleted' AND status != 'inactive' ORDER BY created_at DESC`
            : `SELECT * FROM places WHERE family_id = ? AND status = 'active' ORDER BY created_at DESC`,
        )
        .all(user.family_id);
      return send(res, 200, { places: rows.map(placePublic) });
    }

    if (req.method === 'POST' && pathname === '/places') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo un adulto puede cargar lugares. Podés sugerir uno.' });
      }
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (name.length < 2) return send(res, 400, { error: 'Poné un nombre al lugar.' });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return send(res, 400, { error: 'Falta la ubicación del lugar.' });
      }
      const id = uuid();
      const type = ['home', 'school', 'activity', 'favorite', 'special'].includes(body.type)
        ? body.type
        : 'favorite';
      const radius = Number(body.radiusM) > 0 ? Math.min(Number(body.radiusM), 500) : 60;
      db.prepare(
        `INSERT INTO places
         (id, family_id, created_by_user_id, name, lat, lng, radius_m, type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(id, user.family_id, user.id, name, lat, lng, radius, type, nowIso());
      return send(res, 201, { place: placePublic(db.prepare('SELECT * FROM places WHERE id = ?').get(id)) });
    }

    if (req.method === 'POST' && pathname === '/places/suggest') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (user.role !== 'kid') return send(res, 403, { error: 'Solo un hijo/a puede sugerir lugares.' });
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (name.length < 2) return send(res, 400, { error: 'Poné un nombre al lugar.' });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return send(res, 400, { error: 'Falta la ubicación del lugar.' });
      }
      const id = uuid();
      db.prepare(
        `INSERT INTO places
         (id, family_id, created_by_user_id, name, lat, lng, radius_m, type, suggested_by_kid_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 60, 'favorite', ?, 'pending_approval', ?)`,
      ).run(id, user.family_id, user.id, name, lat, lng, user.id, nowIso());
      createEvent({
        kid: user,
        type: 'place_suggested',
        placeId: id,
        forceNotify: true,
      });
      return send(res, 201, { place: placePublic(db.prepare('SELECT * FROM places WHERE id = ?').get(id)) });
    }

    if (req.method === 'POST' && /^\/places\/[^/]+\/approve$/.test(pathname)) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) return send(res, 403, { error: 'Solo un adulto puede aprobar.' });
      const placeId = pathname.split('/')[2];
      const place = db
        .prepare('SELECT * FROM places WHERE id = ? AND family_id = ?')
        .get(placeId, user.family_id);
      if (!place) return send(res, 404, { error: 'No encontramos ese lugar.' });
      db.prepare(`UPDATE places SET status = 'active' WHERE id = ?`).run(placeId);
      if (place.suggested_by_kid_id) {
        const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(place.suggested_by_kid_id);
        if (kid) {
          const { event } = createEvent({
            kid,
            type: 'place_approved',
            placeId,
            forceNotify: false,
          });
          notifyKidUser(
            kid.id,
            'Lugar aceptado',
            `Ya podés usar “${place.name}” en Llegué`,
            event.id,
          );
        }
      }
      return send(res, 200, { place: placePublic(db.prepare('SELECT * FROM places WHERE id = ?').get(placeId)) });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/places/')) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) return send(res, 403, { error: 'Solo un adulto puede borrar lugares.' });
      const placeId = pathname.slice('/places/'.length).split('/')[0];
      const place = db
        .prepare('SELECT * FROM places WHERE id = ? AND family_id = ?')
        .get(placeId, user.family_id);
      if (!place) return send(res, 404, { error: 'No encontramos ese lugar.' });
      // Soft-delete: evita fallar por rutinas/eventos vinculados
      db.prepare(`DELETE FROM routines WHERE place_id = ?`).run(placeId);
      db.prepare(
        `UPDATE places SET status = 'deleted' WHERE id = ?`,
      ).run(placeId);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'PATCH' && pathname.startsWith('/places/')) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo un adulto puede editar lugares.' });
      }
      const placeId = pathname.slice('/places/'.length).split('/')[0];
      if (placeId.includes('/')) {
        // /places/:id/approve ya se maneja arriba
      }
      const place = db
        .prepare(`SELECT * FROM places WHERE id = ? AND family_id = ? AND status != 'deleted'`)
        .get(placeId, user.family_id);
      if (!place) return send(res, 404, { error: 'No encontramos ese lugar.' });
      const body = await readBody(req);
      const name = body.name != null ? String(body.name).trim() : place.name;
      const lat = body.lat != null ? Number(body.lat) : place.lat;
      const lng = body.lng != null ? Number(body.lng) : place.lng;
      const type = ['home', 'school', 'activity', 'favorite', 'special'].includes(body.type)
        ? body.type
        : place.type;
      const radius =
        body.radiusM != null && Number(body.radiusM) > 0
          ? Math.min(Number(body.radiusM), 500)
          : place.radius_m;
      if (name.length < 2) return send(res, 400, { error: 'Poné un nombre al lugar.' });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return send(res, 400, { error: 'Falta la ubicación del lugar.' });
      }
      db.prepare(
        `UPDATE places SET name = ?, lat = ?, lng = ?, type = ?, radius_m = ? WHERE id = ?`,
      ).run(name, lat, lng, type, radius, placeId);
      return send(res, 200, {
        place: placePublic(db.prepare('SELECT * FROM places WHERE id = ?').get(placeId)),
      });
    }

    // ROUTINES
    if (req.method === 'GET' && pathname === '/routines') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const kidId = url.searchParams.get('kidId') || (user.role === 'kid' ? user.id : null);
      if (!kidId) return send(res, 400, { error: 'Indicá de qué hijo/a querés ver las rutinas.' });
      const kid = db.prepare('SELECT * FROM users WHERE id = ? AND family_id = ?').get(kidId, user.family_id);
      if (!kid) return send(res, 404, { error: 'No encontramos a esa persona.' });
      if (user.role === 'kid' && user.id !== kidId) {
        return send(res, 403, { error: 'Solo podés ver tus rutinas.' });
      }
      const rows = db
        .prepare('SELECT * FROM routines WHERE kid_id = ? ORDER BY created_at DESC')
        .all(kidId)
        .map((r) => ({
          id: r.id,
          kidId: r.kid_id,
          placeId: r.place_id,
          label: r.label,
          daysOfWeek: parseDays(r.days_of_week),
          startTime: r.start_time,
          endTime: r.end_time,
          active: Boolean(r.active),
          createdAt: r.created_at,
        }));
      return send(res, 200, { routines: rows });
    }

    if (req.method === 'POST' && pathname === '/routines') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) return send(res, 403, { error: 'Solo un adulto puede crear rutinas.' });
      const body = await readBody(req);
      const kid = db
        .prepare(`SELECT * FROM users WHERE id = ? AND family_id = ? AND role = 'kid'`)
        .get(body.kidId, user.family_id);
      if (!kid) return send(res, 404, { error: 'Elegí un hijo/a de la familia.' });
      const place = db
        .prepare(`SELECT * FROM places WHERE id = ? AND family_id = ? AND status = 'active'`)
        .get(body.placeId, user.family_id);
      if (!place) return send(res, 404, { error: 'Elegí un lugar guardado.' });
      const label = String(body.label ?? place.name).trim();
      const days = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : [1, 2, 3, 4, 5];
      const startTime = String(body.startTime ?? '08:00').slice(0, 5);
      const endTime = String(body.endTime ?? '13:00').slice(0, 5);
      const id = uuid();
      db.prepare(
        `INSERT INTO routines
         (id, kid_id, place_id, label, days_of_week, start_time, end_time, active, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, kid.id, place.id, label, JSON.stringify(days), startTime, endTime, user.id, nowIso());
      const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
      return send(res, 201, {
        routine: {
          id: r.id,
          kidId: r.kid_id,
          placeId: r.place_id,
          label: r.label,
          daysOfWeek: parseDays(r.days_of_week),
          startTime: r.start_time,
          endTime: r.end_time,
          active: true,
          createdAt: r.created_at,
        },
      });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/routines/')) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo un adulto puede borrar rutinas.' });
      }
      const routineId = pathname.slice('/routines/'.length);
      const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId);
      if (!r) return send(res, 404, { error: 'No encontramos esa rutina.' });
      const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(r.kid_id);
      if (!kid || kid.family_id !== user.family_id) {
        return send(res, 403, { error: 'No podés borrar esa rutina.' });
      }
      db.prepare(`DELETE FROM routines WHERE id = ?`).run(routineId);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'PATCH' && pathname.startsWith('/routines/')) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo un adulto puede editar rutinas.' });
      }
      const routineId = pathname.slice('/routines/'.length);
      const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId);
      if (!r) return send(res, 404, { error: 'No encontramos esa rutina.' });
      const kidOfRoutine = db.prepare('SELECT * FROM users WHERE id = ?').get(r.kid_id);
      if (!kidOfRoutine || kidOfRoutine.family_id !== user.family_id) {
        return send(res, 403, { error: 'No podés editar esa rutina.' });
      }
      const body = await readBody(req);
      let kidId = r.kid_id;
      if (body.kidId) {
        const kid = db
          .prepare(`SELECT * FROM users WHERE id = ? AND family_id = ? AND role = 'kid'`)
          .get(body.kidId, user.family_id);
        if (!kid) return send(res, 404, { error: 'Elegí un hijo/a de la familia.' });
        kidId = kid.id;
      }
      let placeId = r.place_id;
      if (body.placeId) {
        const place = db
          .prepare(`SELECT * FROM places WHERE id = ? AND family_id = ? AND status = 'active'`)
          .get(body.placeId, user.family_id);
        if (!place) return send(res, 404, { error: 'Elegí un lugar guardado.' });
        placeId = place.id;
      }
      const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
      const label =
        body.label != null ? String(body.label).trim() : r.label || place?.name || 'Rutina';
      const days = Array.isArray(body.daysOfWeek)
        ? body.daysOfWeek.map(Number)
        : parseDays(r.days_of_week);
      const startTime = body.startTime != null
        ? String(body.startTime).slice(0, 5)
        : r.start_time;
      const endTime = body.endTime != null
        ? String(body.endTime).slice(0, 5)
        : r.end_time;
      const active =
        body.active == null ? r.active : body.active === false || body.active === 0 ? 0 : 1;
      if (label.length < 1) return send(res, 400, { error: 'Poné un nombre a la rutina.' });
      db.prepare(
        `UPDATE routines
         SET kid_id = ?, place_id = ?, label = ?, days_of_week = ?, start_time = ?, end_time = ?, active = ?
         WHERE id = ?`,
      ).run(
        kidId,
        placeId,
        label,
        JSON.stringify(days),
        startTime,
        endTime,
        active,
        routineId,
      );
      const updated = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId);
      return send(res, 200, {
        routine: {
          id: updated.id,
          kidId: updated.kid_id,
          placeId: updated.place_id,
          label: updated.label,
          daysOfWeek: parseDays(updated.days_of_week),
          startTime: updated.start_time,
          endTime: updated.end_time,
          active: Boolean(updated.active),
          createdAt: updated.created_at,
        },
      });
    }

    // ALERT PREFS
    if (req.method === 'GET' && pathname === '/alert-prefs') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo los adultos configuran avisos.' });
      }
      return send(res, 200, { prefs: getAlertPrefs(user.id) });
    }

    if (req.method === 'PUT' && pathname === '/alert-prefs') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      if (!isAdultRole(user.role)) {
        return send(res, 403, { error: 'Solo los adultos configuran avisos.' });
      }
      const body = await readBody(req);
      const incoming = body.prefs && typeof body.prefs === 'object' ? body.prefs : body;
      const defaults = defaultAlertPrefs();
      for (const key of Object.keys(defaults)) {
        if (incoming[key] === undefined) continue;
        const enabled = incoming[key] === false || incoming[key] === 0 ? 0 : 1;
        if (key === 'panic') {
          db.prepare(
            `INSERT INTO alert_prefs (user_id, event_type, enabled) VALUES (?, ?, 1)
             ON CONFLICT(user_id, event_type) DO UPDATE SET enabled = 1`,
          ).run(user.id, key);
          continue;
        }
        db.prepare(
          `INSERT INTO alert_prefs (user_id, event_type, enabled) VALUES (?, ?, ?)
           ON CONFLICT(user_id, event_type) DO UPDATE SET enabled = excluded.enabled`,
        ).run(user.id, key, enabled);
      }
      return send(res, 200, { prefs: getAlertPrefs(user.id) });
    }

    // TRIPS
    if (req.method === 'GET' && pathname === '/trips/active') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const kidId = url.searchParams.get('kidId') || (user.role === 'kid' ? user.id : null);
      if (!kidId) return send(res, 400, { error: 'Indicá el hijo/a.' });
      const kid = db.prepare('SELECT * FROM users WHERE id = ? AND family_id = ?').get(kidId, user.family_id);
      if (!kid) return send(res, 404, { error: 'No encontramos a esa persona.' });
      const trip = db
        .prepare(`SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue') ORDER BY started_at DESC LIMIT 1`)
        .get(kidId);
      return send(res, 200, {
        trip: trip ? tripPublic(trip) : null,
        geofences: monitorGeofencesForKid(kid),
      });
    }

    if (req.method === 'POST' && pathname === '/trips') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const kidId = user.role === 'kid' ? user.id : body.kidId;
      const kid = db
        .prepare(`SELECT * FROM users WHERE id = ? AND family_id = ? AND role = 'kid'`)
        .get(kidId, user.family_id);
      if (!kid) return send(res, 404, { error: 'Solo se pueden registrar salidas de un hijo/a.' });
      if (user.role === 'kid' && user.id !== kid.id) {
        return send(res, 403, { error: 'Solo podés avisar tu propia salida.' });
      }
      const existing = db
        .prepare(`SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue')`)
        .get(kid.id);
      if (existing) {
        return send(res, 400, { error: 'Ya hay una salida en curso. Primero marcá que llegaste.' });
      }
      let dest = resolveOrCreateTripDestination(user, body);
      if (body.destinationPlaceId && !dest) {
        return send(res, 404, { error: 'Ese lugar no está disponible.' });
      }
      const kind = String(body.kind ?? '');
      const wantsWalkingHome = kind === 'walking_home';
      if (!dest && wantsWalkingHome) {
        dest = familyHomePlace(user.family_id);
        if (!dest) {
          return send(res, 400, {
            error: 'Todavía no hay un lugar Casa. Pedile a un adulto que lo agregue.',
          });
        }
      }
      if (!dest) {
        return send(res, 400, { error: 'Elegí a dónde va la salida.' });
      }
      const id = uuid();
      const expected = body.expectedReturnAt ? String(body.expectedReturnAt) : null;
      const home = familyHomePlace(user.family_id);
      const phase = dest?.id ? 'pending_departure' : null;
      db.prepare(
        `INSERT INTO trips
         (id, kid_id, origin_place_id, destination_place_id, status, expected_return_at, started_at, created_at, phase, departed_at, created_by_user_id, created_by_name)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        kid.id,
        home?.id ?? null,
        dest?.id ?? null,
        expected,
        nowIso(),
        nowIso(),
        phase,
        user.id,
        user.name,
      );
      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
      const destIsHome = dest?.type === 'home';
      const isWalkingHome = kind === 'walking_home' || destIsHome;

      // Menor avisa “Regreso a casa” / salida: crear evento + push a adultos.
      // (Si arma un adulto, al menor le avisamos aparte; el EXIT Casa sigue siendo
      // el aviso geográfico de “salió”.)
      if (user.role === 'kid') {
        const eventType = isWalkingHome ? 'walking_home' : 'going_to';
        const created = createEvent({
          kid: user,
          type: eventType,
          placeId: dest?.id ?? null,
          tripId: id,
          forceNotify: true,
          payload: {
            source: 'trip_start',
            kind: kind || eventType,
            destinationPlaceId: dest?.id ?? null,
            destinationName: dest?.name ?? null,
            createdByUserId: user.id,
          },
        });
        const fresh = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
        return send(res, 201, {
          trip: tripPublic(fresh),
          event: created.event,
          notifiedCount: created.notifiedCount,
        });
      }

      let notifiedCount = 0;
      if (isAdultRole(user.role)) {
        const destLabel = dest?.name ? ` a ${dest.name}` : '';
        notifiedCount = notifyKidUser(
          kid.id,
          'Salida especial',
          isWalkingHome
            ? 'Te armaron un regreso a casa'
            : `Te armaron una salida especial${destLabel}`,
          null,
          dest
            ? {
                type: 'special_trip_created',
                tripId: id,
                destinationPlaceId: dest.id,
                destinationName: dest.name,
                destinationLat: dest.lat,
                destinationLng: dest.lng,
                destinationRadiusM: dest.radius_m,
              }
            : { type: 'special_trip_created', tripId: id },
        );
      }
      return send(res, 201, { trip: tripPublic(trip), event: null, notifiedCount });
    }

    if (req.method === 'PATCH' && pathname.startsWith('/trips/')) {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const rest = pathname.slice('/trips/'.length);
      const parts = rest.split('/').filter(Boolean);
      const tripId = parts[0];
      const pathAction = parts[1];
      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
      if (!trip) return send(res, 404, { error: 'No encontramos esa salida.' });
      const kid = db.prepare('SELECT * FROM users WHERE id = ?').get(trip.kid_id);
      if (!kid || kid.family_id !== user.family_id) {
        return send(res, 403, { error: 'No podés cambiar esa salida.' });
      }
      if (user.role === 'kid' && user.id !== kid.id) {
        return send(res, 403, { error: 'Solo podés cambiar tu salida.' });
      }
      const body = await readBody(req);
      const action = pathAction === 'cancel' ? 'cancel' : body.action || body.status;
      if (action === 'cancel' || action === 'cancelled') {
        if (trip.status === 'cancelled') {
          const again = cancelTripRecord(trip);
          return send(res, 200, { trip: tripPublic(again) });
        }
        if (!['active', 'overdue'].includes(trip.status)) {
          return send(res, 400, { error: 'Esa salida ya terminó.' });
        }
        const updated = cancelTripRecord(trip);
        return send(res, 200, { trip: tripPublic(updated) });
      }
      if (action === 'update' || action === 'edit') {
        if (!['active', 'overdue'].includes(trip.status)) {
          return send(res, 400, { error: 'Esa salida ya terminó.' });
        }
        let destId = trip.destination_place_id;
        if (Object.prototype.hasOwnProperty.call(body, 'destinationPlaceId')) {
          if (body.destinationPlaceId == null || body.destinationPlaceId === '') {
            destId = null;
          } else {
            const dest = db
              .prepare(`SELECT * FROM places WHERE id = ? AND family_id = ? AND status = 'active'`)
              .get(body.destinationPlaceId, user.family_id);
            if (!dest) return send(res, 404, { error: 'Ese lugar no está disponible.' });
            destId = dest.id;
          }
        }
        let expected = trip.expected_return_at;
        if (Object.prototype.hasOwnProperty.call(body, 'expectedReturnAt')) {
          expected = body.expectedReturnAt ? String(body.expectedReturnAt) : null;
        }
        db.prepare(
          `UPDATE trips SET destination_place_id = ?, expected_return_at = ? WHERE id = ?`,
        ).run(destId, expected, tripId);
        return send(res, 200, {
          trip: tripPublic(db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId)),
        });
      }
      if (action === 'arrive' || action === 'arrived') {
        if (!['active', 'overdue'].includes(trip.status)) {
          return send(res, 400, { error: 'Esa salida ya terminó.' });
        }
        const { event, notifiedCount } = createEvent({
          kid,
          type: 'arrival',
          placeId: trip.destination_place_id,
          tripId: trip.id,
          forceNotify: true,
        });
        // Marcado manual: cierra igual (ENTER destino de una especial no cierra solo).
        db.prepare(
          `UPDATE trips SET status = 'arrived', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status IN ('active','overdue')`,
        ).run(nowIso(), tripId);
        const updated = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
        return send(res, 200, { trip: tripPublic(updated), event, notifiedCount });
      }
      return send(res, 400, { error: 'Acción no reconocida.' });
    }

    // EVENTS
    if (req.method === 'POST' && pathname === '/events') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const type = String(body.type ?? '');
      const allowed = [
        'arrival',
        'departure',
        'walking_home',
        'going_to',
        'delay',
        'panic',
        'im_ok',
        'low_battery',
        'location_lost',
        'app_closed',
        'return_prompt',
        'place_suggested',
        'place_approved',
      ];
      if (!allowed.includes(type)) return send(res, 400, { error: 'Tipo de aviso no válido.' });

      let kid = user;
      if (user.role !== 'kid') {
        // Los adultos NO generan avisos de llegada/salida propios.
        // Solo pueden registrar avisos de un hijo/a (kidId obligatorio).
        if (!body.kidId) {
          return send(res, 400, {
            error: 'Solo se registran llegadas y salidas del hijo/a.',
          });
        }
        kid = db
          .prepare(`SELECT * FROM users WHERE id = ? AND family_id = ? AND role = 'kid'`)
          .get(body.kidId, user.family_id);
        if (!kid) return send(res, 404, { error: 'No encontramos a ese hijo/a.' });
      }

      let placeId = body.placeId ?? body.place_id ?? null;
      const payloadIn = body.payload && typeof body.payload === 'object' ? body.payload : {};
      const placeName =
        body.placeName ??
        body.place_name ??
        (typeof body.place === 'string' ? body.place : null) ??
        payloadIn.placeName ??
        payloadIn.place_name ??
        null;
      if (placeId || placeName) {
        const found = lookupFamilyPlace(user.family_id, placeId, placeName, {
          includeInactive: type === 'arrival' || type === 'departure',
        });
        if (found) {
          placeId = found.id;
        } else if (placeId && (type === 'arrival' || type === 'departure')) {
          // ID de geocerca que la app no tiene en el servidor: no tirar 404, inferir por el viaje.
          placeId = null;
        } else if (placeId) {
          return send(res, 404, { error: 'Lugar no encontrado.' });
        }
      }

      let tripId = body.tripId ?? null;
      if (!tripId && (type === 'arrival' || type === 'departure')) {
        const active = db
          .prepare(`SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue')`)
          .get(kid.id);
        tripId = active?.id ?? null;
      }

      const geo = coordsFromBody(body) || coordsFromBody(payloadIn);
      if (!placeId && geo && (type === 'arrival' || type === 'departure')) {
        const tripRow = tripId
          ? db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId)
          : liveKidTrip(kid.id);
        const matched = matchSpecialGeofencePlace(tripRow, kid.family_id, geo.lat, geo.lng);
        if (matched) placeId = matched.id;
      }

      const result = createEvent({
        kid,
        type,
        placeId,
        tripId,
        payload: body.payload ?? null,
        forceNotify: body.forceNotify === true ? true : body.forceNotify === false ? false : null,
      });
      return send(res, 201, result);
    }

    if (req.method === 'GET' && pathname === '/events') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const since = url.searchParams.get('since');
      const kidId = url.searchParams.get('kidId');
      let rows;
      if (user.role === 'kid') {
        rows = db
          .prepare(
            since
              ? `SELECT * FROM events WHERE kid_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50`
              : `SELECT * FROM events WHERE kid_id = ? ORDER BY created_at DESC LIMIT 50`,
          )
          .all(...(since ? [user.id, since] : [user.id]));
      } else {
        const kids = kidId
          ? [kidId]
          : db
              .prepare(`SELECT id FROM users WHERE family_id = ? AND role = 'kid'`)
              .all(user.family_id)
              .map((k) => k.id);
        if (kids.length === 0) return send(res, 200, { events: [] });
        const placeholders = kids.map(() => '?').join(',');
        rows = db
          .prepare(
            since
              ? `SELECT * FROM events WHERE kid_id IN (${placeholders}) AND created_at >= ? ORDER BY created_at DESC LIMIT 50`
              : `SELECT * FROM events WHERE kid_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 50`,
          )
          .all(...(since ? [...kids, since] : kids));
      }
      return send(res, 200, { events: rows.map(eventPublic) });
    }

    if (req.method === 'GET' && pathname === '/notifications/me') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Tenés que iniciar sesión.' });
      const rows = db
        .prepare(
          `SELECT * FROM notifications WHERE recipient_user_id = ? ORDER BY created_at DESC LIMIT 40`,
        )
        .all(user.id)
        .map((n) => ({
          id: n.id,
          eventId: n.event_id,
          status: n.status,
          title: n.title,
          body: n.body,
          sentAt: n.sent_at,
          createdAt: n.created_at,
        }));
      return send(res, 200, { notifications: rows });
    }

    if (req.method === 'GET' && pathname === '/family/status') {
      const user = requireFamilyUser(req, res);
      if (!user) return;
      const family = db.prepare('SELECT * FROM families WHERE id = ?').get(user.family_id);
      const members = db
        .prepare('SELECT * FROM users WHERE family_id = ? ORDER BY created_at ASC')
        .all(user.family_id)
        .map((m) => {
          const device = db
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1')
            .get(m.id);
          const activeTrip =
            m.role === 'kid'
              ? db
                  .prepare(
                    `SELECT * FROM trips WHERE kid_id = ? AND status IN ('active','overdue') ORDER BY started_at DESC LIMIT 1`,
                  )
                  .get(m.id)
              : null;
          const lastEventRaw =
            m.role === 'kid'
              ? db
                  .prepare(
                    `SELECT * FROM events WHERE kid_id = ? ORDER BY created_at DESC LIMIT 1`,
                  )
                  .get(m.id)
              : null;
          const presenceEvent =
            m.role === 'kid' ? lastPresenceEvent(m.id) : null;
          let hardHealth = null;
          let softHealth = null;
          if (!device) hardHealth = 'Todavía no está compartiendo';
          else if (!device.permissions_completed_at) {
            hardHealth = 'Todavía no está compartiendo';
          } else if (devicePermissionStoppedSharing(device)) {
            const loc = normalizeLocationPermission(device.location_permission);
            if (Number(device.location_ok) === 0 && loc === 'always') {
              hardHealth = 'GPS cortado';
            } else {
              hardHealth = 'Dejó de compartir ubicación';
            }
          } else if (device.notifications_permission === 'denied') {
            softHealth = 'Sin avisos';
          } else if (
            device.last_seen_at &&
            new Date(device.last_seen_at) < new Date(Date.now() - 30 * 60 * 1000)
          ) {
            softHealth = 'Hace rato no hay señales; pedile que abra Llegué';
          }
          const presence = memberPresence(m, presenceEvent || lastEventRaw, activeTrip, hardHealth);
          if (
            softHealth &&
            !hardHealth &&
            (!presenceEvent || presence.presenceStatus === 'unknown')
          ) {
            presence.presenceStatus = 'alert';
            presence.presenceLabel = softHealth;
          }
          const healthIssue = hardHealth || softHealth;
          const hardSharingStop =
            hardHealth === 'Dejó de compartir ubicación' ||
            hardHealth === 'GPS cortado' ||
            hardHealth === 'Todavía no está compartiendo';
          const lastEventForCard =
            hardSharingStop && lastEventRaw
              ? lastEventRaw
              : presenceEvent || lastEventRaw;
          let tripOut = null;
          if (activeTrip) {
            tripOut = tripPublic(activeTrip);
            if (activeTrip.destination_place_id) {
              const dest = db
                .prepare('SELECT name, type FROM places WHERE id = ?')
                .get(activeTrip.destination_place_id);
              tripOut.destinationName = dest?.name ?? null;
              tripOut.destinationType = dest?.type ?? null;
            }
          }
          return {
            ...userPublic(m),
            permissionsReady: Boolean(device?.permissions_completed_at),
            locationPermission: device?.location_permission ?? 'not_asked',
            notificationsPermission: device?.notifications_permission ?? 'not_asked',
            healthIssue,
            activeTrip: tripOut,
            lastEvent: lastEventForCard ? eventPublic(lastEventForCard) : null,
            ...presence,
          };
        });
      const places = db
        .prepare(`SELECT * FROM places WHERE family_id = ? AND status = 'active' ORDER BY created_at DESC`)
        .all(user.family_id)
        .map(placePublic);
      const pendingPlaces = isAdultRole(user.role)
        ? db
            .prepare(
              `SELECT * FROM places WHERE family_id = ? AND status = 'pending_approval' ORDER BY created_at DESC`,
            )
            .all(user.family_id)
            .map(placePublic)
        : [];
      const recentEvents = db
        .prepare(
          `SELECT e.* FROM events e
           JOIN users u ON u.id = e.kid_id
           WHERE u.family_id = ? AND u.role = 'kid'
           ORDER BY e.created_at DESC LIMIT 20`,
        )
        .all(user.family_id)
        .map(eventPublic);
      // Adultos: todos sus avisos. Hijo/a: solo aceptaciones (lugar / salida armada).
      const myNotifications = db
        .prepare(
          `SELECT * FROM notifications WHERE recipient_user_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .all(user.id)
        .map((n) => ({
          id: n.id,
          eventId: n.event_id,
          status: n.status,
          title: n.title,
          body: n.body,
          sentAt: n.sent_at,
          createdAt: n.created_at,
        }));
      return send(res, 200, {
        family: { id: family.id, name: family.name, createdAt: family.created_at },
        members,
        places,
        pendingPlaces,
        geofences:
          user.role === 'kid'
            ? monitorGeofencesForKid(user)
            : db
                .prepare(`SELECT id FROM users WHERE family_id = ? AND role = 'kid'`)
                .all(user.family_id)
                .flatMap((k) => {
                  const kidRow = db.prepare('SELECT * FROM users WHERE id = ?').get(k.id);
                  return monitorGeofencesForKid(kidRow);
                }),
        recentEvents: isAdultRole(user.role) ? recentEvents : [],
        notifications: myNotifications,
      });
    }

    return send(res, 404, { error: 'No encontrado' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Error interno. Probá de nuevo.' });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nEl puerto ${PORT} ya esta en uso.`);
    console.error('La API probablemente ya esta corriendo. No abras iniciar-api.bat otra vez.');
    console.error(`Proba en el navegador: http://localhost:${PORT}/health\n`);
    process.exit(1);
  }
  console.error('Error al arrancar la API:', err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Llegué API v2 en http://localhost:${PORT}`);
  console.log('Dejá esta ventana abierta.');
  if (seedInfo) {
    console.log('(SEED_FAMILIA activo — solo desarrollo)');
  }
  // Primera pasada al arrancar (no esperar 1 minuto).
  try {
    checkDelayedTrips();
    checkReturnPrompts();
    checkRoutineDelays();
    checkDeviceHealthAlerts();
  } catch (e) {
    console.error('jobs_boot', e);
  }
  setInterval(() => {
    try {
      checkDelayedTrips();
      checkReturnPrompts();
      checkRoutineDelays();
      checkDeviceHealthAlerts();
    } catch (e) {
      console.error('jobs', e);
    }
  }, 60 * 1000);
});
