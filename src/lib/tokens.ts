import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from './env.js';

export type AccessPayload = {
  sub: string;
  role: string;
  familyId: string | null;
};

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '2h' });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'refresh' }, env.jwtRefreshSecret, {
    expiresIn: '30d',
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, env.jwtSecret) as AccessPayload;
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.jwtRefreshSecret) as { sub: string };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomDigits(length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out.slice(0, length);
}

export function randomToken(length = 12): string {
  return crypto.randomBytes(length).toString('hex').slice(0, length).toUpperCase();
}
