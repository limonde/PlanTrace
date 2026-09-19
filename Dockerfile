# ---- Build stage: compile the SPA ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js eslint.config.js ./
COPY src ./src
COPY public ./public
COPY server ./server

RUN npm run build

# ---- Runtime stage: static files + built-in Node API server ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# The production server only uses Node built-ins, so no node_modules needed.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data /app/backups

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]
