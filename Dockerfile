# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for better-sqlite3 if no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY examples ./examples
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# One process: the setup page plus background tagging every POLL_INTERVAL_SECONDS.
# HOST=0.0.0.0 is not loopback, so the server refuses to start without APP_PASSWORD.
# CLI in the container: docker compose exec mail-triage node dist/node/cli/index.js status
CMD ["node", "dist/node/server/main.js"]
