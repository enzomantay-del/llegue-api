/**
 * / y /probar no publican el código de verificación, aunque OTP_DEV_CODE esté definido.
 * Con esa variable el login sigue funcionando.
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
const OTP = '91827364';

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
      // arrancando
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('La API no respondió /health');
}

async function page(base, pathname) {
  const res = await fetch(`${base}${pathname}`);
  const text = await res.text();
  return { status: res.status, text };
}

async function api(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function assertHidesOtp(label, text) {
  assert(!text.includes(OTP), `${label} publica el código: ${OTP}`);
  assert(!text.includes('OTP_DEV_CODE'), `${label} nombra OTP_DEV_CODE`);
  assert(!text.includes('123456'), `${label} muestra 123456`);
  assert(
    /código que te (pasaron|dieron)/i.test(text),
    `${label} no explica que el código se recibe aparte`,
  );
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-trial-'));
  const dbPath = path.join(tmp, 'llegue.db');
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      LLEGUE_TEST: '1',
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/no-es-neon',
      NODE_ENV: 'development',
      PORT: String(port),
      LLEGUE_DB_PATH: dbPath,
      SEED_FAMILIA: 'false',
      OTP_DEV_CODE: OTP,
      OTP_EXPOSE_DEV_CODE: 'false',
      JWT_SECRET: 'trial-page-secret',
      JWT_REFRESH_SECRET: 'trial-page-refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitHealth(base);
    const home = await page(base, '/');
    const probar = await page(base, '/probar');
    assert(home.status === 200, `/: ${home.status}`);
    assert(probar.status === 200, `/probar: ${probar.status}`);
    assertHidesOtp('/', home.text);
    assertHidesOtp('/probar', probar.text);

    const phone = '5491100000099';
    const otp = await api(base, '/auth/request-otp', { phone });
    assert(otp.status === 200, `request-otp: ${JSON.stringify(otp.json)}`);
    assert(!JSON.stringify(otp.json).includes(OTP), 'el pedido de código no devuelve el valor');
    const verify = await api(base, '/auth/verify-otp', {
      phone,
      code: OTP,
      installId: 'trial-page-install',
      platform: 'android',
      name: 'Prueba',
    });
    assert(verify.status === 200, `login con el código del entorno: ${JSON.stringify(verify.json)}`);

    console.log('ok: / y /probar no muestran el código; el login sigue andando');
  } catch (err) {
    console.error(stderr);
    throw err;
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
