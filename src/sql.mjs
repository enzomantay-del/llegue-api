/** Convierte placeholders `?` estilo SQLite a `$1, $2, …` de Postgres. */
export function toPgParams(sql) {
  let n = 0;
  return String(sql).replace(/ON CONFLICT\s*\(/gi, 'ON CONFLICT (').replace(/\?/g, () => `$${++n}`);
}

export function isPostgresUrl(url) {
  return /^postgres(ql)?:\/\//i.test(String(url ?? '').trim());
}

export function isLocalDbUrl(url) {
  const u = String(url ?? '').toLowerCase();
  return u.includes('localhost') || u.includes('127.0.0.1') || u.includes('@postgres:');
}
