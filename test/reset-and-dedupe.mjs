/**
 * Reset pide confirmación, el doble aviso de geocerca no se duplica,
 * y después del reset /health dice users: 0.
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

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env, RESET_IGNORE_DOTENV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      err += c.toString();
    });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

async function waitHealth(base) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok || res.status === 503) return res;
    } catch {
      // boot
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('sin /health');
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

async function login(base, phone, installId, extra = {}) {
  const otp = await api(base, 'POST', '/auth/request-otp', { body: { phone } });
  assert(otp.status === 200, `otp ${JSON.stringify(otp.json)}`);
  return api(base, 'POST', '/auth/verify-otp', {
    body: { phone, code: '123456', installId, platform: 'android', ...extra },
  });
}

function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      RESET_IGNORE_DOTENV: '1',
      DATABASE_URL: '',
      PORT: String(port),
      LLEGUE_DB_PATH: dbPath,
      SEED_FAMILIA: 'false',
      OTP_DEV_CODE: '123456',
      JWT_SECRET: 'reset-test-secret',
      JWT_REFRESH_SECRET: 'reset-test-refresh',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function stop(child) {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-reset-'));
  const dbPath = path.join(tmp, 'llegue.db');
  const baseEnv = {
    RESET_IGNORE_DOTENV: '1',
    DATABASE_URL: '',
    LLEGUE_DB_PATH: dbPath,
    NODE_ENV: 'development',
    JWT_SECRET: 'reset-test-secret',
    JWT_REFRESH_SECRET: 'reset-test-refresh',
  };

  const refused = await runNode(['--experimental-sqlite', 'src/reset-db.mjs'], baseEnv);
  assert(refused.code === 1, `sin BORRAR debía fallar: ${refused.err}`);
  assert(refused.err.includes('BORRAR'), refused.err);

  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startServer(dbPath, port);
  try {
    await waitHealth(base);
    const adult = await login(base, '5493000000001', 'install-reset-adult', { name: 'Soraya' });
    assert(adult.status === 200, JSON.stringify(adult.json));
    const family = await api(base, 'POST', '/families', {
      token: adult.json.accessToken,
      body: {
        name: 'Casa',
        relationshipLabel: 'Mamá',
        displayName: 'Soraya',
        installId: 'install-reset-adult',
      },
    });
    assert(family.status === 201, JSON.stringify(family.json));
    const token = family.json.accessToken || adult.json.accessToken;
    const place = await api(base, 'POST', '/places', {
      token,
      body: { name: 'Casa', type: 'home', lat: -27.04, lng: -55.22, radiusM: 60 },
    });
    assert(place.status === 201, JSON.stringify(place.json));
    const inv = await api(base, 'POST', '/invitations', {
      token,
      body: { name: 'Mateo', role: 'kid' },
    });
    assert(inv.status === 201, JSON.stringify(inv.json));
    const kid = await login(base, '5493000000002', 'install-reset-kid', { name: 'Mateo' });
    assert(kid.status === 200, JSON.stringify(kid.json));
    const accepted = await api(
      base,
      'POST',
      `/invitations/${inv.json.invitation.deepLinkToken}/accept`,
      { token: kid.json.accessToken, body: { installId: 'install-reset-kid' } },
    );
    assert(accepted.status === 200, JSON.stringify(accepted.json));
    const placeId = place.json.place?.id || place.json.id;
    const first = await api(base, 'POST', '/events', {
      token: accepted.json.accessToken || kid.json.accessToken,
      body: { type: 'arrival', placeId },
    });
    assert(first.status === 201 || first.status === 200, JSON.stringify(first.json));
    const second = await api(base, 'POST', '/events', {
      token: accepted.json.accessToken || kid.json.accessToken,
      body: { type: 'arrival', placeId },
    });
    assert(second.status === 200 || second.status === 201, JSON.stringify(second.json));
    assert(second.json.deduped === true, `dedupe: ${JSON.stringify(second.json)}`);
    assert(second.json.event?.id === first.json.event?.id, 'mismo aviso');
  } finally {
    await stop(child);
  }

  const wiped = await runNode(['--experimental-sqlite', 'src/reset-db.mjs', 'BORRAR'], baseEnv);
  assert(wiped.code === 0, `${wiped.err}\n${wiped.out}`);
  assert(wiped.out.includes('users ahora: 0'), wiped.out);

  const port2 = await getFreePort();
  const base2 = `http://127.0.0.1:${port2}`;
  const child2 = startServer(dbPath, port2);
  try {
    const healthRes = await waitHealth(base2);
    const health = await healthRes.json();
    assert(health.users === 0, `health users: ${JSON.stringify(health)}`);
    assert(health.ok === true, JSON.stringify(health));
  } finally {
    await stop(child2);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  console.log('ok: reset pide BORRAR, dedupe de llegada, users 0');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
