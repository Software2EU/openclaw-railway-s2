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
RUN corepack enable && pnpm install --frozen-lockfile --prod --config.onlyBuiltDependencies='["node-pty"]'

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

USER openclaw

RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER root
ENTRYPOINT ["./entrypoint.sh"]
