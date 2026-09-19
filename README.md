# Llegué API

Backend de Llegué. En **producción** la base tiene que ser **PostgreSQL** (`DATABASE_URL`).
SQLite queda solo para desarrollo local: en Render Free el disco se borra al sleep/redeploy
y se perdían familias, lugares y sesiones.

## Novato – Render + Neon

Guía paso a paso: **[RENDER.md](./RENDER.md)**.

Resumen:

1. Pegá en Render → **Environment**: `DATABASE_URL` (Neon), `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`.
2. **Save** → **Manual Deploy** → latest `main`.
3. Abrí `/health`: debe decir `"dialect": "postgres"` y `"ok": true`.
4. Tras el primer deploy con Postgres, **recreá la familia una vez** en la app.

## Variables de entorno

Copiá `.env.example` a `.env` en local.

| Variable | Obligatorio en prod | Notas |
| --- | --- | --- |
| `DATABASE_URL` | sí | `postgresql://…` de Neon. **No la subas a GitHub.** |
| `NODE_ENV` | sí (`production`) | Sin Postgres en prod el proceso no arranca y `/health` responde 503. |
| `JWT_SECRET` | sí | Estable. **No lo regeneres** en cada deploy. |
| `JWT_REFRESH_SECRET` | sí | Igual. |
| `ACCESS_TTL_SEC` | no | Default 7 días. |
| `REFRESH_TTL_SEC` | no | Default 60 días. |
| `PORT` | no | Render lo inyecta. Local: 8787. |
| `SEED_FAMILIA` | no | En prod dejar `false`. |

## Cómo probar

```bash
npm install
npm test
```

Local sin `DATABASE_URL` → SQLite en `data/llegue.db`.
