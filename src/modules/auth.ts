import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { userPublic } from '../lib/serialize.js';
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/tokens.js';

export const authRouter = Router();

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

async function issueTokens(userId: string, role: string, familyId: string | null) {
  const accessToken = signAccessToken({ sub: userId, role, familyId });
  const refreshToken = signRefreshToken(userId);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken, refreshToken };
}

authRouter.post('/request-otp', async (req, res) => {
  const body = z.object({ phone: z.string().min(6) }).safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Escribí un teléfono válido.' });
  }
  const phone = normalizePhone(body.data.phone);
  if (phone.length < 8) {
    return res.status(400).json({ error: 'Escribí un teléfono válido.' });
  }

  const code = env.otpDevCode;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await prisma.otpCode.deleteMany({ where: { phone } });
  await prisma.otpCode.create({ data: { phone, code, expiresAt } });

  const payload: Record<string, unknown> = {
    ok: true,
    message: 'Te enviamos un código.',
  };
  if (env.otpExposeDevCode) {
    payload.devCode = code;
  }
  return res.json(payload);
});

authRouter.post('/verify-otp', async (req, res) => {
  const body = z
    .object({
      phone: z.string().min(6),
      code: z.string().min(4),
      name: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Faltan teléfono o código.' });
  }

  const phone = normalizePhone(body.data.phone);
  const otp = await prisma.otpCode.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp || otp.expiresAt < new Date() || otp.code !== body.data.code.trim()) {
    return res.status(400).json({ error: 'El código no es válido o venció.' });
  }

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    const name = (body.data.name ?? '').trim() || 'Sin nombre';
    user = await prisma.user.create({
      data: {
        phone,
        name,
        role: 'adult',
      },
    });
  }

  await prisma.otpCode.deleteMany({ where: { phone } });
  const tokens = await issueTokens(user.id, user.role, user.familyId);
  return res.json({
    user: userPublic(user),
    ...tokens,
  });
});

authRouter.post('/login-with-pin', async (req, res) => {
  const body = z
    .object({
      inviteTokenOrCode: z.string().min(4),
      pin: z.string().length(4),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Faltan el código de invitación o el PIN.' });
  }

  const key = body.data.inviteTokenOrCode.trim().toUpperCase();
  const invitation = await prisma.invitation.findFirst({
    where: {
      OR: [{ deepLinkToken: key }, { code: key }],
      status: 'pending',
    },
    include: { family: true },
  });
  if (!invitation || invitation.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Esa invitación no sirve o venció.' });
  }
  if (invitation.role !== 'kid' || !invitation.pinHash) {
    return res.status(400).json({ error: 'Esta invitación no usa PIN.' });
  }
  const ok = await bcrypt.compare(body.data.pin, invitation.pinHash);
  if (!ok) {
    return res.status(401).json({ error: 'PIN incorrecto.' });
  }

  const user = await prisma.user.create({
    data: {
      familyId: invitation.familyId,
      role: 'kid',
      name: invitation.nameHint,
      pinHash: invitation.pinHash,
    },
  });
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      status: 'accepted',
      acceptedByUserId: user.id,
    },
  });

  const tokens = await issueTokens(user.id, user.role, user.familyId);
  return res.json({
    user: userPublic(user),
    family: {
      id: invitation.family.id,
      name: invitation.family.name,
    },
    ...tokens,
  });
});

authRouter.post('/refresh', async (req, res) => {
  const body = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Falta el refresh token.' });
  }
  try {
    const payload = verifyRefreshToken(body.data.refreshToken);
    const hash = hashToken(body.data.refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored || stored.expiresAt < new Date() || stored.userId !== payload.sub) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    const tokens = await issueTokens(user.id, user.role, user.familyId);
    return res.json({ user: userPublic(user), ...tokens });
  } catch {
    return res.status(401).json({ error: 'Sesión vencida.' });
  }
});

authRouter.get('/me', async (req, res) => {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
  }
  try {
    const { verifyAccessToken } = await import('../lib/tokens.js');
    const payload = verifyAccessToken(header.slice(7).trim());
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { family: true },
    });
    if (!user) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    return res.json({
      user: userPublic(user),
      family: user.family
        ? { id: user.family.id, name: user.family.name, createdAt: user.family.createdAt }
        : null,
    });
  } catch {
    return res.status(401).json({ error: 'Sesión vencida.' });
  }
});
