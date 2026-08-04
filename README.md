# Llegué API (backend)

Servidor para unir círculos familiares y compartir avisos (y config) entre dispositivos.

## Arrancar en la PC

```powershell
cd "D:\Documents\Prueba de Cursor\llegue\backend"
$env:Path = "C:\src\flutter\bin;" + $env:Path
dart run bin/server.dart
```

Queda en: `http://localhost:8787`  
Health: `http://localhost:8787/health`

## Probar en la misma WiFi

1. En la PC, averiguá tu IP local (ej. `192.168.0.15`).
2. En la app → **Familia** → Servidor: `http://192.168.0.15:8787`
3. Tocá **Probar conexión** (debe decir online).
4. Adulto: **Crear círculo familiar** → copiá el código.
5. Otro dispositivo: **Unirme al círculo** con ese código.

## Subir a la nube (siguiente paso del plan)

Hay un `Dockerfile` y un `render.yaml` listos.

1. Creá cuenta en [Render](https://render.com) (plan free alcanza para probar).
2. New → Blueprint → elegí este backend (o Web Service + Docker).
3. Cuando esté online, copiá la URL (ej. `https://llegue-api.onrender.com`).
4. En la app → Familia → pegá esa URL → Probar conexión.

En plan free el servicio puede “dormir” tras un rato sin uso; el primer aviso tarda unos segundos en despertar.

## Endpoints

| Método | Ruta | Uso |
|--------|------|-----|
| GET | `/health` | Estado |
| POST | `/v1/families` | Crear círculo |
| POST | `/v1/families/join` | Unirse con código |
| GET | `/v1/me` | Familia y miembros |
| PATCH | `/v1/me` | Preferencias (recibir avisos) |
| POST | `/v1/events` | Publicar aviso |
| GET | `/v1/events?since=` | Leer avisos nuevos |
| GET/PUT | `/v1/config` | Zonas, rutinas e hijos del círculo |

Datos guardados en `data/store.json` (o `LLEGUE_DATA`).
