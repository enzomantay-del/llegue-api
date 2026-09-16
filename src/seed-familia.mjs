/**
 * Carga / actualiza la familia de prueba con IDs fijos.
 * Se puede correr solo o al arrancar el servidor.
 * Editar datos en datos-familia.json (una sola vez).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function loadFamiliaConfig() {
  const p = path.join(root, 'datos-familia.json');
  if (!fs.existsSync(p)) {
    throw new Error(`Falta ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {{ prepare: Function, dialect?: string }} db
 * @param {{ forcePin?: boolean }} [opts]
 */
export async function seedFamilia(db, opts = {}) {
  const cfg = loadFamiliaConfig();
  const family = cfg.family;
  const adult = cfg.adult;
  const kid = cfg.kid;
  const places = Array.isArray(cfg.places) ? cfg.places : [];

  const adultPhone = normalizePhone(adult.phone);
  const kidPhone = normalizePhone(kid.phone);
  if (adultPhone.length < 8 || kidPhone.length < 8) {
    throw new Error(
      'En datos-familia.json poné teléfonos reales (solo dígitos, mín. 8).',
    );
  }

  const existingFamily = await db.prepare('SELECT id FROM families WHERE id = ?').get(family.id);
  if (existingFamily) {
    await db.prepare('UPDATE families SET name = ? WHERE id = ?').run(family.name, family.id);
  } else {
    await db.prepare('INSERT INTO families (id, name, created_at) VALUES (?, ?, ?)').run(
      family.id,
      family.name,
      nowIso(),
    );
  }

  await upsertUser(db, {
    id: adult.id,
    familyId: family.id,
    role: 'admin_adult',
    name: adult.name,
    phone: adultPhone,
    relationshipLabel: adult.relationshipLabel || 'Padre',
    pinHash: null,
  });

  const kidRow = await db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(kid.id);
  let pinHash = kidRow?.pin_hash ?? null;
  if (!pinHash || opts.forcePin) {
    pinHash = hashPin(kid.pin || '1234');
  }

  await upsertUser(db, {
    id: kid.id,
    familyId: family.id,
    role: 'kid',
    name: kid.name,
    phone: kidPhone,
    relationshipLabel: null,
    pinHash,
  });

  for (const place of places) {
    const row = await db.prepare('SELECT id FROM places WHERE id = ?').get(place.id);
    const radius = Number(place.radiusM) > 0 ? Number(place.radiusM) : 120;
    if (row) {
      await db.prepare(
        `UPDATE places SET name = ?, lat = ?, lng = ?, radius_m = ?, type = ?, status = 'active'
         WHERE id = ?`,
      ).run(place.name, place.lat, place.lng, radius, place.type || 'favorite', place.id);
    } else {
      await db.prepare(
        `INSERT INTO places
         (id, family_id, created_by_user_id, name, lat, lng, radius_m, type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        place.id,
        family.id,
        adult.id,
        place.name,
        place.lat,
        place.lng,
        radius,
        place.type || 'favorite',
        nowIso(),
      );
    }
  }

  return {
    familyName: family.name,
    adultName: adult.name,
    adultPhone,
    kidName: kid.name,
    kidPhone,
    kidPin: kid.pin || '1234',
    places: places.map((p) => p.name),
  };
}

async function upsertUser(db, u) {
  const byId = await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id);
  const byPhone = await db.prepare('SELECT id FROM users WHERE phone = ?').get(u.phone);
  if (byPhone && byPhone.id !== u.id) {
    // Liberar teléfono de otro usuario de prueba
    await db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(byPhone.id);
  }
  if (byId) {
    await db.prepare(
      `UPDATE users SET family_id = ?, role = ?, name = ?, phone = ?,
       relationship_label = ?, pin_hash = COALESCE(?, pin_hash) WHERE id = ?`,
    ).run(
      u.familyId,
      u.role,
      u.name,
      u.phone,
      u.relationshipLabel,
      u.pinHash,
      u.id,
    );
  } else {
    await db.prepare(
      `INSERT INTO users
       (id, family_id, role, name, phone, pin_hash, relationship_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.id,
      u.familyId,
      u.role,
      u.name,
      u.phone,
      u.pinHash,
      u.relationshipLabel,
      nowIso(),
    );
  }
}

// CLI: node --experimental-sqlite src/seed-familia.mjs
if (process.argv[1] && path.normalize(process.argv[1]).endsWith('seed-familia.mjs')) {
  const { openDatabase } = await import('./db.mjs');
  const { ensureSchema } = await import('./schema.mjs');
  const db = await openDatabase();
  await ensureSchema(db);
  const info = await seedFamilia(db, { forcePin: true });
  console.log('Familia lista:');
  console.log(`  ${info.familyName}`);
  console.log(`  Adulto: ${info.adultName} · tel ${info.adultPhone}`);
  console.log(`  Hijo/a: ${info.kidName} · tel ${info.kidPhone} · PIN ${info.kidPin}`);
  console.log(`  Lugares: ${info.places.join(', ')}`);
  console.log('OTP de prueba: 123456');
  await db.close();
}
