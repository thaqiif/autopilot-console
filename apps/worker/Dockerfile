# apps/worker/Dockerfile — Autopilot Console worker
# Multi-stage build with development tooling (git, jq, gh, autopilotagent)

# --- Stage 1: install ---
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/autopilot/package.json packages/autopilot/
COPY packages/github/package.json packages/github/
COPY packages/git/package.json packages/git/
RUN bun install --frozen-lockfile --production=false

# --- Stage 2: build ---
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/worker/node_modules apps/worker/node_modules
COPY package.json tsconfig.base.json tsconfig.json ./
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/domain packages/domain
COPY packages/autopilot packages/autopilot
COPY packages/github packages/github
COPY packages/git packages/git
RUN bun run --filter worker typecheck

# --- Stage 3: runtime with development tools ---
FROM oven/bun:1.3.14-slim AS runtime

# Install required development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ca-certificates \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/worker apps/worker
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/packages/database packages/database
COPY --from=build /app/packages/domain packages/domain
COPY --from=build /app/packages/autopilot packages/autopilot
COPY --from=build /app/packages/github packages/github
COPY --from=build /app/packages/git packages/git
COPY --from=build /app/package.json ./

# Validate required tools are available
RUN git --version && jq --version && gh --version

USER appuser
EXPOSE 3001
CMD ["bun", "run", "apps/worker/src/index.ts"]
