/**
 * Un celular se puede reasignar si la persona lo confirma.
 * Un número sigue siendo de una sola persona.
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
  const reqOtp = await api(base, 'POST', '/auth/request-otp', { body: { phone } });
  assert(reqOtp.status === 200, `OTP ${phone}: ${JSON.stringify(reqOtp.json)}`);
  const verify = await api(base, 'POST', '/auth/verify-otp', {
    body: { phone, code: '123456', installId, platform: 'android', ...extra },
  });
  return verify;
}

async function run() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'llegue-reassign-'));
  const dbPath = path.join(tmp, 'llegue.db');
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const phoneA = 'and-enzo-phone';
  const phoneB = 'and-esposa-phone';
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LLEGUE_DB_PATH: dbPath,
      SEED_FAMILIA: 'false',
      OTP_DEV_CODE: '123456',
      JWT_SECRET: 'reassign-test-secret',
      JWT_REFRESH_SECRET: 'reassign-test-refresh',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitHealth(base);

    const soraya = await login(base, '5491111111111', phoneA, { name: 'Soraya' });
    assert(soraya.status === 200, `login Soraya: ${JSON.stringify(soraya.json)}`);
    const family = await api(base, 'POST', '/families', {
      token: soraya.json.accessToken,
      body: {
        name: 'Casa',
        relationshipLabel: 'Mamá',
        displayName: 'Soraya',
        installId: phoneA,
      },
    });
    assert(family.status === 201, `familia: ${JSON.stringify(family.json)}`);

    const inv = await api(base, 'POST', '/invitations', {
      token: family.json.accessToken || soraya.json.accessToken,
      body: { name: 'Mateo', role: 'kid' },
    });
    assert(inv.status === 201, `invite: ${JSON.stringify(inv.json)}`);

    const mateoOtp = await login(base, '5492222222222', phoneB, { name: 'Mateo' });
    assert(mateoOtp.status === 200, `login Mateo: ${JSON.stringify(mateoOtp.json)}`);
    const accepted = await api(
      base,
      'POST',
      `/invitations/${inv.json.invitation.deepLinkToken}/accept`,
      {
        token: mateoOtp.json.accessToken,
        body: { installId: phoneB },
      },
    );
    assert(accepted.status === 200, `accept Mateo: ${JSON.stringify(accepted.json)}`);
    assert(accepted.json.user?.name === 'Mateo', 'nombre Mateo');
    assert(accepted.json.user?.role === 'kid', 'rol menor');

    const lookA = await api(base, 'GET', `/devices/lookup?installId=${phoneA}`);
    const lookB = await api(base, 'GET', `/devices/lookup?installId=${phoneB}`);
    assert(lookA.json.user?.name === 'Soraya', `A es Soraya: ${JSON.stringify(lookA.json)}`);
    assert(lookB.json.user?.name === 'Mateo', `B es Mateo: ${JSON.stringify(lookB.json)}`);

    const blocked = await login(base, '5492222222222', phoneA);
    assert(blocked.status === 409, `sin confirmar: ${JSON.stringify(blocked.json)}`);
    assert(blocked.json.code === 'device_bound', 'code device_bound');
    assert(blocked.json.boundUser?.name === 'Soraya', 'sigue Soraya');
    const stillA = await api(base, 'GET', `/devices/lookup?installId=${phoneA}`);
    assert(stillA.json.user?.name === 'Soraya', 'no reasignó sin confirmar');

    const nico = await api(base, 'POST', '/invitations', {
      token: family.json.accessToken || soraya.json.accessToken,
      body: { name: 'Nico', role: 'kid' },
    });
    assert(nico.status === 201, `invite Nico: ${JSON.stringify(nico.json)}`);
    const wrongNumber = await login(base, '5491111111111', phoneA, {
      inviteToken: nico.json.invitation.deepLinkToken,
    });
    assert(wrongNumber.status === 409, `número ajeno: ${JSON.stringify(wrongNumber.json)}`);
    assert(wrongNumber.json.code === 'phone_owner', 'code phone_owner');
    assert(
      String(wrongNumber.json.error).includes('Soraya') &&
        String(wrongNumber.json.error).includes('Nico'),
      `mensaje número: ${wrongNumber.json.error}`,
    );
    const stillSoraya = await api(base, 'GET', `/devices/lookup?installId=${phoneA}`);
    assert(stillSoraya.json.user?.name === 'Soraya', 'el número del adulto no pasó el celular a Nico');

    const noConfirm = await api(base, 'POST', '/devices/release', {
      body: { installId: phoneA, confirm: false },
    });
    assert(noConfirm.status === 400, `release sin confirm: ${JSON.stringify(noConfirm.json)}`);

    const swapped = await login(base, '5492222222222', phoneA, { reassignDevice: true });
    assert(swapped.status === 200, `reasignar A a Mateo: ${JSON.stringify(swapped.json)}`);
    assert(swapped.json.user?.name === 'Mateo', 'A ahora Mateo');
    const afterA = await api(base, 'GET', `/devices/lookup?installId=${phoneA}`);
    const afterB = await api(base, 'GET', `/devices/lookup?installId=${phoneB}`);
    assert(afterA.json.bound === true && afterA.json.user?.name === 'Mateo', 'lookup A Mateo');
    assert(afterB.json.bound === false, `B quedó libre: ${JSON.stringify(afterB.json)}`);

    const sorayaOnB = await login(base, '5491111111111', phoneB);
    assert(sorayaOnB.status === 200, `Soraya en B: ${JSON.stringify(sorayaOnB.json)}`);
    const finalB = await api(base, 'GET', `/devices/lookup?installId=${phoneB}`);
    assert(finalB.json.user?.name === 'Soraya', 'B es Soraya');
    assert(finalB.json.user?.role === 'admin_adult' || finalB.json.user?.role === 'adult', 'B adulto');

    const released = await api(base, 'POST', '/devices/release', {
      body: { installId: phoneA, confirm: true },
    });
    assert(released.status === 200 && released.json.released === true, 'release A');
    assert(released.json.previousUser?.name === 'Mateo', 'salió Mateo');
    const freeA = await api(base, 'GET', `/devices/lookup?installId=${phoneA}`);
    assert(freeA.json.bound === false, 'A ya no saluda a la persona vieja');

    console.log('ok: invertir roles con confirmación; un número sigue siendo una persona');
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
