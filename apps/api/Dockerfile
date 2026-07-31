# apps/api/Dockerfile — Autopilot Console API (Hono)
# Multi-stage build: install → build → run

# --- Stage 1: install ---
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile

# --- Stage 2: build ---
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY package.json tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/domain packages/domain
COPY packages/autopilot packages/autopilot
COPY packages/git packages/git
COPY packages/github packages/github
RUN bun run --filter @autopilot-console/api typecheck

# --- Stage 3: runtime ---
FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/apps/worker apps/worker
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/packages/database packages/database
COPY --from=build /app/packages/domain packages/domain
COPY --from=build /app/packages/autopilot packages/autopilot
COPY --from=build /app/packages/git packages/git
COPY --from=build /app/packages/github packages/github
COPY --from=build /app/package.json ./
USER bun
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/main.ts"]
