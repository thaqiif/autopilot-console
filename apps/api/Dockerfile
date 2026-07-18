# apps/api/Dockerfile — Autopilot Console API (Hono)
# Multi-stage build: install → build → run

# --- Stage 1: install ---
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
RUN bun install --frozen-lockfile --production=false

# --- Stage 2: build ---
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY package.json tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/domain packages/domain
RUN bun run --filter api typecheck

# --- Stage 3: runtime ---
FROM oven/bun:1.3.14-slim AS runtime
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/packages/database packages/database
COPY --from=build /app/packages/domain packages/domain
COPY --from=build /app/package.json ./
USER appuser
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
