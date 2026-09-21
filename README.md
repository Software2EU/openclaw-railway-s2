# OpenClaw Railway Template

Deploy OpenClaw on Railway with a browser-first setup flow. No SSH required for onboarding.

IF YOU ARE UPGRADING FROM A PREVIOW VERSION REMOVE THE ENV VAR 'OPENCLAW_ENTRY' AS NOW OPENCLAW IS INSTALLED VIA NPM

## Read This First

This template exposes your OpenClaw gateway to the public internet.

- Review OpenClaw security guidance: <https://docs.openclaw.ai/gateway/security>
- Use a strong `SETUP_PASSWORD`
- If you only use chat channels, consider disabling public networking after setup

## What You Get

- OpenClaw Gateway + Control UI at `/` and `/openclaw`
- Setup Wizard at `/setup` (Basic auth protected)
- Optional browser TUI at `/tui`
- Persistent state on Railway volume (`/data`)
- Health endpoint at `/healthz`
- Diagnostics and logs via setup tools + `/logs`

## Quick Start (Railway)

1. Deploy this template to Railway.
2. Ensure a volume is mounted at `/data`.
3. Set variables:
   - `SETUP_PASSWORD` (required)
   - `OPENCLAW_STATE_DIR=/data/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace`
   - Optional: `ENABLE_WEB_TUI=true`
4. Open `https://<your-domain>/setup` and complete onboarding.
5. Open `https://<your-domain>/openclaw` from the setup page.

## Environment Variables

### Required

- `SETUP_PASSWORD`: password for `/setup`, the TUI and the Control UI (Basic auth)
- `ACP_TOKEN`: the bearer the S2 dashboard sends (`Authorization: Bearer <ACP_TOKEN>`).
  Every request that is proxied to the gateway (HTTP and WebSocket, including
  `/v1/*`, `/openclaw` and `/hooks/*`) must carry this bearer or Basic
  `SETUP_PASSWORD`; anything else gets 401. Unset = the Bearer path is closed.
- `GBRAIN_CLIENT_ID` / `GBRAIN_CLIENT_SECRET`: read-only gbrain-mcp OAuth client
  for the `gbrain` CLI. The entrypoint writes them to `/etc/s2/gbrain-read.json`.

### Must NOT be set

- `DATABASE_URL`, `GBRAIN_DATABASE_URL`: the entrypoint refuses to boot if either
  is non-empty. Brain writes go through the dashboard bridge only.
- `GBRAIN_API_KEY`: obsolete and unused (logged as a warning if present).

### Recommended

- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_GATEWAY_TOKEN` (stable token across redeploys)

### Optional

- `PORT=8080`
- `INTERNAL_GATEWAY_PORT=18789`
- `INTERNAL_GATEWAY_HOST=127.0.0.1`
- `ENABLE_WEB_TUI=false`
- `TUI_IDLE_TIMEOUT_MS=300000`
- `TUI_MAX_SESSION_MS=1800000`
- `GBRAIN_MCP_PORT=8080` (gbrain-mcp's internal port; written into `/etc/s2/gbrain-read.json`)

## Day-1 Setup Checklist

- Confirm `/setup` loads and accepts password
- Run onboarding once
- Verify `/healthz` returns `{ "ok": true, ... }`
- Open `/openclaw` via setup link
- If using Telegram/Discord, approve pending devices from setup tools

## Chat Token Prep

### Telegram

1. Message `@BotFather`
2. Run `/newbot`
3. Copy bot token (looks like `123456789:AA...`)
4. Paste into setup wizard

### Discord

1. Create app in Discord Developer Portal
2. Add bot + copy bot token
3. Invite bot to server (`bot`, `applications.commands` scopes)
4. Enable required intents for your use case

## Web TUI (`/tui`)

Disabled by default. Set `ENABLE_WEB_TUI=true` to enable.

Built-in safeguards:

- Protected by `SETUP_PASSWORD`
- Single active session
- Idle timeout
- Max session duration

## Local Smoke Test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -e ENABLE_WEB_TUI=true \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template
```

- Setup: `http://localhost:8080/setup` (password: `test`)
- UI: `http://localhost:8080/openclaw`
- TUI: `http://localhost:8080/tui`

## Troubleshooting

### Control UI says disconnected / auth error

- Open `/setup` first, then click the OpenClaw UI link from there.
- Approve pending devices in setup if pairing is required.

### 502 / gateway unavailable

- Check `/healthz`
- Run doctor from setup (`openclaw doctor --repair`)
- Verify `/data` volume is mounted and writable

### Setup keeps resetting after redeploy

- `OPENCLAW_STATE_DIR` or `OPENCLAW_WORKSPACE_DIR` is not on `/data`
- Fix both vars and redeploy

### TUI not visible

- Set `ENABLE_WEB_TUI=true`
- Redeploy and reload `/setup`

## Useful Endpoints

- `/setup` - onboarding + management
- `/openclaw` - Control UI (Basic `SETUP_PASSWORD`)
- `/healthz`, `/setup/healthz`, `/skills` - public health / status (no auth)
- `/logs` - live server logs UI

## Brain access from this container (S2)

The `gbrain` command in this container (`src/gbrain-shim.mjs`, installed to
`/usr/local/bin/gbrain`) is **read-only against the engine** and routes every
write through the S2 dashboard's bridge:

- Reads (`get_page`, `search`, `query`, `backlinks`, `links`, `timeline`,
  `list`, `versions`, `stats`, `health`, `list-tools`) call gbrain-mcp on
  `gbrain-mcp.railway.internal:8080` with a read-only OAuth client credential.
- Writes (`put_page`, `phase-result`, `put-raw`, `get-raw`) call the dashboard
  bridge with `--bridge <url> --grant <token>` (or `S2_BRIDGE`/`S2_GRANT`), both
  supplied by the dispatch prompt.
- `dream`, `delete`, `add-timeline`, `doctor`, `orphans`, `think`, `jobs` are
  REMOVED and exit 1 with "not available".

## Scheduled jobs (S2 Brain context)

This container previously scheduled the dream/autopilot cycle with a cron
running `gbrain dream` M/W/F 22:00 UTC (it enqueued `submit_job
{name: "autopilot-cycle"}` on gbrain-mcp). **`gbrain dream` no longer exists
here** — enqueueing a job is an admin op and this container now holds only a
read-only credential. If that cron is still configured in the OpenClaw volume it
will fail with "not available"; the cycle must be enqueued from the dashboard
(`triggerDreamCycle`, `s2-brain-dashboard/src/lib/brain/dream-cycle.ts`), which
owns the canonical `DREAM_PHASES`.

Execution happens in the **gbrain-mcp** container (`gbrain jobs work`, started
by that image's `entrypoint.sh`). OpenClaw runs zero minion-job consumers; do
not add a `gbrain jobs work` to this container — that would race the gbrain-mcp
worker for the same row.

## Support

Need help? Open an issue or use Railway Station support for this template.
