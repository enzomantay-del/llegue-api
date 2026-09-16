# Llegué API

Backend de Llegué. En **producción** la base tiene que ser **PostgreSQL** (`DATABASE_URL`). SQLite queda solo para desarrollo local: en Render Free el disco se borra al sleep/redeploy y se perdían familias, lugares y sesiones.

## Variables de entorno

Copiá `.env.example` a `.env` en local.

| Variable | Obligatorio en prod | Notas |
| --- | --- | --- |
| `DATABASE_URL` | sí | `postgresql://…` de Neon, Supabase o Render Postgres. Incluí `?sslmode=require` en Neon/Supabase. |
| `NODE_ENV` | sí (`production`) | Sin Postgres en prod el proceso **no arranca** y `/health` responde 503. |
| `JWT_SECRET` | sí | Estable. **No lo regeneres** en cada deploy: invalidaría sesiones. |
| `JWT_REFRESH_SECRET` | sí | Igual que `JWT_SECRET`. |
| `ACCESS_TTL_SEC` | no | Default 7 días. |
| `REFRESH_TTL_SEC` | no | Default 60 días. `POST /auth/refresh` con `{ "refreshToken" }` rota el token. |
| `PORT` | no | Render lo inyecta. Local: 8787. |
| `INVITE_PUBLIC_BASE_URL` | recomendado | URL pública `https://….onrender.com` |
| `SEED_FAMILIA` | no | Solo local. En prod dejar `false`. |

SQLite local (sin `DATABASE_URL`): archivo `data/llegue.db` o `LLEGUE_DB_PATH`.

## Postgres en Render (Neon u otro)

1. Creá una base en [Neon](https://console.neon.tech), Supabase o **Render → PostgreSQL**.
2. Copiá el connection string (`postgresql://USER:PASSWORD@HOST/DB?sslmode=require`).
3. En el Web Service de Render → **Environment**:
   - `DATABASE_URL` = ese string
   - `NODE_ENV` = `production`
   - `JWT_SECRET` y `JWT_REFRESH_SECRET` = valores fijos (o los que Render ya generó). **No uses Generate** de nuevo.
4. Redeploy. `/health` debe devolver `{ "ok": true, "db": { "dialect": "postgres", "persistent": true } }`.

Al arrancar, la API crea las tablas si no existen (users, families, members vía users, places, trips, devices, events, invitations, etc.).

## Cómo probar que sobrevive un restart

```bash
npm install
npm test
```

A mano, con SQLite local:

1. `npm run dev`
2. Crear familia / login OTP.
3. Parar el server (Ctrl+C) y volver a `npm run dev`.
4. Login otra vez: la familia, lugares e invitaciones siguen.

Con Postgres: mismo flujo, pero con `DATABASE_URL` apuntando a Neon. Un restart de Render **no** debe vaciar la familia.
