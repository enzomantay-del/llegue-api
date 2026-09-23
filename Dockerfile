FROM node:22-bookworm-slim

WORKDIR /app

# Instalar dependencias (pg) ANTES de copiar el código y de arrancar.
# Sin este paso la imagen no tiene node_modules y Render crashea:
# Cannot find package 'pg'
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY datos-familia.json ./datos-familia.json
COPY public ./public

RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=8787
ENV OTP_DEV_CODE=123456
ENV OTP_EXPOSE_DEV_CODE=false
ENV SEED_FAMILIA=false

EXPOSE 8787

# Render inyecta PORT; el server ya lo lee de process.env.PORT
CMD ["node", "--experimental-sqlite", "src/server.mjs"]
