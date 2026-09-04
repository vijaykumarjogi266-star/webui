# syntax=docker/dockerfile:1.7
# AI Workspace — deploy image for the zero-dependency Node build.
# No npm install step on purpose: the app uses only the Node standard library,
# so the runtime image carries no node_modules and nothing to audit.
#
#   docker build -t ai-workspace:local ai-workspace
#   docker run --rm -p 3000:3000 -v ai-workspace-data:/app/data ai-workspace:local
#
# /app/data is the ONLY writable path (JSON store + master.key). Mount it, or
# every redeploy loses the encrypted provider keys. See deploy/README.md.

ARG BASE_IMAGE=node:20-alpine

FROM ${BASE_IMAGE} AS runtime
ARG GIT_SHA=unknown
ARG BUILD_VERSION=dev

ENV NODE_ENV=production \
    PORT=3000

LABEL org.opencontainers.image.title="ai-workspace" \
      org.opencontainers.image.description="Zero-dependency Node AI workspace (BYOK vault, SSE chat, RAG, feedback, usage)" \
      org.opencontainers.image.source="https://github.com/vijaykumarjogi266-star/webui" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="UNLICENSED"

# Non-root, no shell login, no home dir. The uid/gid is pinned (not auto-assigned)
# so host bind mounts can be chowned to 10001:10001 without inspecting the image.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app \
 && mkdir -p /app/data && chown -R 10001:10001 /app/data

WORKDIR /app

# Copied individually (not `COPY . .`) so build output, tests, secrets and git
# metadata can never ride along into the final image.
COPY --chown=app:app package.json ./
COPY --chown=app:app server.js make-demo.js ./
COPY --chown=app:app lib/ ./lib/
COPY --chown=app:app public/ ./public/
COPY --chown=app:app scripts/ ./scripts/

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health/live" >/dev/null || exit 1

# Exec form so node (not a shell) receives SIGTERM — server.js flushes the
# store on SIGTERM before exiting.
CMD ["node", "server.js"]
