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

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-impress python3-pip && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages python-pptx

# Install Playwright system deps (Chromium needs these libraries)
COPY --from=playwright-cache /root/.cache/ms-playwright /root/.cache/ms-playwright
RUN npx --yes playwright@latest install-deps chromium

RUN npm install -g openclaw@2026.3.13 clawhub@latest

# Claude Code CLI. gstack skills (/review, /cso, /ship, ...) are Claude Code
# skills: OpenClaw runs them by spawning a Claude Code session over ACP, so the
# `claude` binary MUST be on PATH or the agent has nothing to spawn and falls
# back to improvising. Package name per Anthropic's official install docs
# (https://code.claude.com/docs/en/setup -> "Install with npm").
# The npm package links a per-platform native binary into /usr/local/bin/claude
# (on PATH for every user). Auto-update is pointless in an immutable image.
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g @anthropic-ai/claude-code \
    && claude --version

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
COPY gstack ./gstack
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

RUN useradd -m -s /bin/bash openclaw \
    && chown -R openclaw:openclaw /app \
    && mkdir -p /data && chown openclaw:openclaw /data \
    && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

# Pre-install ACP's acpx backend at build time (as root) and hand the whole
# extension dir to the openclaw user. At runtime the acpx plugin tries to
# npm-install acpx@0.1.16 into this dir as the openclaw user; the dir is
# root-owned (from `npm install -g openclaw` above) so that write fails with
# EACCES. chown -R makes it openclaw-owned so EITHER this build-time install
# sticks OR a runtime self-install succeeds. Pin is acpx@0.1.16 — the runtime's
# ACPX_PINNED_VERSION, not the 0.3.0 in package.json. Runs AFTER `useradd`
# (chown needs the user) and AFTER `npm install -g openclaw` (the dir must
# exist). `set -eux` + the version echo make the step visible in the build log
# and fail loudly if the path ever moves. The reworked instruction text also
# changes this layer's cache key, so a correct build re-runs it (and the chown)
# rather than reusing a stale pre-acpx layer.
RUN set -eux; \
    acpx_dir=/usr/local/lib/node_modules/openclaw/extensions/acpx; \
    echo "[build] acpx-preinstall step (rev2)"; \
    test -d "$acpx_dir"; \
    cd "$acpx_dir"; \
    npm install --omit=dev acpx@0.1.16; \
    chown -R openclaw:openclaw "$acpx_dir"; \
    node -e "console.log('[build] acpx installed:', require('$acpx_dir/node_modules/acpx/package.json').version)"; \
    ls -ld "$acpx_dir"

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

# === S2: Install GStack the canonical way ==================================
# gstack ships its skills as TOP-LEVEL folders (review/, cso/, ship/, qa/, ...)
# and its own `./setup` registers them per-host. For OpenClaw the host is
# Claude Code (OpenClaw spawns Claude Code over ACP), so we install gstack into
# Claude Code's skills dir and let `./setup` (default --host claude) wire up the
# slash commands. `./setup --host openclaw` is intentionally a no-op that only
# prints docs, so we do NOT use it.
#
# Canonical path: the clone IS the install — gstack lives directly at
# ~/.claude/skills/gstack and `./setup` symlinks each skill folder beside it in
# ~/.claude/skills. No second copy, no /opt split.
#
# Dropped in commit 73df843 (the "Session 15" rewrite left a
# `RUN <install ... gstack>` placeholder that was never filled back in), which
# is why the agent had no skills and improvised reviews.
ENV CLAUDE_SKILLS_DIR="/home/openclaw/.claude/skills"
ENV GSTACK_DIR="/home/openclaw/.claude/skills/gstack"
# Optional build-time token for cloning a private GStack (runtime git auth is
# wired separately in entrypoint.sh). Pass with: --build-arg GSTACK_TOKEN=...
ARG GSTACK_TOKEN=
RUN set -eu; \
    url="https://github.com/garrytan/gstack.git"; \
    if [ -n "$GSTACK_TOKEN" ]; then \
      url="https://x-access-token:${GSTACK_TOKEN}@github.com/garrytan/gstack.git"; \
    fi; \
    mkdir -p "$CLAUDE_SKILLS_DIR"; \
    git clone --single-branch --depth 1 "$url" "$GSTACK_DIR"; \
    cd "$GSTACK_DIR"; \
    bun install; \
    bun run build; \
    bunx playwright install chromium; \
    GSTACK_SKIP_FONTS=1 ./setup --no-prefix --no-plan-tune-hooks; \
    echo "[build] gstack skills registered in $CLAUDE_SKILLS_DIR:"; \
    ls -1 "$CLAUDE_SKILLS_DIR"; \
    test -f "$CLAUDE_SKILLS_DIR/review/SKILL.md"; \
    test -f "$CLAUDE_SKILLS_DIR/cso/SKILL.md"

# === S2 cost guard: refuse oversized /review diffs (Guard 3) =================
# gstack /review fans out parallel specialist subagents that each re-read the
# full diff; on a huge working-tree diff that is slow and very expensive (a
# single unscoped review cost ~$33). gstack only gates the LOWER end (skips
# specialists < 50 lines) and has no upper bound. Inject a hard upper-bound abort
# into the installed review SKILL.md, right after "Step 3: Get the diff" and
# before the critical pass (Step 4) / specialist dispatch (Step 4.5). This uses
# the same prompt-gating mechanism gstack already relies on for its lower gate.
# Idempotent (marker); fails the build loudly if the gate anchor ever moves so we
# notice gstack drift instead of silently losing the guard.
RUN node -e ' \
  const fs = require("fs"); \
  const skill = process.env.GSTACK_DIR + "/review/SKILL.md"; \
  const guard = fs.readFileSync("/app/gstack/review-diff-guard.md", "utf8"); \
  let s = fs.readFileSync(skill, "utf8"); \
  if (s.includes("s2-diff-guard")) { console.log("[build] diff guard already present"); process.exit(0); } \
  let anchor = "\n## Step 3.4:"; let i = s.indexOf(anchor); \
  if (i < 0) { anchor = "\n## Step 4: Critical pass"; i = s.indexOf(anchor); } \
  if (i < 0) { console.error("[build] FATAL: review SKILL.md gate anchor not found (gstack drift?)"); process.exit(1); } \
  s = s.slice(0, i + 1) + guard + "\n" + s.slice(i + 1); \
  fs.writeFileSync(skill, s); \
  console.log("[build] injected diff-size scope guard into review SKILL.md before " + anchor.trim()); \
'

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER root
ENTRYPOINT ["./entrypoint.sh"]
