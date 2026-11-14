/**
 * Salida trabada, reintento de POST /trips, avisos que se pueden recuperar
 * y POST /events después de re-vincular o migrar el celular del menor.
 * SQLite (LLEGUE_TEST=1). No abre DATABASE_URL.
 */
import './isolate-db.mjs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitHealth(base, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch {
      // arrancando
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('La API no respondió /health');
}

async function api(base, method, pathname, { token, body, headers } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function withDb(dbPath, fn) {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

function tripRow(dbPath, id) {
  return withDb(dbPath, (raw) => raw.prepare('SELECT * FROM trips WHERE id = ?').get(id));
}

function countTrips(dbPath, kidId) {
  return withDb(dbPath, (raw) =>
    raw.prepare('SELECT COUNT(*) AS n FROM trips WHERE kid_id = ?').get(kidId),
  ).n;
}

function countNotes(dbPath, userId) {
  return withDb(dbPath, (raw) =>
    raw.prepare('SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ?').get(userId),
  ).n;
}

async function login(base, phone, installId) {
  const reqOtp = await api(base, 'POST', '/auth/request-otp', { body: { phone } });
  assert(reqOtp.status === 200, `OTP ${phone}: ${JSON.stringify(reqOtp.json)}`);
  const verify = await api(base, 'POST', '/auth/verify-otp', {
    body: { phone, code: '654321', installId, platform: 'android' },
  });
  assert(verify.status === 200, `login ${phone}: ${JSON.stringify(verify.json)}`);
  return verify.json;
}

async function cancelActive(base, token, kidToken) {
  const active = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', { token });
  const id = active.json.trip?.id;
  if (!id) return;
  const cancelled = await api(base, 'PATCH', `/trips/${id}`, {
    token: kidToken,
    body: { action: 'cancel' },
  });
  assert(cancelled.status === 200, `cancel ${id}: ${JSON.stringify(cancelled.json)}`);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

async function run() {
  assert(!process.env.DATABASE_URL, 'el proceso de test no debe heredar DATABASE_URL');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-retry-'));
  const dbPath = path.join(tmp, 'llegue.db');
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LLEGUE_DB_PATH: dbPath,
      LLEGUE_TEST: '1',
      NODE_ENV: 'development',
      SEED_FAMILIA: 'true',
      OTP_DEV_CODE: '654321',
      JWT_SECRET: 'test-retry-secret',
      JWT_REFRESH_SECRET: 'test-retry-refresh',
      DATABASE_URL: 'postgresql://llegue:llegue@127.0.0.1:1/llegue',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitHealth(base);
    assert(health.dialect === 'sqlite', `dialect ${health.dialect}`);
    assert(health.postgres === false, 'no es postgres');

    const adult = await login(base, '5491100000001', 'test-install-adult-retry01');
    const kid = await login(base, '5491100000002', 'test-install-kid-retry01');
    const adultTok = adult.accessToken;
    const kidTok = kid.accessToken;
    const kidDeviceId = kid.deviceId;
    assert(kidDeviceId, 'login del menor devuelve deviceId');

    const club = await api(base, 'POST', '/places', {
      token: adultTok,
      body: { name: 'Club ucraniano', lat: -27.2, lng: -55.8, type: 'favorite', radiusM: 80 },
    });
    assert(club.status === 201, `club: ${JSON.stringify(club.json)}`);
    const clubId = club.json.place.id;

    const beforeAdultNotes = await api(base, 'GET', '/notifications/me', { token: adultTok });
    const beforeIds = new Set((beforeAdultNotes.json.notifications || []).map((n) => n.id));

    // Reintento: la misma clave devuelve el mismo viaje, aunque siga abierto.
    const key = 'retry-colegio-001';
    const first = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': key },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio' },
    });
    assert(first.status === 201, `crear: ${JSON.stringify(first.json)}`);
    assert(first.json.event == null, 'el adulto no avisa al armar la salida');
    assert(first.json.trip.phase === 'pending_departure', 'sigue pending al crear');
    const tripId = first.json.trip.id;
    const again = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': key },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio' },
    });
    assert(again.status === 200, `reintento: ${again.status} ${JSON.stringify(again.json)}`);
    assert(again.json.idempotentReplay === true, 'marca de reintento');
    assert(again.json.trip.id === tripId, 'mismo id');
    assert(again.json.event == null, 'el reintento tampoco avisa');
    assert(countTrips(dbPath, 'seed-kid-mateo') === 1, `viajes: ${countTrips(dbPath, 'seed-kid-mateo')}`);

    const afterAdultNotes = await api(base, 'GET', '/notifications/me', { token: adultTok });
    const createdNotes = (afterAdultNotes.json.notifications || []).filter((n) => !beforeIds.has(n.id));
    assert(createdNotes.length === 0, `el adulto no recibe aviso al crear: ${JSON.stringify(createdNotes)}`);

    const blocked = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': 'otra-clave' },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    assert(blocked.status === 409, `conflicto: ${blocked.status} ${JSON.stringify(blocked.json)}`);
    assert(blocked.json.code === 'trip_in_progress', `code: ${blocked.json.code}`);
    assert(
      String(blocked.json.error).toLowerCase().includes('salida en curso'),
      `texto: ${blocked.json.error}`,
    );
    assert(blocked.json.openTrip?.id === tripId, `openTrip: ${JSON.stringify(blocked.json.openTrip)}`);
    assert(blocked.json.openTrip?.destinationName === 'Colegio', 'resumen del destino');
    assert(blocked.json.openTrip?.status === 'active', 'resumen status');
    assert(countTrips(dbPath, 'seed-kid-mateo') === 1, 'el conflicto no crea otro viaje');

    const kidReplace = await api(base, 'POST', '/trips', {
      token: kidTok,
      body: { destinationPlaceId: clubId, replaceOpen: true },
    });
    assert(kidReplace.status === 403, `menor no reemplaza: ${JSON.stringify(kidReplace.json)}`);
    assert(kidReplace.json.code === 'replace_forbidden', kidReplace.json.code);
    assert(kidReplace.json.openTrip?.id === tripId, 'sigue mostrando la abierta');

    const replaced = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': 'reemplazo-club' },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId, replaceOpen: true },
    });
    assert(replaced.status === 201, `reemplazo: ${JSON.stringify(replaced.json)}`);
    assert(replaced.json.event == null, 'reemplazar tampoco avisa al adulto');
    assert(replaced.json.trip.id !== tripId, 'viaje nuevo');
    assert(replaced.json.trip.destinationName === 'Club ucraniano', 'destino nuevo');
    assert(tripRow(dbPath, tripId).status === 'cancelled', 'la anterior quedó cancelada');
    const replacedReplay = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': 'reemplazo-club' },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId, replaceOpen: true },
    });
    assert(replacedReplay.status === 200 && replacedReplay.json.trip.id === replaced.json.trip.id, 'reintento del reemplazo');
    assert(
      countTrips(dbPath, 'seed-kid-mateo') === 2,
      `no duplica el reemplazo: ${countTrips(dbPath, 'seed-kid-mateo')}`,
    );

    const mismatch = await api(base, 'POST', '/trips', {
      token: adultTok,
      headers: { 'Idempotency-Key': 'reemplazo-club' },
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio', replaceOpen: true },
    });
    assert(mismatch.status === 409 && mismatch.json.code === 'idempotency_mismatch', JSON.stringify(mismatch.json));

    await cancelActive(base, adultTok, kidTok);

    const parallelKey = 'paralelo-001';
    const [p1, p2] = await Promise.all([
      api(base, 'POST', '/trips', {
        token: adultTok,
        headers: { 'Idempotency-Key': parallelKey },
        body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio' },
      }),
      api(base, 'POST', '/trips', {
        token: adultTok,
        headers: { 'Idempotency-Key': parallelKey },
        body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio' },
      }),
    ]);
    assert(p1.json.trip?.id && p1.json.trip.id === p2.json.trip?.id, `paralelo: ${p1.json.trip?.id} vs ${p2.json.trip?.id}`);
    const parallelRows = withDb(dbPath, (raw) =>
      raw.prepare('SELECT COUNT(*) AS n FROM trips WHERE id = ?').get(p1.json.trip.id),
    );
    assert(parallelRows.n === 1, 'un solo registro para la clave paralela');
    await cancelActive(base, adultTok, kidTok);

    // Salida de ayer, sin eventos: no puede trabar la de hoy.
    const stale = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    assert(stale.status === 201, `stale create: ${JSON.stringify(stale.json)}`);
    const staleId = stale.json.trip.id;
    const old = hoursAgo(13);
    withDb(dbPath, (raw) => {
      raw.prepare(
        `UPDATE trips SET started_at = ?, created_at = ?, departed_at = NULL WHERE id = ?`,
      ).run(old, old, staleId);
      raw.prepare(`UPDATE events SET created_at = ? WHERE trip_id = ?`).run(old, staleId);
    });
    const afterStale = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    assert(afterStale.status === 201, `después de vencer: ${afterStale.status} ${JSON.stringify(afterStale.json)}`);
    assert(afterStale.json.trip.id !== staleId, 'viaje nuevo');
    assert(tripRow(dbPath, staleId).status === 'expired', `vieja: ${tripRow(dbPath, staleId).status}`);
    const activeNow = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', { token: adultTok });
    assert(activeNow.json.trip?.id === afterStale.json.trip.id, 'la activa es la nueva');
    await cancelActive(base, adultTok, kidTok);

    // Ciclo y avisos que el adulto puede leer horas después.
    const cycle = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    assert(cycle.status === 201 && cycle.json.event == null, 'ciclo sin aviso al crear');
    const cycleId = cycle.json.trip.id;
    const leftHome = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'departure', placeId: 'seed-place-casa', tripId: cycleId, deviceId: 'device-viejo' },
    });
    assert(leftHome.status === 201, `salida: ${JSON.stringify(leftHome.json)}`);
    assert(leftHome.json.ignored !== true, 'la salida no se ignora');
    assert(leftHome.json.event?.type === 'departure', leftHome.json.event?.type);
    assert((leftHome.json.notifiedCount ?? 0) >= 1, `avisó salida: ${leftHome.json.notifiedCount}`);

    const arrivedClub = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'arrival', placeId: clubId, tripId: cycleId },
    });
    assert(arrivedClub.status === 201 && arrivedClub.json.ignored !== true, JSON.stringify(arrivedClub.json));
    assert(arrivedClub.json.event?.type === 'arrival', 'llegada');
    assert((arrivedClub.json.notifiedCount ?? 0) >= 1, 'avisó llegada');
    const stillAtClub = await api(base, 'GET', `/trips/active?kidId=seed-kid-mateo`, { token: adultTok });
    assert(stillAtClub.json.trip?.status === 'active', 'llegar al club no cierra');
    assert(stillAtClub.json.trip?.phase === 'at_destination', stillAtClub.json.trip?.phase);

    const leftClub = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'departure', placeId: clubId, tripId: cycleId },
    });
    assert(leftClub.json.event?.type === 'departure', 'sale del club');
    const returning = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', { token: adultTok });
    assert(returning.json.trip?.phase === 'returning', returning.json.trip?.phase);

    const backHome = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'arrival', placeId: 'seed-place-casa', tripId: cycleId },
    });
    assert(backHome.json.ignored !== true && backHome.json.event?.type === 'arrival', JSON.stringify(backHome.json));
    assert((backHome.json.notifiedCount ?? 0) >= 1, 'llegar a casa avisa');
    const closedCycle = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', { token: adultTok });
    assert(closedCycle.json.trip == null, 'volver a casa cierra');

    const polled = await api(base, 'GET', '/family/status', { token: adultTok });
    const mine = await api(base, 'GET', '/notifications/me', { token: adultTok });
    const bodies = [
      ...(polled.json.notifications || []).map((n) => `${n.eventType}:${n.body}`),
      ...(mine.json.notifications || []).map((n) => `${n.eventType}:${n.body}`),
    ].join(' | ');
    assert(bodies.includes('departure:') && /salió/i.test(bodies), `poll salida: ${bodies}`);
    assert(bodies.includes('arrival:') && /llegó/i.test(bodies), `poll llegada: ${bodies}`);

    const leaveNote = (mine.json.notifications || []).find((n) => n.eventType === 'departure');
    const arriveNote = (mine.json.notifications || []).find((n) => n.eventType === 'arrival' && /club/i.test(n.body || ''));
    assert(leaveNote && arriveNote, `ids de avisos: ${JSON.stringify(mine.json.notifications)}`);
    const eightH = hoursAgo(8);
    withDb(dbPath, (raw) => {
      raw.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(eightH, leaveNote.id);
      raw.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(eightH, arriveNote.id);
      raw.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(eightH, leaveNote.eventId);
      raw.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(eightH, arriveNote.eventId);
    });
    const still = await api(base, 'GET', '/family/status', { token: adultTok });
    const stillMine = await api(base, 'GET', '/notifications/me', { token: adultTok });
    const stillIds = new Set([
      ...(still.json.notifications || []).map((n) => n.id),
      ...(stillMine.json.notifications || []).map((n) => n.id),
    ]);
    assert(stillIds.has(leaveNote.id) && stillIds.has(arriveNote.id), 'siguen en el poll horas después');

    withDb(dbPath, (raw) => {
      const insert = raw.prepare(
        `INSERT INTO notifications
         (id, event_id, recipient_user_id, status, title, body, sent_at, created_at)
         VALUES (?, ?, 'seed-adult-enzo', 'sent', 'ruido', 'ruido', ?, ?)`,
      );
      const now = new Date().toISOString();
      for (let i = 0; i < 200; i += 1) {
        insert.run(`noise-${i}`, leaveNote.eventId, now, now);
      }
    });
    const since = encodeURIComponent(hoursAgo(10));
    const missed = await api(base, 'GET', `/notifications/me?since=${since}`, { token: adultTok });
    const missedStatus = await api(base, 'GET', `/family/status?notificationsSince=${since}`, {
      token: adultTok,
    });
    const missedIds = new Set([
      ...(missed.json.notifications || []).map((n) => n.id),
      ...(missedStatus.json.notifications || []).map((n) => n.id),
    ]);
    assert(missedIds.has(leaveNote.id) && missedIds.has(arriveNote.id), 'since trae los avisos tapados');

    // Cancelar mata los avisos de esa salida.
    const ghostTrip = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    const beforeGhost = countNotes(dbPath, 'seed-adult-enzo');
    await api(base, 'PATCH', `/trips/${ghostTrip.json.trip.id}`, {
      token: adultTok,
      body: { action: 'cancel' },
    });
    const ghost = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'arrival', placeId: clubId, tripId: ghostTrip.json.trip.id },
    });
    assert(ghost.status === 201 && ghost.json.ignored === true, `fantasma: ${JSON.stringify(ghost.json)}`);
    assert(ghost.json.event == null, 'no queda evento');
    const afterGhost = countNotes(dbPath, 'seed-adult-enzo');
    assert(afterGhost === beforeGhost, `avisos ${beforeGhost} → ${afterGhost}`);

    // Regreso a casa: avisa y cierra. El arrival anterior de Casa queda fuera de la ventana anti-duplicado.
    withDb(dbPath, (raw) => {
      raw.prepare(
        `UPDATE events SET created_at = ? WHERE kid_id = ? AND type = 'arrival' AND place_id = 'seed-place-casa'`,
      ).run(hoursAgo(1), 'seed-kid-mateo');
    });
    const goHome = await api(base, 'POST', '/trips', {
      token: kidTok,
      body: { destinationPlaceId: 'seed-place-casa', kind: 'walking_home' },
    });
    assert(goHome.status === 201, `regreso: ${JSON.stringify(goHome.json)}`);
    assert(goHome.json.event?.type === 'walking_home', 'aviso de regreso');
    assert(goHome.json.trip?.phase === 'en_route', goHome.json.trip?.phase);
    const gotHome = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'arrival', placeId: 'seed-place-casa', tripId: goHome.json.trip.id },
    });
    assert(gotHome.json.ignored !== true, `llegada regreso: ${JSON.stringify(gotHome.json)}`);
    assert(gotHome.json.event?.type === 'arrival', 'evento de llegada');
    assert((gotHome.json.notifiedCount ?? 0) >= 1, `avisó regreso: ${gotHome.json.notifiedCount}`);
    const closedHome = await api(base, 'GET', '/trips/active', { token: kidTok });
    assert(closedHome.json.trip == null, 'el regreso se cierra al llegar');

    // Celular migrado / re-vinculado: la sesión vieja sigue pudiendo avisar.
    const noAuth = await api(base, 'POST', '/events', {
      body: { type: 'departure', placeId: 'seed-place-colegio' },
    });
    assert(noAuth.status === 401, `sin sesión: ${noAuth.status} ${JSON.stringify(noAuth.json)}`);
    const badToken = await api(base, 'POST', '/events', {
      token: 'token-falso',
      body: { type: 'departure', placeId: 'seed-place-colegio' },
    });
    assert(badToken.status === 401, `token inválido: ${badToken.status} ${JSON.stringify(badToken.json)}`);

    const migrated = await api(base, 'POST', '/devices/register', {
      token: kidTok,
      body: { installId: 'test-install-kid-migrated-02', platform: 'android' },
    });
    assert(migrated.status === 201, `migrar: ${JSON.stringify(migrated.json)}`);
    const newDeviceId = migrated.json.device?.id;
    assert(newDeviceId && newDeviceId !== kidDeviceId, `device id ${kidDeviceId} → ${newDeviceId}`);

    const boundBlock = await api(base, 'POST', '/devices/register', {
      token: kidTok,
      body: { installId: 'test-install-adult-retry01', platform: 'android' },
    });
    assert(boundBlock.status === 409 && boundBlock.json.code === 'device_bound', JSON.stringify(boundBlock.json));

    const schoolOut = await api(base, 'POST', '/events', {
      token: kidTok,
      body: {
        type: 'departure',
        placeId: 'seed-place-colegio',
        deviceId: kidDeviceId,
      },
    });
    assert(schoolOut.status === 201, `evento tras migrar: ${schoolOut.status} ${JSON.stringify(schoolOut.json)}`);
    assert(schoolOut.json.ignored !== true, `no se ignora: ${JSON.stringify(schoolOut.json)}`);
    assert(schoolOut.json.event?.type === 'departure', schoolOut.json.event?.type);
    assert((schoolOut.json.notifiedCount ?? 0) >= 1, 'el adulto recibe la salida aunque el deviceId sea el viejo');
    const adultSaw = await api(base, 'GET', '/notifications/me?since=' + encodeURIComponent(hoursAgo(1)), {
      token: adultTok,
    });
    assert(
      (adultSaw.json.notifications || []).some(
        (n) => n.eventId === schoolOut.json.event.id && n.eventType === 'departure',
      ),
      `poll del adulto: ${JSON.stringify(adultSaw.json.notifications?.slice?.(0, 3))}`,
    );

    // El id viejo en el GPS no puede tirar 404 ni perder la transición.
    await cancelActive(base, adultTok, kidTok);
    const gpsTrip = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: clubId },
    });
    assert(gpsTrip.status === 201, `gps trip: ${JSON.stringify(gpsTrip.json)}`);
    const atHome = await api(base, 'PATCH', '/devices/me/location', {
      token: kidTok,
      body: { lat: -27.0433, lng: -55.2269, deviceId: newDeviceId },
    });
    assert(atHome.status === 200, `ping casa: ${JSON.stringify(atHome.json)}`);
    assert((atHome.json.events || []).length === 0, 'primer punto en casa no avisa');

    const migratedAgain = await api(base, 'POST', '/devices/register', {
      token: kidTok,
      body: { installId: 'test-install-kid-migrated-03', platform: 'android' },
    });
    assert(migratedAgain.status === 201, `segunda migración: ${JSON.stringify(migratedAgain.json)}`);
    const newestId = migratedAgain.json.device.id;
    withDb(dbPath, (raw) => {
      raw.prepare('UPDATE events SET created_at = ? WHERE kid_id = ?').run(hoursAgo(2), 'seed-kid-mateo');
    });
    const atClubPing = await api(base, 'PATCH', '/devices/me/location', {
      token: kidTok,
      body: { lat: -27.2, lng: -55.8, deviceId: kidDeviceId },
    });
    assert(atClubPing.status === 200, `ping club con id viejo: ${atClubPing.status} ${JSON.stringify(atClubPing.json)}`);
    assert(atClubPing.json.deviceId === newestId, `resolvió ${atClubPing.json.deviceId} no ${kidDeviceId}`);
    const gpsTypes = (atClubPing.json.events || []).map((e) => `${e.type}:${e.message}`);
    assert(
      gpsTypes.some((t) => t.startsWith('departure')),
      `salida tras migrar: ${gpsTypes}`,
    );
    assert(
      gpsTypes.some((t) => t.startsWith('arrival') && /club/i.test(t)),
      `llegada tras migrar: ${gpsTypes}`,
    );
    const gpsNotes = await api(base, 'GET', '/family/status', { token: adultTok });
    const gpsBlob = (gpsNotes.json.notifications || []).map((n) => `${n.eventType}:${n.body}`).join(' | ');
    assert(/departure:/.test(gpsBlob) && /club/i.test(gpsBlob), `avisos GPS: ${gpsBlob}`);

    console.log('ok: salida vencida, reintento, avisos y eventos con celular migrado');
  } catch (err) {
    console.error(stderr);
    throw err;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
