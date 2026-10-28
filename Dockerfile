# The Foundry — Ghost Core v1.0
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p data artifacts logs

EXPOSE 4040
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
