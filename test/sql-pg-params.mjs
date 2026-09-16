import { toPgParams } from '../src/sql.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  toPgParams('SELECT * FROM users WHERE id = ? AND family_id = ?') ===
    'SELECT * FROM users WHERE id = $1 AND family_id = $2',
  'placeholders',
);
assert(
  toPgParams(
    'INSERT INTO alert_prefs (user_id, event_type, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, event_type) DO UPDATE SET enabled = excluded.enabled',
  ) ===
    'INSERT INTO alert_prefs (user_id, event_type, enabled) VALUES ($1, $2, $3) ON CONFLICT (user_id, event_type) DO UPDATE SET enabled = excluded.enabled',
  'on conflict',
);

console.log('ok: toPgParams');
