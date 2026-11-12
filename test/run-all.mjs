/**
 * Corre la suite sin DATABASE_URL, aunque el entorno o un .env apunten a Neon.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'test/sql-pg-params.mjs',
  'test/special-trip-cancel.mjs',
  'test/invite-auth-refresh.mjs',
  'test/share-place-auth.mjs',
  'test/presence-home-sharing.mjs',
  'test/presence-outing-gohome.mjs',
  'test/persist-restart.mjs',
  'test/device-reassign.mjs',
  'test/reset-and-dedupe.mjs',
];

const env = { ...process.env, LLEGUE_TEST: '1' };
delete env.DATABASE_URL;

for (const file of files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', file], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (status) => resolve(status ?? 1));
  });
  if (code !== 0) process.exit(code);
}
