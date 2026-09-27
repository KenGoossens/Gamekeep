# syntax=docker/dockerfile:1

# --- build the frontend ------------------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

# --- build the server --------------------------------------------------------
FROM node:24-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/ ./
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./web/dist

# Deliberately runs as root. On Unraid /var/run/docker.sock is root:root mode
# 660, so a non-root user in this container simply cannot reach Docker at all.
# The meaningful hardening lever here is docker-socket-proxy (see README), not
# the container's uid.

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
