/**
 * Verifica cancelación de salida especial, creador persistido
 * y payload kid_stopped_sharing. Levanta la API en un puerto libre.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFcmData } from '../src/push.mjs';

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
      if (res.ok) return;
    } catch {
      // todavía arrancando
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('La API no respondió /health');
}

async function api(base, method, pathname, { token, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(base, phone, installId) {
  const reqOtp = await api(base, 'POST', '/auth/request-otp', { body: { phone } });
  assert(reqOtp.status === 200, `OTP ${phone}: ${JSON.stringify(reqOtp.json)}`);
  const verify = await api(base, 'POST', '/auth/verify-otp', {
    body: { phone, code: '123456', installId, platform: 'android' },
  });
  assert(verify.status === 200, `login ${phone}: ${JSON.stringify(verify.json)}`);
  return verify.json;
}

async function run() {
  const fcm = buildFcmData({
    title: 'Ubicación cortada',
    body: 'Mateo dejó de compartir ubicación',
    urgent: true,
    data: {
      type: 'kid_stopped_sharing',
      kidId: 'seed-kid-mateo',
      phone: '5493743489328',
      eventType: 'location_lost',
    },
  });
  assert(fcm.type === 'kid_stopped_sharing', 'FCM type');
  assert(fcm.kidId === 'seed-kid-mateo', 'FCM kidId');
  assert(fcm.phone === '5493743489328', 'FCM phone');
  assert(fcm.eventType === 'location_lost', 'FCM eventType');
  assert(fcm.urgent === 'true', 'FCM urgent string');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-cancel-'));
  const dbPath = path.join(tmp, 'llegue.db');
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LLEGUE_DB_PATH: dbPath,
      DATABASE_URL: '',
      NODE_ENV: 'development',
      SEED_FAMILIA: 'true',
      OTP_DEV_CODE: '123456',
      JWT_SECRET: 'test-cancel-secret',
      JWT_REFRESH_SECRET: 'test-cancel-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  try {
    await waitHealth(base);
    const adult = await login(base, '5493743483429', 'test-install-adult-cancel01');
    const kid = await login(base, '5493743489328', 'test-install-kid-cancel01');
    const adultTok = adult.accessToken;
    const kidTok = kid.accessToken;

    const jorge = await api(base, 'POST', '/places', {
      token: adultTok,
      body: {
        name: 'Casa de Jorge',
        lat: -27.05,
        lng: -55.24,
        type: 'favorite',
        radiusM: 60,
      },
    });
    assert(jorge.status === 201, `crear Jorge: ${JSON.stringify(jorge.json)}`);
    const jorgeId = jorge.json.place.id;

    const created = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: jorgeId },
    });
    assert(created.status === 201, `crear trip: ${JSON.stringify(created.json)}`);
    const trip = created.json.trip;
    assert(trip.status === 'active', 'trip active al crear');
    assert(trip.phase === 'pending_departure', 'fase inicial');
    assert(trip.createdByUserId === 'seed-adult-enzo', 'createdByUserId adulto');
    assert(String(trip.createdByName).includes('Enzo'), `createdByName: ${trip.createdByName}`);

    const cancelled = await api(base, 'PATCH', `/trips/${trip.id}`, {
      token: kidTok,
      body: { action: 'cancel' },
    });
    assert(cancelled.status === 200, `cancel: ${JSON.stringify(cancelled.json)}`);
    assert(cancelled.json.trip.status === 'cancelled', 'status cancelled');
    assert(cancelled.json.trip.phase == null, `phase debe ser null, fue ${cancelled.json.trip.phase}`);
    assert(cancelled.json.trip.endedAt, 'endedAt');

    const active = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', {
      token: adultTok,
    });
    assert(active.status === 200, 'trips/active');
    assert(active.json.trip == null, 'no debe haber viaje activo');

    const status = await api(base, 'GET', '/family/status', { token: adultTok });
    const mateo = status.json.members.find((m) => m.id === 'seed-kid-mateo');
    assert(mateo?.activeTrip == null, 'family/status sin viaje activo');
    const placeNames = (status.json.places || []).map((p) => p.name);
    assert(!placeNames.includes('Casa de Jorge'), `Jorge no debe seguir en places: ${placeNames}`);

    const beforeEvents = await api(base, 'GET', '/events?kidId=seed-kid-mateo', {
      token: adultTok,
    });
    const beforeCount = (beforeEvents.json.events || []).length;

    const ghostArrival = await api(base, 'POST', '/events', {
      token: kidTok,
      body: {
        type: 'arrival',
        placeId: jorgeId,
        tripId: trip.id,
      },
    });
    assert(ghostArrival.status === 201, `arrival cancelado: ${JSON.stringify(ghostArrival.json)}`);
    assert(ghostArrival.json.ignored === true, 'arrival ligado al trip cancelado se ignora');
    assert(ghostArrival.json.event == null, 'sin evento de llegada');

    const ghostByName = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'departure', placeName: 'Casa de Jorge', tripId: trip.id },
    });
    assert(ghostByName.json.ignored === true, 'departure por nombre a Jorge cancelado se ignora');

    const implied = await api(base, 'POST', '/events', {
      token: kidTok,
      body: { type: 'arrival', tripId: trip.id },
    });
    assert(implied.json.ignored === true, 'arrival sin placeId del trip cancelado se ignora');

    const afterEvents = await api(base, 'GET', '/events?kidId=seed-kid-mateo', {
      token: adultTok,
    });
    const afterCount = (afterEvents.json.events || []).length;
    assert(afterCount === beforeCount, `no deben nacer avisos: ${beforeCount} → ${afterCount}`);

    const schoolTrip = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: 'seed-place-colegio' },
    });
    assert(schoolTrip.status === 201, `trip colegio: ${JSON.stringify(schoolTrip.json)}`);
    const schoolCancel = await api(base, 'PATCH', `/trips/${schoolTrip.json.trip.id}`, {
      token: kidTok,
      body: { action: 'cancel' },
    });
    assert(schoolCancel.json.trip.status === 'cancelled', 'colegio cancelado');
    const places = await api(base, 'GET', '/places', { token: adultTok });
    const colegio = places.json.places.find((p) => p.id === 'seed-place-colegio');
    assert(colegio?.status === 'active', 'colegio permanente sigue activo');

    const kidTrip = await api(base, 'POST', '/trips', {
      token: kidTok,
      body: { destinationPlaceId: 'seed-place-colegio' },
    });
    assert(kidTrip.status === 201, `trip del hijo: ${JSON.stringify(kidTrip.json)}`);
    assert(kidTrip.json.trip.createdByUserId === 'seed-kid-mateo', 'creador hijo id');
    assert(kidTrip.json.trip.createdByName === 'Mateo', 'creador hijo nombre');
    await api(base, 'PATCH', `/trips/${kidTrip.json.trip.id}`, {
      token: kidTok,
      body: { action: 'cancel' },
    });

    const cyclePlace = await api(base, 'POST', '/places', {
      token: adultTok,
      body: { name: 'Modista', lat: -27.06, lng: -55.25, type: 'favorite', radiusM: 60 },
    });
    const cycleTrip = await api(base, 'POST', '/trips', {
      token: adultTok,
      body: { kidId: 'seed-kid-mateo', destinationPlaceId: cyclePlace.json.place.id },
    });
    const depHome = await api(base, 'POST', '/events', {
      token: kidTok,
      body: {
        type: 'departure',
        placeId: 'seed-place-casa',
        tripId: cycleTrip.json.trip.id,
      },
    });
    assert(depHome.json.event?.type === 'departure', 'EXIT Casa avisa');
    const arrDest = await api(base, 'POST', '/events', {
      token: kidTok,
      body: {
        type: 'arrival',
        placeId: cyclePlace.json.place.id,
        tripId: cycleTrip.json.trip.id,
      },
    });
    assert(arrDest.json.event?.type === 'arrival', 'ENTER destino avisa');
    const live = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', {
      token: adultTok,
    });
    assert(live.json.trip?.status === 'active', 'especial sigue activa en destino');
    assert(live.json.trip?.phase === 'at_destination', `fase destino: ${live.json.trip?.phase}`);
    const arrHome = await api(base, 'POST', '/events', {
      token: kidTok,
      body: {
        type: 'arrival',
        placeId: 'seed-place-casa',
        tripId: cycleTrip.json.trip.id,
      },
    });
    assert(arrHome.json.event?.type === 'arrival', 'ENTER Casa avisa');
    const done = await api(base, 'GET', '/trips/active?kidId=seed-kid-mateo', {
      token: adultTok,
    });
    assert(done.json.trip == null, 'especial se cierra al volver a casa');

    const closed = await api(base, 'PATCH', '/devices/me/presence', {
      token: kidTok,
      body: { state: 'background', immediate: true, deviceId: kid.deviceId },
    });
    assert(closed.status === 200, `presence: ${JSON.stringify(closed.json)}`);
    const closedEvent = closed.json.event;
    assert(closedEvent?.type === 'app_closed', 'evento app_closed');
    assert(closedEvent?.payload?.type === 'kid_stopped_sharing', 'payload type');
    assert(closedEvent?.payload?.kidId === 'seed-kid-mateo', 'payload kidId');
    assert(closedEvent?.payload?.phone === '5493743489328', 'payload phone');

    console.log('ok: cancel, creador, kid_stopped_sharing, ciclo Casa→destino→Casa');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (stderr.includes('Error')) {
      console.error(stderr);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
