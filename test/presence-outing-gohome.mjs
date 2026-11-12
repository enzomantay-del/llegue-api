/**
 * EXIT Plaza ≠ en camino a Plaza; Regreso a casa notifica adultos.
 */
import './isolate-db.mjs';
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

async function waitHealth(base, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // boot
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('API sin /health');
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
  await api(base, 'POST', '/auth/request-otp', { body: { phone } });
  const verify = await api(base, 'POST', '/auth/verify-otp', {
    body: { phone, code: '654321', installId, platform: 'android' },
  });
  assert(verify.status === 200, `login ${phone}: ${JSON.stringify(verify.json)}`);
  return verify.json;
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-outing-'));
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
      JWT_SECRET: 'test-outing-secret',
      JWT_REFRESH_SECRET: 'test-outing-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealth(base);
    const adult = await login(base, '5491100000001', 'test-install-adult-outing');
    const kid = await login(base, '5491100000002', 'test-install-kid-outing');

    const home = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Casa', lat: -27.1, lng: -55.9, type: 'home', radiusM: 80 },
    });
    assert(home.status === 201, `home: ${JSON.stringify(home.json)}`);
    const homeId = home.json.place.id;

    const plaza = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Plaza', lat: -27.12, lng: -55.92, type: 'favorite', radiusM: 80 },
    });
    assert(plaza.status === 201, `plaza: ${JSON.stringify(plaza.json)}`);
    const plazaId = plaza.json.place.id;

    await api(base, 'PATCH', '/devices/me/permissions', {
      token: kid.accessToken,
      body: {
        locationPermission: 'always',
        notificationsPermission: 'granted',
        locationOk: true,
      },
    });

    // A) Casa → Plaza → EXIT Plaza sin especial: “Salió de Plaza”, no “En camino a Plaza”
    await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'departure', placeId: homeId, forceNotify: true },
    });
    await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'arrival', placeId: plazaId, forceNotify: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'departure', placeId: plazaId, forceNotify: true },
    });

    let status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    const mateo = (status.json.members || []).find((m) => m.role === 'kid');
    assert(mateo, 'kid');
    assert(
      String(mateo.presenceLabel).includes('Salió de Plaza'),
      `A presence: ${mateo.presenceLabel}`,
    );
    assert(
      !String(mateo.presenceLabel).includes('En camino a Plaza'),
      `A no sticky camino: ${mateo.presenceLabel}`,
    );
    assert(
      String(mateo.lastEvent?.message || '').includes('salió') &&
        String(mateo.lastEvent?.message || '').includes('Plaza'),
      `A lastEvent: ${mateo.lastEvent?.message}`,
    );

    // B) trip sin lugar → 400
    const noPlace = await api(base, 'POST', '/trips', {
      token: kid.accessToken,
      body: {},
    });
    assert(noPlace.status === 400, `B no place: ${noPlace.status} ${JSON.stringify(noPlace.json)}`);

    // Cancel open trip from departure so we can create walking_home
    const active = await api(base, 'GET', '/trips/active', { token: kid.accessToken });
    const tripId = active.json.trip?.id;
    if (tripId) {
      await api(base, 'PATCH', `/trips/${tripId}`, {
        token: kid.accessToken,
        body: { action: 'cancel' },
      });
    }

    // D) Regreso a casa → evento walking_home + notificación adulto
    const goHome = await api(base, 'POST', '/trips', {
      token: kid.accessToken,
      body: { destinationPlaceId: homeId, kind: 'walking_home' },
    });
    assert(goHome.status === 201, `D goHome: ${JSON.stringify(goHome.json)}`);
    assert(goHome.json.trip?.phase === 'en_route', `D phase: ${goHome.json.trip?.phase}`);
    assert(
      goHome.json.trip?.departedAt && goHome.json.trip.departedAt === goHome.json.trip.createdAt,
      `D departedAt: ${goHome.json.trip?.departedAt} created ${goHome.json.trip?.createdAt}`,
    );
    assert(goHome.json.event?.type === 'walking_home', `D event: ${JSON.stringify(goHome.json.event)}`);
    assert(
      String(goHome.json.event?.message || '').toLowerCase().includes('casa') ||
        String(goHome.json.event?.message || '').toLowerCase().includes('regres'),
      `D message: ${goHome.json.event?.message}`,
    );
    assert((goHome.json.notifiedCount ?? 0) >= 1, `D notified: ${goHome.json.notifiedCount}`);

    status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    const events = status.json.recentEvents || [];
    const wh = events.find((e) => e.type === 'walking_home');
    assert(wh, `D timeline walking_home: ${JSON.stringify(events.slice(0, 5))}`);

    const notes = status.json.notifications || [];
    const noteWh = notes.find(
      (n) =>
        String(n.body || '').toLowerCase().includes('casa') ||
        String(n.type || '') === 'walking_home' ||
        String(n.body || '').toLowerCase().includes('regres'),
    );
    assert(noteWh || (goHome.json.notifiedCount ?? 0) >= 1, 'D adult notification');

    status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    let mateoNow = (status.json.members || []).find((m) => m.role === 'kid');
    assert(
      String(mateoNow?.presenceLabel || '').includes('Casa'),
      `D en camino: ${mateoNow?.presenceLabel}`,
    );
    assert(mateoNow?.activeTrip?.status === 'active', 'D viaje abierto hacia Casa');
    assert(mateoNow?.activeTrip?.phase === 'en_route', `D card phase: ${mateoNow?.activeTrip?.phase}`);

    // E) Llegada a Casa cierra el regreso y avisa. La llegada a Plaza fue ANTES del viaje.
    const arrived = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'arrival', placeId: homeId, tripId: goHome.json.trip.id },
    });
    assert(arrived.status === 201, `E arrival: ${JSON.stringify(arrived.json)}`);
    assert(arrived.json.ignored !== true, `E no se ignora: ${JSON.stringify(arrived.json)}`);
    assert(arrived.json.deduped !== true, `E no es duplicado: ${JSON.stringify(arrived.json)}`);
    assert(arrived.json.event?.type === 'arrival', `E event: ${JSON.stringify(arrived.json.event)}`);
    assert(
      /lleg/i.test(String(arrived.json.event?.message || '')) &&
        /casa/i.test(String(arrived.json.event?.message || '')),
      `E message: ${arrived.json.event?.message}`,
    );
    assert((arrived.json.notifiedCount ?? 0) >= 1, `E notified: ${arrived.json.notifiedCount}`);

    const closed = await api(base, 'GET', '/trips/active', { token: kid.accessToken });
    assert(closed.json.trip == null, `E viaje cerrado: ${JSON.stringify(closed.json.trip)}`);

    status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    mateoNow = (status.json.members || []).find((m) => m.role === 'kid');
    assert(mateoNow?.presenceLabel === 'En Casa', `E card: ${mateoNow?.presenceLabel}`);
    assert(mateoNow?.activeTrip == null, 'E sin viaje en la tarjeta');
    assert(
      /lleg/i.test(String(mateoNow?.lastEvent?.message || '')),
      `E lastEvent: ${mateoNow?.lastEvent?.message}`,
    );
    const arrivalNote = (status.json.notifications || []).find((n) =>
      /lleg/i.test(String(n.body || '')),
    );
    assert(arrivalNote, `E aviso de llegada: ${JSON.stringify(status.json.notifications)}`);

    // F) Salió de la escuela → la app cancela la salida abierta → regreso ya en camino.
    const school = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Escuela', lat: -27.2, lng: -55.8, type: 'school', radiusM: 80 },
    });
    assert(school.status === 201, `F school: ${JSON.stringify(school.json)}`);
    const leftSchool = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'departure', placeId: school.json.place.id, forceNotify: true },
    });
    assert(leftSchool.json.event?.type === 'departure', `F exit: ${JSON.stringify(leftSchool.json)}`);
    const openAfterSchool = await api(base, 'GET', '/trips/active', { token: kid.accessToken });
    const schoolTripId = openAfterSchool.json.trip?.id;
    assert(schoolTripId, 'F la salida de la escuela abre un viaje');
    await api(base, 'PATCH', `/trips/${schoolTripId}`, {
      token: kid.accessToken,
      body: { action: 'cancel' },
    });
    const goHomeSchool = await api(base, 'POST', '/trips', {
      token: kid.accessToken,
      body: { destinationPlaceId: homeId, kind: 'walking_home' },
    });
    assert(goHomeSchool.status === 201, `F goHome: ${JSON.stringify(goHomeSchool.json)}`);
    assert(goHomeSchool.json.trip?.phase === 'en_route', `F phase: ${goHomeSchool.json.trip?.phase}`);
    assert(
      goHomeSchool.json.trip?.departedAt === goHomeSchool.json.trip?.createdAt,
      'F departedAt al crear',
    );
    assert(goHomeSchool.json.event?.type === 'walking_home', 'F avisa regreso');
    const arrivedFromSchool = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: {
        type: 'arrival',
        placeId: homeId,
        tripId: goHomeSchool.json.trip.id,
      },
    });
    assert(arrivedFromSchool.json.ignored !== true, `F llegada no se ignora: ${JSON.stringify(arrivedFromSchool.json)}`);
    assert(
      arrivedFromSchool.json.event?.type === 'arrival',
      `F arrival: ${JSON.stringify(arrivedFromSchool.json)}`,
    );
    const closedSchool = await api(base, 'GET', '/trips/active', { token: kid.accessToken });
    assert(closedSchool.json.trip == null, 'F llegada a Casa cierra el regreso');

    // G) Casa → Plaza armada por el adulto sigue pending y no avisa la llegada en Casa.
    const adultTrip = await api(base, 'POST', '/trips', {
      token: adult.accessToken,
      body: { kidId: kid.user.id, destinationPlaceId: plazaId },
    });
    assert(adultTrip.status === 201, `G adult trip: ${JSON.stringify(adultTrip.json)}`);
    assert(adultTrip.json.event == null, 'G el adulto no notifica al crear');
    assert(adultTrip.json.trip?.phase === 'pending_departure', `G phase: ${adultTrip.json.trip?.phase}`);
    assert(adultTrip.json.trip?.departedAt == null, 'G sin departedAt');
    const stillHome = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'arrival', placeId: homeId, tripId: adultTrip.json.trip.id },
    });
    assert(stillHome.json.ignored === true, `G llegada en casa se ignora: ${JSON.stringify(stillHome.json)}`);
    const stillOpen = await api(base, 'GET', `/trips/active?kidId=${kid.user.id}`, {
      token: adult.accessToken,
    });
    assert(stillOpen.json.trip?.id === adultTrip.json.trip.id, 'G la salida sigue abierta');
    assert(stillOpen.json.trip?.phase === 'pending_departure', 'G sigue pending');
    await api(base, 'PATCH', `/trips/${adultTrip.json.trip.id}`, {
      token: adult.accessToken,
      body: { action: 'cancel' },
    });

    console.log('OK presence-outing-gohome');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
