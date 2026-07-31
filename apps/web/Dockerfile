# apps/web/Dockerfile — Autopilot Console frontend (Vite + React)
# Multi-stage build: install → build → serve

# --- Stage 1: install dependencies ---
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
COPY --from=deps /app/apps/web/node_modules apps/web/node_modules
COPY package.json tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN bun run --filter @autopilot-console/web build

# --- Stage 3: serve static files ---
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
USER 101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
