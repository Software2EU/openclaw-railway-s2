FROM node:24-bookworm
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
    tini \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest clawhub@latest
# Backward-compatibility shim for older OPENCLAW_ENTRY values.
RUN mkdir -p /openclaw \
  && ln -sfn /usr/local/lib/node_modules/openclaw/dist /openclaw/dist
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10 && pnpm install --prod
COPY src ./src
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew
USER openclaw
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

# === S2: Install Bun (as openclaw user) ===
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/home/openclaw/.bun"
ENV PATH="/home/openclaw/.bun/bin:${PATH}"

# === S2: Install GBrain CLI ===
RUN git clone --depth 1 https://github.com/garrytan/gbrain.git /home/openclaw/gbrain \
    && cd /home/openclaw/gbrain \
    && bun install --ignore-scripts \
    && bun link

RUN git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git /home/openclaw/gstack \
    && cd /home/openclaw/gstack \
    && bun install --ignore-scripts \
    && mkdir -p /home/openclaw/.claude/skills \
    && cp -R /home/openclaw/gstack /home/openclaw/.claude/skills/gstack

# Build browse binary (non-fatal if it fails)
RUN cd /home/openclaw/gstack && bun run build 2>/dev/null || true

# Link gstack as a Claude skill so OpenClaw can invoke /review, /qa, etc.
RUN mkdir -p /home/openclaw/.claude/skills \
    && ln -sfn /home/openclaw/gstack /home/openclaw/.claude/skills/gstack

ENV GSTACK_DIR="/home/openclaw/gstack"

# === S2: Install Playwright system deps (needs root) ===
USER root
RUN cd /home/openclaw/gstack && npx playwright install-deps chromium

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1
USER root
ENTRYPOINT ["./entrypoint.sh"]
