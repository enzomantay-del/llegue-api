/**
 * Envío de push FCM.
 *
 * Opciones (cualquiera alcanza):
 * 1) FCM_SERVER_KEY  → API legacy (más simple)
 * 2) FCM_SERVICE_ACCOUNT_PATH → JSON de cuenta de servicio (HTTP v1)
 *
 * Sin ninguna, las notificaciones quedan en la DB (poll / app abierta).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let cachedAccessToken = null;
let cachedTokenExp = 0;

function loadServiceAccount() {
  const p =
    process.env.FCM_SERVICE_ACCOUNT_PATH ||
    path.join(root, 'firebase-service-account.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedTokenExp > now + 60) {
    return cachedAccessToken;
  }
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  sign.end();
  const signature = sign
    .sign(sa.private_key)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`OAuth FCM: ${JSON.stringify(json)}`);
  }
  cachedAccessToken = json.access_token;
  cachedTokenExp = now + Number(json.expires_in || 3600);
  return cachedAccessToken;
}

async function sendHttpV1(token, { title, body, urgent }) {
  const sa = loadServiceAccount();
  if (!sa?.project_id) return { sent: false, reason: 'no-service-account' };
  const access = await getAccessToken(sa);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: {
            title,
            body,
            urgent: urgent ? 'true' : 'false',
          },
          android: {
            priority: 'high',
            notification: {
              channelId: urgent ? 'llegue_siren_v3' : 'llegue_alerts_v3',
              sound: 'default',
              defaultVibrateTimings: true,
              notificationPriority: urgent ? 'PRIORITY_MAX' : 'PRIORITY_HIGH',
            },
          },
        },
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  return { sent: res.ok, detail: json, via: 'http-v1' };
}

async function sendLegacy(token, { title, body, urgent }) {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return { sent: false, reason: 'no-fcm-key' };
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      authorization: `key=${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      priority: 'high',
      notification: { title, body, sound: 'default' },
      data: { title, body, urgent: urgent ? 'true' : 'false' },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channel_id: urgent ? 'llegue_siren_v3' : 'llegue_alerts_v3',
        },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { sent: res.ok && !json.failure, detail: json, via: 'legacy' };
}

export async function sendPushToToken(token, { title, body, urgent = false }) {
  if (!token) return { sent: false, reason: 'no-token' };
  try {
    if (loadServiceAccount()) {
      return await sendHttpV1(token, { title, body, urgent });
    }
    if (process.env.FCM_SERVER_KEY) {
      return await sendLegacy(token, { title, body, urgent });
    }
    return { sent: false, reason: 'no-fcm-config' };
  } catch (e) {
    return { sent: false, reason: String(e) };
  }
}
