import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.mjs';
import { ensureSchema } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = await openDatabase();
await ensureSchema(db);
console.log('DB lista', db.info?.() ?? { dialect: db.dialect });
await db.close?.();
