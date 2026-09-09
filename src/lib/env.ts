import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'llegue-dev-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'llegue-dev-refresh',
  otpDevCode: process.env.OTP_DEV_CODE ?? '123456',
  otpExposeDevCode: (process.env.OTP_EXPOSE_DEV_CODE ?? 'false') === 'true',
  invitePublicBaseUrl: (process.env.INVITE_PUBLIC_BASE_URL ?? 'http://localhost:8787').replace(
    /\/$/,
    '',
  ),
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
