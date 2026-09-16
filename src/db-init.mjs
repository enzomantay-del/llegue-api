import { openDatabase } from './db.mjs';
import { ensureSchema } from './schema.mjs';

const db = await openDatabase();
await ensureSchema(db);
console.log('DB lista:', db.info());
await db.close();
