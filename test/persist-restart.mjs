/**
 * Familia y sesión sobreviven un restart del server (misma DB).
 * Simula el caso de campo: cerrar la app varios días / sleep de Render
 * no debe borrar familia si el archivo/Postgres sigue.
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
      if (res.ok) {
        const json = await res.json();
        return json;
      }
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

function startServer({ port, dbPath, extraEnv = {} }) {
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
      JWT_SECRET: 'test-persist-secret',
      JWT_REFRESH_SECRET: 'test-persist-refresh',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  return { child, getStderr: () => stderr };
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
  }
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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-persist-'));
  const dbPath = path.join(tmp, 'llegue.db');
  try {
    let familyName = '';
    const port1 = await getFreePort();
    const base1 = `http://127.0.0.1:${port1}`;
    const first = startServer({ port: port1, dbPath });
    try {
      const health = await waitHealth(base1);
      assert(health.ok === true, 'health ok');
      assert(health.db?.dialect === 'sqlite', 'dialect sqlite en local');

      const adult = await login(base1, '5493743483429', 'test-install-adult-persist01');
      assert(adult.user?.familyId, `familyId al login: ${JSON.stringify(adult)}`);
      assert(adult.refreshToken, 'refresh token emitido');
      const me = await api(base1, 'GET', '/auth/me', { token: adult.accessToken });
      assert(me.status === 200, `/auth/me: ${JSON.stringify(me.json)}`);
      assert(me.json.family?.name, 'familia en /auth/me');
      familyName = me.json.family.name;
      const status = await api(base1, 'GET', '/family/status', { token: adult.accessToken });
      assert(status.status === 200, `status: ${JSON.stringify(status.json)}`);
      assert(status.json.family?.name === familyName, 'familia en /family/status');
      assert(
        (status.json.places || []).some((p) => p.type === 'home' || p.type === 'school'),
        'lugares seed siguen',
      );

      const refreshed = await api(base1, 'POST', '/auth/refresh', {
        body: { refreshToken: adult.refreshToken },
      });
      assert(refreshed.status === 200, `refresh: ${JSON.stringify(refreshed.json)}`);
      assert(refreshed.json.accessToken, 'nuevo access');
      assert(refreshed.json.user?.id === adult.user.id, 'mismo usuario tras refresh');
    } finally {
      await stopServer(first.child);
      if (first.getStderr().includes('Error')) {
        console.error(first.getStderr());
      }
    }

    const port2 = await getFreePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const second = startServer({ port: port2, dbPath });
    try {
      await waitHealth(base2);
      const adult2 = await login(base2, '5493743483429', 'test-install-adult-persist01');
      assert(adult2.user?.familyId, `familyId tras restart: ${JSON.stringify(adult2)}`);
      const me2 = await api(base2, 'GET', '/auth/me', { token: adult2.accessToken });
      assert(me2.json.family?.name === familyName, 'familia sigue tras restart');
      const status2 = await api(base2, 'GET', '/family/status', { token: adult2.accessToken });
      assert(status2.status === 200, `status2: ${JSON.stringify(status2.json)}`);
      assert(status2.json.members?.length >= 2, 'miembros siguen después del restart');
      assert(
        (status2.json.places || []).length >= 1,
        'lugares siguen después del restart',
      );
    } finally {
      await stopServer(second.child);
    }

    const prod = startServer({
      port: await getFreePort(),
      dbPath,
      extraEnv: { NODE_ENV: 'production', DATABASE_URL: '' },
    });
    const died = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 4000);
      prod.child.on('exit', (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert(died !== 'timeout' && died !== 0, `prod sin DATABASE_URL debe fallar, code=${died}`);
    const err = prod.getStderr();
    assert(/DATABASE_URL/i.test(err), `mensaje prod: ${err}`);

    console.log('ok: persistencia tras restart + refresh + prod exige Postgres');
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
