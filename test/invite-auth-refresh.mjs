/**
 * Adulto (cualquier adult/admin_adult) puede invitar.
 * Menor recibe 403 claro.
 * Sesión vencida → 401 (no el 403 confuso).
 * POST /auth/refresh renueva tokens.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const JWT_SECRET = 'test-invite-secret';
const JWT_REFRESH = 'test-invite-refresh';

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
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + expiresSec,
    iat: Math.floor(Date.now() / 1000),
  };
  const mid = b64url(JSON.stringify(body));
  const data = `${header}.${mid}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-invite-'));
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
      JWT_SECRET,
      JWT_REFRESH_SECRET: JWT_REFRESH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  try {
    await waitHealth(base);

    const adult = await login(base, '5493743483429', 'test-install-adult-invite01');
    const kid = await login(base, '5493743489328', 'test-install-kid-invite01');
    assert(adult.user?.role === 'admin_adult' || adult.user?.role === 'adult', 'adulto seed');
    assert(kid.user?.role === 'kid', 'menor seed');

    // 1) Adulto crea invitación hijo
    const invKid = await api(base, 'POST', '/invitations', {
      token: adult.accessToken,
      body: { name: 'Lucía', role: 'kid' },
    });
    assert(invKid.status === 201, `adulto invita hijo: ${JSON.stringify(invKid.json)}`);
    assert(invKid.json.invitation?.role === 'kid', 'rol kid en invitación');

    // 2) Adulto invita a otro adulto
    const invAdult = await api(base, 'POST', '/invitations', {
      token: adult.accessToken,
      body: { name: 'Mamá', role: 'adult' },
    });
    assert(invAdult.status === 201, `adulto invita adulto: ${JSON.stringify(invAdult.json)}`);

    // 3) Menor no puede invitar
    const kidInvite = await api(base, 'POST', '/invitations', {
      token: kid.accessToken,
      body: { name: 'Alguien', role: 'adult' },
    });
    assert(kidInvite.status === 403, `menor 403: ${JSON.stringify(kidInvite.json)}`);
    assert(
      String(kidInvite.json.error || '').toLowerCase().includes('adulto'),
      'mensaje menor menciona adulto',
    );

    // 4) Sin token → 401 (no 403 confuso)
    const noAuth = await api(base, 'POST', '/invitations', {
      body: { name: 'X', role: 'kid' },
    });
    assert(noAuth.status === 401, `sin auth 401: ${JSON.stringify(noAuth.json)}`);

    // 5) Access JWT vencido → 401
    const expired = signJwt(
      { sub: adult.user.id, role: adult.user.role, familyId: adult.user.familyId },
      JWT_SECRET,
      -10,
    );
    const expiredInvite = await api(base, 'POST', '/invitations', {
      token: expired,
      body: { name: 'Y', role: 'kid' },
    });
    assert(expiredInvite.status === 401, `expirado 401: ${JSON.stringify(expiredInvite.json)}`);

    // 6) Refresh renueva y permite invitar de nuevo
    const refreshed = await api(base, 'POST', '/auth/refresh', {
      body: { refreshToken: adult.refreshToken },
    });
    assert(refreshed.status === 200, `refresh: ${JSON.stringify(refreshed.json)}`);
    assert(refreshed.json.accessToken, 'nuevo access');
    assert(refreshed.json.refreshToken, 'nuevo refresh');
    assert(refreshed.json.user?.id === adult.user.id, 'mismo usuario');

    const afterRefresh = await api(base, 'POST', '/invitations', {
      token: refreshed.json.accessToken,
      body: { name: 'PostRefresh', role: 'kid' },
    });
    assert(afterRefresh.status === 201, `invitar post-refresh: ${JSON.stringify(afterRefresh.json)}`);

    // Refresh viejo ya no sirve (rotación)
    const reuse = await api(base, 'POST', '/auth/refresh', {
      body: { refreshToken: adult.refreshToken },
    });
    assert(reuse.status === 401, `refresh rotado: ${JSON.stringify(reuse.json)}`);

    console.log('OK invite-auth-refresh');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (stderr && !stderr.includes('OK')) {
      // dejar rastro solo si falló algo raro
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
