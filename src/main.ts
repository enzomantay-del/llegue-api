import cors from 'cors';
import express from 'express';
import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { authRouter } from './modules/auth.js';
import { devicesRouter } from './modules/devices.js';
import { familiesRouter } from './modules/families.js';
import { familyStatusRouter } from './modules/family-status.js';
import { invitationsRouter } from './modules/invitations.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'llegue-api-v2' });
});

app.use('/auth', authRouter);
app.use('/families', familiesRouter);
app.use('/invitations', invitationsRouter);
app.use('/devices', devicesRouter);
app.use('/family', familyStatusRouter);

app.get('/i/:token', async (req, res) => {
  const token = req.params.token.trim().toUpperCase();
  const invitation = await prisma.invitation.findFirst({
    where: {
      OR: [{ deepLinkToken: token }, { code: token }],
    },
    include: { family: true },
  });

  if (!invitation || invitation.status !== 'pending' || invitation.expiresAt < new Date()) {
    res.status(404).type('html').send(inviteHtml({
      greeting: 'Este link ya no sirve',
      detail: 'Pedile a tu familia uno nuevo por WhatsApp.',
      token: '',
    }));
    return;
  }

  const roleLabel = invitation.role === 'kid' ? 'hijo/a' : 'adulto';
  res.type('html').send(inviteHtml({
    greeting: `Hola, ${invitation.nameHint}`,
    detail:
      `Te invitaron a la familia ${invitation.family.name} como ${roleLabel}. ` +
      'Tus datos ya están cargados. Descargá la app y entrá.',
    token: invitation.deepLinkToken,
  }));
});

function inviteHtml(opts: { greeting: string; detail: string; token: string }) {
  const hasToken = opts.token.length > 0;
  const openBtn = hasToken
    ? `<a class="btn secondary" href="llegue://join/${opts.token}">Ya tengo la app — Entrar</a>`
    : '';
  const tip = hasToken
    ? '<p class="tip">Si no abre sola, abrí Llegué y tocá <strong>Me invitaron</strong>. Pegá este mismo link.</p>'
    : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Llegué</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; min-height: 100vh;
      background: linear-gradient(155deg, #0f3d34, #1f8a70 55%, #3d2a1a); color: #fff;
      display: grid; place-items: center; padding: 24px; }
    main { max-width: 420px; width: 100%; background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.18); border-radius: 24px; padding: 28px; }
    h1 { font-family: Georgia, serif; margin: 0 0 8px; font-size: 2rem; }
    .hi { font-size: 1.35rem; font-weight: 700; margin: 0 0 10px; }
    p { margin: 0 0 12px; line-height: 1.45; color: rgba(255,255,255,.86); }
    .btn { display: block; text-align: center; text-decoration: none; color: #0f3d34;
      background: #fff; font-weight: 800; padding: 18px; border-radius: 16px; margin-top: 14px; }
    .btn.secondary { background: rgba(255,255,255,.18); color: #fff;
      border: 2px solid rgba(255,255,255,.55); }
    .tip { margin-top: 18px; font-size: .95rem; color: rgba(255,255,255,.75); }
  </style>
</head>
<body>
  <main>
    <h1>Llegué</h1>
    <p class="hi">${opts.greeting}</p>
    <p>${opts.detail}</p>
    ${openBtn}
    ${tip}
  </main>
</body>
</html>`;
}

app.listen(env.port, () => {
  console.log(`Llegué API v2 en http://localhost:${env.port}`);
});
