import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { requireAuth, type AuthedRequest } from '../lib/auth-middleware.js';
import { prisma } from '../lib/prisma.js';
import { invitationPublic, userPublic } from '../lib/serialize.js';
import { hashToken, randomDigits, randomToken, signAccessToken, signRefreshToken } from '../lib/tokens.js';

export const invitationsRouter = Router();

async function findInvitation(tokenOrCode: string) {
  const key = tokenOrCode.trim().toUpperCase();
  return prisma.invitation.findFirst({
    where: {
      OR: [{ deepLinkToken: key }, { code: key }],
    },
    include: { family: true },
  });
}

invitationsRouter.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const body = z
    .object({
      name: z.string().min(2),
      role: z.enum(['adult', 'kid']),
      pin: z.string().length(4).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Indicá nombre y rol (adulto o hijo/a).' });
  }

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!me?.familyId || (me.role !== 'admin_adult' && me.role !== 'adult')) {
    return res.status(403).json({ error: 'Solo un adulto de la familia puede invitar.' });
  }

  if (body.data.role === 'kid' && body.data.pin && !/^\d{4}$/.test(body.data.pin)) {
    return res.status(400).json({ error: 'El PIN debe tener 4 números.' });
  }

  let code = randomDigits(6);
  for (let i = 0; i < 5; i++) {
    const exists = await prisma.invitation.findUnique({ where: { code } });
    if (!exists) break;
    code = randomDigits(6);
  }
  const deepLinkToken = randomToken(10);
  const pinHash =
    body.data.role === 'kid' && body.data.pin
      ? await bcrypt.hash(body.data.pin, 10)
      : null;

  const invitation = await prisma.invitation.create({
    data: {
      familyId: me.familyId,
      createdByUserId: me.id,
      role: body.data.role,
      nameHint: body.data.name.trim(),
      code,
      deepLinkToken,
      pinHash,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
    include: { family: true },
  });

  const inviteUrl = `${env.invitePublicBaseUrl}/i/${invitation.deepLinkToken}`;
  return res.status(201).json({
    invitation: invitationPublic(invitation, invitation.family.name),
    inviteUrl,
    shareMessage:
      `Hola ${invitation.nameHint}, te sumé a Llegué.\n\n` +
      `Tocá este link, descargá la app y listo (tus datos ya están cargados):\n` +
      `${inviteUrl}`,
  });
});

invitationsRouter.get('/:token', async (req, res) => {
  const invitation = await findInvitation(req.params.token);
  if (!invitation) {
    return res.status(404).json({ error: 'Invitación no encontrada.' });
  }
  if (invitation.status !== 'pending' || invitation.expiresAt < new Date()) {
    if (invitation.status === 'pending') {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      });
    }
    return res.status(410).json({ error: 'Esta invitación ya no sirve. Pedí una nueva.' });
  }
  return res.json({
    invitation: invitationPublic(invitation, invitation.family.name),
  });
});

invitationsRouter.post('/:token/accept', requireAuth, async (req: AuthedRequest, res) => {
  const body = z
    .object({
      pin: z.string().length(4).optional(),
      birthDate: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }

  const invitation = await findInvitation(req.params.token);
  if (!invitation || invitation.status !== 'pending' || invitation.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Esta invitación no sirve o venció.' });
  }

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!me) {
    return res.status(401).json({ error: 'Sesión inválida.' });
  }
  if (me.familyId) {
    return res.status(400).json({ error: 'Ya estás en una familia.' });
  }

  if (invitation.role === 'kid' && invitation.pinHash) {
    if (!body.data.pin) {
      return res.status(400).json({ error: 'Esta invitación pide un PIN de 4 números.' });
    }
    const ok = await bcrypt.compare(body.data.pin, invitation.pinHash);
    if (!ok) {
      return res.status(401).json({ error: 'PIN incorrecto.' });
    }
  }

  const birthDate = body.data.birthDate ? new Date(body.data.birthDate) : null;
  const updated = await prisma.user.update({
    where: { id: me.id },
    data: {
      familyId: invitation.familyId,
      role: invitation.role === 'kid' ? 'kid' : 'adult',
      name: invitation.nameHint,
      relationshipLabel: invitation.role === 'adult' ? 'Familiar' : null,
      birthDate: invitation.role === 'kid' && birthDate ? birthDate : me.birthDate,
      pinHash: invitation.pinHash ?? me.pinHash,
    },
  });

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      status: 'accepted',
      acceptedByUserId: updated.id,
    },
  });

  const accessToken = signAccessToken({
    sub: updated.id,
    role: updated.role,
    familyId: updated.familyId,
  });
  const refreshToken = signRefreshToken(updated.id);
  await prisma.refreshToken.create({
    data: {
      userId: updated.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return res.json({
    user: userPublic(updated),
    family: {
      id: invitation.family.id,
      name: invitation.family.name,
    },
    accessToken,
    refreshToken,
  });
});
