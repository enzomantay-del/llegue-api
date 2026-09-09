import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../lib/auth-middleware.js';
import { prisma } from '../lib/prisma.js';
import { devicePublic } from '../lib/serialize.js';

export const devicesRouter = Router();

devicesRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const devices = await prisma.device.findMany({
    where: { userId: req.userId! },
    orderBy: { lastSeenAt: 'desc' },
  });
  return res.json({ devices: devices.map(devicePublic) });
});

devicesRouter.post('/register', requireAuth, async (req: AuthedRequest, res) => {
  const body = z
    .object({
      platform: z.enum(['android', 'ios']),
      pushToken: z.string().optional(),
      deviceId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Falta la plataforma del celular.' });
  }

  let device =
    body.data.deviceId != null
      ? await prisma.device.findFirst({
          where: { id: body.data.deviceId, userId: req.userId! },
        })
      : null;

  if (device) {
    device = await prisma.device.update({
      where: { id: device.id },
      data: {
        platform: body.data.platform,
        pushToken: body.data.pushToken ?? device.pushToken,
        lastSeenAt: new Date(),
      },
    });
  } else {
    device = await prisma.device.create({
      data: {
        userId: req.userId!,
        platform: body.data.platform,
        pushToken: body.data.pushToken,
      },
    });
  }

  return res.status(201).json({ device: devicePublic(device) });
});

devicesRouter.patch('/me/permissions', requireAuth, async (req: AuthedRequest, res) => {
  const body = z
    .object({
      deviceId: z.string().uuid().optional(),
      locationPermission: z.enum(['not_asked', 'while_in_use', 'always', 'denied']),
      notificationsPermission: z.enum(['not_asked', 'granted', 'denied']),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'Faltan los permisos.' });
  }

  let device = body.data.deviceId
    ? await prisma.device.findFirst({
        where: { id: body.data.deviceId, userId: req.userId! },
      })
    : await prisma.device.findFirst({
        where: { userId: req.userId! },
        orderBy: { lastSeenAt: 'desc' },
      });

  if (!device) {
    device = await prisma.device.create({
      data: {
        userId: req.userId!,
        platform: 'android',
      },
    });
  }

  const locationOk = body.data.locationPermission === 'always' ||
    body.data.locationPermission === 'while_in_use';
  const notifOk = body.data.notificationsPermission === 'granted';
  const completed = locationOk && notifOk;

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      locationPermission: body.data.locationPermission,
      notificationsPermission: body.data.notificationsPermission,
      permissionsCompletedAt: completed ? new Date() : null,
      lastSeenAt: new Date(),
    },
  });

  return res.json({
    device: devicePublic(updated),
    permissionsReady: completed,
  });
});
