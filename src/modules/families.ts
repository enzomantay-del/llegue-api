import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../lib/auth-middleware.js';
import { prisma } from '../lib/prisma.js';
import { familyPublic, userPublic } from '../lib/serialize.js';
import { signAccessToken, signRefreshToken, hashToken } from '../lib/tokens.js';

export const familiesRouter = Router();

familiesRouter.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const body = z
    .object({
      name: z.string().min(2),
      relationshipLabel: z.string().min(2),
      displayName: z.string().min(2).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Escribí el nombre de la familia y tu rol.' });
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    return res.status(401).json({ error: 'Sesión inválida.' });
  }
  if (user.familyId) {
    return res.status(400).json({ error: 'Ya estás en una familia.' });
  }

  const familyName = body.data.name.trim();
  const relationshipLabel = body.data.relationshipLabel.trim();
  const displayName = (body.data.displayName ?? user.name).trim();

  const family = await prisma.family.create({
    data: {
      name: familyName,
      users: {
        connect: { id: user.id },
      },
    },
  });

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      familyId: family.id,
      role: 'admin_adult',
      name: displayName,
      relationshipLabel,
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

  return res.status(201).json({
    family: familyPublic(family),
    user: userPublic(updated),
    accessToken,
    refreshToken,
  });
});

familiesRouter.get('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const family = await prisma.family.findUnique({
    where: { id: req.params.id },
    include: { users: true },
  });
  if (!family) {
    return res.status(404).json({ error: 'Familia no encontrada.' });
  }
  if (family.id !== req.familyId) {
    return res.status(403).json({ error: 'No podés ver esta familia.' });
  }
  return res.json({
    family: familyPublic(family),
    members: family.users.map(userPublic),
  });
});
