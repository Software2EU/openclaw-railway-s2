# Stage 1: Cache Playwright + Chromium download (separate layer, not re-downloaded on redeploy)
FROM node:22-bookworm AS playwright-cache
RUN npx --yes playwright@latest install --with-deps chromium

# Stage 2: Full OpenClaw container (based on upstream template)
FROM node:22-bookworm

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    python3 \
    build-essential \
    tini \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright system deps (Chromium needs these libraries)
COPY --from=playwright-cache /root/.cache/ms-playwright /root/.cache/ms-playwright
RUN npx --yes playwright@latest install-deps chromium

RUN npm install -g openclaw@2026.3.13 clawhub@latest

# Backward-compatibility shim for older OPENCLAW_ENTRY values.
RUN mkdir -p /openclaw \
    && ln -sfn /usr/local/lib/node_modules/openclaw/dist /openclaw/dist

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# pnpm 11 requires allowBuilds in pnpm-workspace.yaml (not package.json, not CLI flags)
RUN corepack enable \
    && printf 'allowBuilds:\n  node-pty: true\n' > pnpm-workspace.yaml \
    && pnpm install --frozen-lockfile --prod

COPY src ./src
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

RUN useradd -m -s /bin/bash openclaw \
    && chown -R openclaw:openclaw /app \
    && mkdir -p /data && chown openclaw:openclaw /data \
    && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

# Copy Playwright browsers to openclaw user's home (accessible during runtime)
RUN mkdir -p /home/openclaw/.cache/ms-playwright \
    && cp -R /root/.cache/ms-playwright/* /home/openclaw/.cache/ms-playwright/ \
    && chown -R openclaw:openclaw /home/openclaw/.cache/ms-playwright

# Pre-create Homebrew cache dir so brew install doesn't fail on permissions
RUN mkdir -p /home/openclaw/.cache/Homebrew \
    && chown -R openclaw:openclaw /home/openclaw/.cache

USER openclaw

RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

# === S2: Bun (runtime used by GStack skills) ===
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/home/openclaw/.bun"
ENV PATH="/home/openclaw/.bun/bin:${PATH}"

# === S2: Install GStack to ONE canonical path ==============================
# GStack provides the real product-review / qa / design-review skills the
# dashboard dispatches. It was accidentally dropped from this Dockerfile in
# commit 73df843 (the "Session 15" rewrite left a `RUN <install ... gstack>`
# placeholder comment that was never filled back in), which is why the agent
# had no skills on disk and improvised reviews instead.
#
# GSTACK_DIR is the single source of truth. The skill-discovery directory
# (~/.claude/skills) links straight back to it, so there is no /opt/gstack vs
# /home/openclaw/gstack split — install path, discovery scan, and PATH all
# resolve to the same tree.
ENV GSTACK_DIR="/home/openclaw/gstack"
ENV CLAUDE_SKILLS_DIR="/home/openclaw/.claude/skills"
# Optional build-time token for cloning a private GStack (runtime auth is wired
# separately in entrypoint.sh). Pass with: --build-arg GSTACK_TOKEN=...
ARG GSTACK_TOKEN=
RUN set -eu; \
    url="https://github.com/garrytan/gstack.git"; \
    if [ -n "$GSTACK_TOKEN" ]; then \
      url="https://x-access-token:${GSTACK_TOKEN}@github.com/garrytan/gstack.git"; \
    fi; \
    git clone --single-branch --depth 1 "$url" "$GSTACK_DIR"; \
    cd "$GSTACK_DIR"; \
    bun install --ignore-scripts; \
    if [ -x ./setup ]; then NONINTERACTIVE=1 ./setup || true; fi; \
    mkdir -p "$CLAUDE_SKILLS_DIR"; \
    if [ -d "$GSTACK_DIR/skills" ]; then \
      cp -R "$GSTACK_DIR/skills/." "$CLAUDE_SKILLS_DIR/"; \
    fi; \
    [ -e "$CLAUDE_SKILLS_DIR/gstack" ] || ln -sfn "$GSTACK_DIR" "$CLAUDE_SKILLS_DIR/gstack"; \
    echo "[build] GStack skills registered in $CLAUDE_SKILLS_DIR:"; \
    ls -1 "$CLAUDE_SKILLS_DIR"

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER root
ENTRYPOINT ["./entrypoint.sh"]
