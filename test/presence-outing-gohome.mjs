/**
 * EXIT Plaza ≠ en camino a Plaza; Regreso a casa notifica adultos.
 */
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
    body: { phone, code: '123456', installId, platform: 'android' },
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
      SEED_FAMILIA: 'true',
      OTP_DEV_CODE: '123456',
      JWT_SECRET: 'test-outing-secret',
      JWT_REFRESH_SECRET: 'test-outing-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealth(base);
    const adult = await login(base, '5493743483429', 'test-install-adult-outing');
    const kid = await login(base, '5493743489328', 'test-install-kid-outing');

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
