/**
 * Presencia coherente, vuelta a Casa, location_lost solo por permiso/GPS.
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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-presence-'));
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
      JWT_SECRET: 'test-presence-secret',
      JWT_REFRESH_SECRET: 'test-presence-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealth(base);
    const adult = await login(base, '5493743483429', 'test-install-adult-presence');
    const kid = await login(base, '5493743489328', 'test-install-kid-presence');

    const home = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Casa', lat: -27.1, lng: -55.9, type: 'home', radiusM: 80 },
    });
    assert(home.status === 201, `home: ${JSON.stringify(home.json)}`);
    const homeId = home.json.place.id;

    const plaza = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Plazoleta', lat: -27.12, lng: -55.92, type: 'favorite', radiusM: 80 },
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

    await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'departure', placeId: homeId, forceNotify: true },
    });
    // Evitar dedup 90s entre arrivals distintos no aplica; sí entre mismo lugar.
    const arrPlaza = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'arrival', placeId: plazaId, forceNotify: true },
    });
    assert(arrPlaza.status === 200 || arrPlaza.status === 201, `plaza arr: ${JSON.stringify(arrPlaza.json)}`);
    assert(!arrPlaza.json.ignored, 'plaza no ignored');

    let status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    assert(status.status === 200, 'status');
    const mateo = (status.json.members || []).find((m) => m.role === 'kid');
    assert(mateo, 'kid');
    assert(
      String(mateo.presenceLabel).includes('Plazoleta'),
      `presence plaza: ${mateo.presenceLabel}`,
    );
    assert(
      String(mateo.lastEvent?.message || '').includes('Plazoleta'),
      `lastEvent plaza: ${mateo.lastEvent?.message}`,
    );
    assert(
      !String(mateo.presenceLabel).includes('Casa') ||
        String(mateo.presenceLabel).includes('Plazoleta'),
      `no contradicción Casa vs Plazoleta: ${mateo.presenceLabel} / ${mateo.lastEvent?.message}`,
    );

    const arrHome = await api(base, 'POST', '/events', {
      token: kid.accessToken,
      body: { type: 'arrival', placeId: homeId, forceNotify: true },
    });
    assert(!arrHome.json.ignored, `home arrival ignored: ${JSON.stringify(arrHome.json)}`);
    assert(arrHome.json.event || arrHome.json.deduped, `home arr: ${JSON.stringify(arrHome.json)}`);

    status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    const mateo2 = (status.json.members || []).find((m) => m.role === 'kid');
    assert(
      String(mateo2.presenceLabel).includes('Casa'),
      `presence home: ${mateo2.presenceLabel}`,
    );
    assert(
      String(mateo2.lastEvent?.message || '').toLowerCase().includes('casa'),
      `lastEvent home: ${mateo2.lastEvent?.message}`,
    );

    // Permiso degradado → sí “dejó de compartir”
    await api(base, 'PATCH', '/devices/me/permissions', {
      token: kid.accessToken,
      body: {
        locationPermission: 'while_in_use',
        notificationsPermission: 'granted',
        locationOk: true,
      },
    });
    status = await api(base, 'GET', '/family/status', { token: adult.accessToken });
    const mateo3 = (status.json.members || []).find((m) => m.role === 'kid');
    assert(
      String(mateo3.presenceLabel).includes('Dejó de compartir') ||
        String(mateo3.healthIssue || '').includes('Dejó de compartir'),
      `stop-sharing: ${mateo3.presenceLabel} / ${mateo3.healthIssue}`,
    );

    console.log('OK presence-home-sharing');
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
