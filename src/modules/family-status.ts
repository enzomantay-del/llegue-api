import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../lib/auth-middleware.js';
import { prisma } from '../lib/prisma.js';
import { familyPublic, userPublic } from '../lib/serialize.js';

export const familyStatusRouter = Router();

familyStatusRouter.get('/status', requireAuth, async (req: AuthedRequest, res) => {
  if (!req.familyId) {
    return res.status(400).json({ error: 'Todavía no estás en una familia.' });
  }

  const family = await prisma.family.findUnique({
    where: { id: req.familyId },
    include: {
      users: {
        include: {
          devices: {
            orderBy: { lastSeenAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!family) {
    return res.status(404).json({ error: 'Familia no encontrada.' });
  }

  return res.json({
    family: familyPublic(family),
    members: family.users.map((u) => {
      const device = u.devices[0];
      const permissionsReady = Boolean(device?.permissionsCompletedAt);
      return {
        ...userPublic(u),
        permissionsReady,
        locationPermission: device?.locationPermission ?? 'not_asked',
        notificationsPermission: device?.notificationsPermission ?? 'not_asked',
      };
    }),
  });
});
