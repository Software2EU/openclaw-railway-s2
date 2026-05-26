# Session 15 — Playwright back in the OpenClaw container.
#
# THIS FILE IS FOR THE `Software2EU/openclaw-railway-s2` REPO, NOT THE DASHBOARD.
# Copy it over as that repo's `Dockerfile` (adapt the "existing steps" block to
# match the current one). Do NOT add it to s2-brain-dashboard's build.
#
# WHY a multi-stage build: Session 12 removed Playwright because the ~167 MB
# Chromium download throttled Railway builds to 30+ minutes. A dedicated cache
# stage puts the Chromium binary in its own Docker layer that only re-downloads
# when the base node image changes — so day-to-day builds reuse the cached layer
# and finish in well under 5 minutes. Stage 2 installs only the system
# dependencies (apt libs), never re-downloading the browser.
#
# Browser skills that need this: /qa, /design-review, /benchmark, /s2-e2e-sweep
# (dashboard workflows product-qa / product-design-review / product-benchmark /
# product-e2e-sweep).

# === Stage 1: Playwright cache layer (rarely changes) =======================
FROM node:24-bookworm AS playwright-cache
# Downloads the Chromium binary into /root/.cache/ms-playwright. This whole
# stage is cached and only re-runs when the FROM line (base image) changes.
RUN npx --yes playwright@latest install --with-deps chromium

# === Stage 2: Application ===================================================
FROM node:24-bookworm

# --- existing OpenClaw Dockerfile steps go here (unchanged) -----------------
# WORKDIR /app
# COPY package*.json ./
# RUN npm ci
# COPY . .
# RUN <install gbrain CLI, gstack, etc.>
# ... (keep whatever the current container needs) ...
# ----------------------------------------------------------------------------

# Copy the cached Chromium binary from stage 1 (no re-download).
COPY --from=playwright-cache /root/.cache/ms-playwright /root/.cache/ms-playwright

# Install ONLY the system libraries Chromium needs (fast; no browser download).
RUN npx --yes playwright@latest install-deps chromium

# Playwright looks here for the browser; make it explicit + stable.
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# --- existing CMD / ENTRYPOINT (unchanged) ----------------------------------
# CMD ["..."]

# ============================================================================
# Verify after deploy (on the container):
#   npx playwright --version
#   node -e "require('playwright').chromium.launch().then(b=>b.close()).then(()=>console.log('chromium ok'))"
# Build-time target: under 5 minutes including Playwright (cache hit on stage 1).
