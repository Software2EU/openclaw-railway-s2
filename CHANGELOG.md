# Changelog — OpenClaw Railway S2

Running session history for the OpenClaw worker wrapper. Append new entries at the top; never overwrite prior ones.

---

## Overnight consolidation — spec-kit + kb-image-import (P3)

**P3B — kb-image-import is already gone; stale Dockerfile reference removed.** The retired `kb-image-import` skill has no presence in this repo (no `src/skills/` tree; grepped clean). `entrypoint.sh` already actively prunes any copy a persistent volume carried from an old boot — `rm -rf "$WORKSPACE_DIR/skills/kb-image-import"` (line ~285) and strips the `<!-- s2:kb-image-import -->` block from `WORKFLOWS.md` (lines ~286-294). That cleanup stays. The only residue was a misleading Dockerfile comment (lines 67-68) pointing at a non-existent `src/skills/kb-image-import/run.js` — replaced with an accurate note. Comment-only change; no build impact.

**P3A — spec-kit remap lives in the DASHBOARD, not here.** Verify-first finding: the 4 `/speckit.*` phase workflows (`product-specify/plan/tasks/implement`) are translated to gstack/skill commands by the dashboard's `SKILL_FOR_WORKFLOW` registry (`s2-brain-dashboard/src/lib/workflows/acp-chat.ts`), which mapped them to `/speckit.*`. Spec-Kit is NOT installed in this worker — gstack ships a single `/spec` skill — so those dispatches returned an honest "unknown workflow" refusal (VOID). Installing Spec-Kit here was rejected as the higher-risk option: Spec-Kit ships as `specify init` command-scaffolding (a Python/uv tool that writes `.claude/commands/speckit.*.md`), NOT a clean gstack-style skill-folder `git clone` install line like the existing gstack/gbrain steps, and a failed Docker RUN would dark the worker deploy. The lower-risk fix shipped on the dashboard side: remap the 4 workflows to the installed `/spec` skill (pure string-map, reversible, no build change here). No OpenClaw image change required for P3A.

**Lint:** `node -c src/server.js` passes (server.js untouched).

---

## 2026-09-21 — Lock down the gateway proxy; gbrain CLI becomes read-only + dashboard bridge

**CRITICAL — proxy was open to the internet.** `src/server.js` forwarded every unmatched request to the OpenClaw gateway with `Authorization: Bearer <gateway token>` injected, so unauthenticated `GET /v1/models` returned 200 from the public URL, anyone could POST `/v1/chat/completions` (approve-all shell exec), and `/openclaw` redirected any caller to `?token=<gateway token>`.
- Every request that reaches the catch-all proxy AND every non-TUI WebSocket upgrade now needs `Authorization: Bearer <ACP_TOKEN>` (new env, same value the dashboard holds) or Basic `SETUP_PASSWORD`; else 401 `WWW-Authenticate: Basic realm="OpenClaw"`. `/hooks/*` has no exception. Fail closed: unset `ACP_TOKEN` closes the Bearer path.
- One verifier (`verifyCredentials`) replaces the two copies in `requireSetupAuth` / `verifyTuiAuth`; timing-safe (both sides hashed). `/setup` and the TUI stay Basic-only. Failures count against `setupRateLimiter`; one log line per refusal (method, path, ip, reason — no credentials, no query string).
- The `/openclaw?token=` redirect now runs only for a request that passed with Basic `SETUP_PASSWORD`.
- Public, unchanged: `/healthz`, `/setup/healthz`, `/skills`, `/styles.css`.
- **Also fixed (pre-existing, found by the new check):** `express.json()` was mounted globally, so it consumed the body of every proxied JSON POST — on `main` a proxied `POST /v1/chat/completions` reached the dummy gateway with no body and the proxy logged `ECONNRESET`. The parser is now mounted on `/setup/api` only (the four routes that read `req.body`).
- `scripts/check-server-gate.mjs` (`npm run check:gate`) starts the real `server.js` against a dummy gateway and asserts all of the above: 27/27 PASS locally (Windows, Node 24.13.1).

**gbrain CLI replaced.** The heredoc shim in `entrypoint.sh` baked a full-access `GBRAIN_API_KEY` into `/usr/local/bin/gbrain`, targeted port 3131 (gbrain-mcp listens on 8080) and exposed engine write/admin ops. Now `src/gbrain-shim.mjs` (no deps, no secret in the file) is installed there:
- Reads (`get_page`, `search`, `query`, `backlinks`, `links`, `timeline`, `list`, `versions`, `stats`, `health`, `list-tools`; hyphen aliases) → gbrain-mcp `POST /mcp` with a read-only OAuth client-credentials token (`scope=read`, cached 0600 per uid, refreshed <60s before expiry or on 401). Credentials from `/etc/s2/gbrain-read.json` (0640 root:openclaw), written at boot from `GBRAIN_CLIENT_ID`/`GBRAIN_CLIENT_SECRET` (+ `GBRAIN_MCP_PORT`, default 8080).
- Writes (`put_page`, `phase-result`, `put-raw`, `get-raw`) → the dashboard bridge (`--bridge/--grant` or `S2_BRIDGE`/`S2_GRANT`). `put-raw` streams the file to the signed upload URL and prints only the stored path.
- Removed: `dream`, `delete`, `add-timeline`, `doctor`, `orphans`, `think`, `jobs` (exit 1, "not available"). **The M/W/F `gbrain dream` cron, if still configured in the volume, will now fail** — the cycle must be enqueued from the dashboard.

**Entrypoint:** FATAL boot refusal if `DATABASE_URL` or `GBRAIN_DATABASE_URL` is non-empty; warning if the obsolete `GBRAIN_API_KEY` is set.

**Workflows** (`src/workflows/*.md`): `gbrain get_page "${project_slug}"` (no double `content/`), inputs via the signed URLs in the dispatch prompt (no `pptx_ref`/`recording_ref`/`get-raw-data`), outputs via `put-raw` + `phase-result --set <key>_path(s)=…` (keys listed per workflow, matching the dashboard bridge's `phaseResultFrontmatter` rule — `recording_path`/`pptx_path` are inputs and are not set), failures via `phase-result --failed`, demo_asset page via `put_page "demos/<project tail>"`.

Env now needed: `SETUP_PASSWORD`, `ACP_TOKEN`, `GBRAIN_CLIENT_ID`, `GBRAIN_CLIENT_SECRET` (optional `GBRAIN_MCP_PORT`). Obsolete: `GBRAIN_API_KEY`. Must be removed: `DATABASE_URL`, `GBRAIN_DATABASE_URL`. Not deployed in this change.
