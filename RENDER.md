# Novato – Render + Neon (Postgres)

Sin Postgres, Render Free borra la familia cuando el servicio duerme o redeploya.
Con `DATABASE_URL` la API usa **Postgres** (Neon) y los datos se conservan.

## 1. Variables en Render

En [dashboard.render.com](https://dashboard.render.com) → servicio **llegue-api** → **Environment**:

| Variable | Qué poner |
| --- | --- |
| `DATABASE_URL` | Connection string de Neon (`postgresql://…`). **No la pegues en el código ni en GitHub.** |
| `JWT_SECRET` | Un texto largo y fijo. **No lo regeneres** en cada deploy (si cambia, caen todas las sesiones). |
| `JWT_REFRESH_SECRET` | Otro texto largo y fijo. **Tampoco lo regeneres.** |
| `NODE_ENV` | `production` |

Opcionales útiles:

| Variable | Valor típico |
| --- | --- |
| `OTP_DEV_CODE` | `123456` (solo pruebas) |
| `SEED_FAMILIA` | `false` |
| `APK_DOWNLOAD_URL` | `https://github.com/enzomantay-del/llegue-mobile/releases/latest/download/Llegue.apk` |

Guardá (**Save Changes**).

## 2. Deploy

1. **Manual Deploy** → **Deploy latest commit** (rama `main` después del merge).
2. Esperá a que el deploy diga Live.

## 3. Verificar `/health`

Abrí en el navegador:

`https://llegue-api.onrender.com/health`

Debe verse algo así:

```json
{
  "ok": true,
  "service": "llegue-api-v2",
  "db": { "dialect": "postgres", "persistent": true },
  "dialect": "postgres"
}
```

Si `dialect` no es `"postgres"` o `ok` es `false`, falta `DATABASE_URL` o el deploy no tomó la variable.

## 4. Después del primer deploy con Postgres

La base nueva arranca **vacía**. En la app hay que **recrear la familia una sola vez** (titular, lugares, invitar hijo).  
Las próximas veces que el servidor duerma o redeploye, **no** debería borrarse.

## 5. Local (desarrollo)

Sin `DATABASE_URL`, la API usa SQLite en `data/llegue.db` (solo PC).  
Con `DATABASE_URL` apunta a Postgres también en local.

## 6. Vaciar la base una sola vez (novato)

Esto borra personas, familias, lugares y sesiones. La estructura queda.

En la carpeta `llegue-api`, con el archivo `.env` que tenga `DATABASE_URL` de Neon (no lo pegues en el chat):

```bat
npm run reset-db -- BORRAR
```

Tiene que decir `Base: postgres` y al final `users ahora: 0`.

Después abrí `https://llegue-api.onrender.com/health` y fijate `"users": 0`.
Si el servidor estaba dormido, esperá a que despierte y actualizá la página.

Sin la palabra `BORRAR` el comando no borra nada.

