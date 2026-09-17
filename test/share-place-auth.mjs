/**
 * location_lost solo si el menor YA compartía y después corta.
 * POST /places: 401 si no hay sesión (no “sin familia”).
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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-share-'));
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
      JWT_SECRET: 'test-share-secret',
      JWT_REFRESH_SECRET: 'test-share-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealth(base);
    const adult = await login(base, '5493743483429', 'test-install-adult-share01');
    const kid = await login(base, '5493743489328', 'test-install-kid-share01');

    const noAuth = await api(base, 'POST', '/places', {
      body: { name: 'Plaza', lat: -27.04, lng: -55.22, type: 'favorite' },
    });
    assert(noAuth.status === 401, `places sin auth 401: ${JSON.stringify(noAuth.json)}`);
    assert(
      !String(noAuth.json.error || '').toLowerCase().includes('familia'),
      '401 no debe decir sin familia',
    );

    const place = await api(base, 'POST', '/places', {
      token: adult.accessToken,
      body: { name: 'Plaza Test', lat: -27.04, lng: -55.22, type: 'favorite', radiusM: 80 },
    });
    assert(place.status === 201, `crear lugar: ${JSON.stringify(place.json)}`);

    const patchPartial = await api(base, 'PATCH', '/devices/me/permissions', {
      token: kid.accessToken,
      body: {
        locationPermission: 'whileInUse',
        notificationsPermission: 'denied',
        locationOk: true,
      },
    });
    assert(patchPartial.status === 200, `perm parcial: ${JSON.stringify(patchPartial.json)}`);

    await new Promise((r) => setTimeout(r, 250));
    const events1 = await api(base, 'GET', '/events', { token: adult.accessToken });
    assert(events1.status === 200, `events: ${JSON.stringify(events1.json)}`);
    const list1 = events1.json.events || [];
    const lost1 = list1.filter((e) => e.type === 'location_lost');
    assert(lost1.length === 0, `no location_lost en onboarding: ${JSON.stringify(lost1)}`);

    const patchOk = await api(base, 'PATCH', '/devices/me/permissions', {
      token: kid.accessToken,
      body: {
        locationPermission: 'always',
        notificationsPermission: 'granted',
        locationOk: true,
      },
    });
    assert(patchOk.status === 200, `perm full: ${JSON.stringify(patchOk.json)}`);

    const patchOff = await api(base, 'PATCH', '/devices/me/permissions', {
      token: kid.accessToken,
      body: {
        locationPermission: 'denied',
        notificationsPermission: 'granted',
        locationOk: false,
      },
    });
    assert(patchOff.status === 200, `perm off: ${JSON.stringify(patchOff.json)}`);

    const events2 = await api(base, 'GET', '/events', { token: adult.accessToken });
    const list2 = events2.json.events || [];
    const lost2 = list2.filter((e) => e.type === 'location_lost');
    assert(lost2.length >= 1, `sí location_lost al cortar: ${JSON.stringify(list2)}`);

    console.log('OK share-place-auth');
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
