# gateway: one container, one merchant, exactly one replica.
# Build:  docker build -t gateway .
# Run:    see docs/deploy.md (needs a persistent volume at /data).

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CONFIG_PATH=/config/config.json \
    DB_PATH=/data/gateway.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# For `npm run init` and non-production runs only. Production (NODE_ENV=production, the image
# default) refuses to start without a config mounted at CONFIG_PATH.
COPY config.example.json ./
RUN mkdir -p /data /config && chown node:node /data
USER node
# No VOLUME instruction: Railway rejects it, and an anonymous volume doesn't
# survive `docker rm` anyway. Mount a named/platform volume at /data; the
# server warns at startup if DB_PATH sits on the container's own filesystem.
EXPOSE 3000
CMD ["node", "dist/server.js"]
