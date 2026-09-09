import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';
import { verifyAccessToken } from './tokens.js';

export type AuthedRequest = Request & {
  userId?: string;
  userRole?: string;
  familyId?: string | null;
};

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
  }
  try {
    const payload = verifyAccessToken(header.slice(7).trim());
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    req.userId = user.id;
    req.userRole = user.role;
    req.familyId = user.familyId;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión vencida. Volvé a entrar.' });
  }
}
