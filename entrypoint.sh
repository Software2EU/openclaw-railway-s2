#!/bin/bash
set -e

STATE_DIR=/data/.openclaw

chown -R openclaw:openclaw /data
chmod 700 /data
if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi
rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# Kill any stale gateway + lock from a previous container lifecycle
pkill -f openclaw-gateway 2>/dev/null || true
rm -f "$STATE_DIR"/*.lock 2>/dev/null || true
sleep 1

# --- Apply secrets from env vars on every boot (idempotent) ---
# Anthropic key -> both agents' auth-profiles.json (rotation = redeploy, no SSH)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  for agent in main dashboard; do
    f="$STATE_DIR/agents/$agent/agent/auth-profiles.json"
    if [ -f "$f" ]; then
      sed -i "s|\"key\": \"sk-ant-[^\"]*\"|\"key\": \"$ANTHROPIC_API_KEY\"|" "$f"
    fi
  done
fi

# Gateway token -> openclaw.json (deterministic token = no re-pairing after redeploy)
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  gosu openclaw openclaw config set gateway.auth.token "$OPENCLAW_GATEWAY_TOKEN" || true
fi

# Re-normalize ownership: sed above ran as root and may have re-owned files
chown -R openclaw:openclaw /data

# Install gbrain CLI shim (calls GBrain MCP via HTTP)
# GBRAIN_API_KEY must be set as a Railway environment variable on this service
cat > /usr/local/bin/gbrain << GBRAIN_SHIM
#!/usr/bin/env node
const http=require('http'),fs=require('fs'),args=process.argv.slice(2),cmd=args[0],slug=args[1];
const opts={hostname:'gbrain-mcp.railway.internal',port:3131,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer ${GBRAIN_API_KEY}'}};
const call=(name,a={})=>JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:a},id:1});
const cmds={
  get_page:()=>call('get_page',{slug}),
  put_page:()=>call('put_page',{slug,content:fs.readFileSync(args[2],'utf8')}),
  search:()=>call('search',{query:slug,limit:10}),
  query:()=>call('query',{query:slug,limit:10}),
  dream:()=>call('submit_job',{name:'autopilot-cycle',data:{}}),
  doctor:()=>call('run_doctor'),
  orphans:()=>call('find_orphans'),
  backlinks:()=>call('get_backlinks',{slug}),
  health:()=>call('get_health'),
  stats:()=>call('get_stats'),
  links:()=>call('get_links',{slug}),
  timeline:()=>call('get_timeline',{slug}),
  'add-timeline':()=>call('add_timeline_entry',{slug,date:args[2],summary:args[3]}),
  think:()=>call('think',{question:slug}),
  'list-tools':()=>JSON.stringify({jsonrpc:'2.0',method:'tools/list',params:{},id:1}),
  delete:()=>call('delete_page',{slug}),
  list:()=>call('list_pages',{type:slug,limit:50}),
  versions:()=>call('get_versions',{slug}),
  jobs:()=>call('list_jobs',{limit:20}),
};
if(!cmds[cmd]){console.log('Commands: '+Object.keys(cmds).join(', '));process.exit(1);}
const req=http.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d));});
req.write(cmds[cmd]());req.end();
GBRAIN_SHIM
chmod +x /usr/local/bin/gbrain

# --- Git auth for non-interactive clone/push --------------------------------
# The Railway service injects S2_GITHUB_TOKEN, but the docs/tooling historically
# expect GITHUB_TOKEN, and nothing was wiring it into git — so authenticated
# clone/push silently failed. Accept either (prefer S2_GITHUB_TOKEN), normalize
# both env names, and configure git for the openclaw user via a store credential
# helper + url.insteadOf so https clones work and ssh remotes are rewritten.
GH_TOKEN="${S2_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -n "$GH_TOKEN" ]; then
  export GITHUB_TOKEN="$GH_TOKEN"
  export S2_GITHUB_TOKEN="$GH_TOKEN"
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > /home/openclaw/.git-credentials
  chown openclaw:openclaw /home/openclaw/.git-credentials
  chmod 600 /home/openclaw/.git-credentials
  gosu openclaw git config --global credential.helper store
  gosu openclaw git config --global url."https://github.com/".insteadOf "git@github.com:"
  gosu openclaw git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
  echo "[git-auth] configured github.com credentials for openclaw user"
else
  echo "[git-auth] WARNING: no S2_GITHUB_TOKEN/GITHUB_TOKEN set -> git clone/push will be unauthenticated" >&2
fi

# --- Wire the gstack "Coding Tasks" dispatch section into AGENTS.md ----------
# OpenClaw runs gstack skills by spawning a Claude Code session over ACP. The
# orchestrator only does that if its AGENTS.md tells it to ("Always spawn, never
# redirect"). Without it the gateway agent answers inline and improvises. We
# vendor gstack's ready-to-paste section and inject it idempotently (replacing
# any previous copy between the markers) into the agent + workspace AGENTS.md.
SECTION_FILE=/app/gstack/agents-gstack-section.md
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
apply_agents_section() {
  target="$1"
  [ -f "$SECTION_FILE" ] || return 0
  mkdir -p "$(dirname "$target")"
  [ -f "$target" ] || : > "$target"
  awk '
    index($0,"<!-- gstack:coding-tasks -->"){skip=1}
    skip==0{print}
    index($0,"<!-- /gstack:coding-tasks -->"){skip=0}
  ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"
  printf '\n' >> "$target"
  cat "$SECTION_FILE" >> "$target"
  chown openclaw:openclaw "$target" 2>/dev/null || true
  echo "[agents] wired gstack Coding Tasks section into $target"
}
apply_agents_section "$WORKSPACE_DIR/AGENTS.md"
for d in "$STATE_DIR"/agents/*/; do
  [ -d "$d" ] && apply_agents_section "${d%/}/AGENTS.md"
done

# --- Skill preflight: FAIL LOUDLY unless Claude Code + real gstack skills exist
# gstack skills are Claude Code skills run via ACP. The worker is only able to
# run a real skill if BOTH (a) `claude` resolves on PATH and (b) gstack actually
# registered the named skills (each <skill>/SKILL.md exists). If either is
# missing the worker must NOT improvise — it writes a machine-detectable error
# (skills-status.json -> /skills 503) and, by default, refuses to start.
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-/home/openclaw/.claude/skills}"
REQUIRED_SKILLS="${REQUIRED_SKILLS:-review cso ship}"
SKILLS_STATUS="$STATE_DIR/skills-status.json"
mkdir -p "$STATE_DIR"

CLAUDE_BIN="$(gosu openclaw sh -lc 'command -v claude' 2>/dev/null || true)"
CLAUDE_VERSION="$(gosu openclaw sh -lc 'claude --version' 2>/dev/null | head -1 || true)"

missing=""
for s in $REQUIRED_SKILLS; do
  # -f follows symlinks: gstack registers each skill as a symlink into the repo.
  [ -f "$SKILLS_DIR/$s/SKILL.md" ] || missing="$missing $s"
done
installed="$(ls -1 "$SKILLS_DIR" 2>/dev/null | paste -sd, - || true)"
missing="$(echo $missing | xargs || true)"

fail=0
[ -z "$CLAUDE_BIN" ] && fail=1
[ -n "$missing" ] && fail=1

if [ "$fail" -eq 1 ]; then
  printf '{"ok":false,"error":"SKILLS_NOT_INSTALLED","claude":%s,"claudeVersion":"%s","missing":"%s","installed":"%s","skillsDir":"%s"}\n' \
    "$([ -n "$CLAUDE_BIN" ] && echo true || echo false)" "$CLAUDE_VERSION" \
    "$missing" "$installed" "$SKILLS_DIR" > "$SKILLS_STATUS"
  chown openclaw:openclaw "$SKILLS_STATUS" 2>/dev/null || true
  echo "========================================================================" >&2
  [ -z "$CLAUDE_BIN" ] && echo "[skills] FATAL: Claude Code (\`claude\`) not on PATH — nothing to spawn." >&2
  [ -n "$missing" ] && echo "[skills] FATAL: gstack did not register skill(s): $missing" >&2
  echo "[skills] scanned $SKILLS_DIR (found: ${installed:-none})" >&2
  echo "[skills] The worker refuses to improvise. Rebuild the image so Claude Code" >&2
  echo "[skills] is installed and 'gstack ./setup' registers the skills." >&2
  echo "========================================================================" >&2
  if [ "${REQUIRE_SKILLS:-1}" = "1" ]; then
    echo "[skills] REQUIRE_SKILLS=1 -> refusing to start (set REQUIRE_SKILLS=0 to override)" >&2
    exit 1
  fi
else
  printf '{"ok":true,"claude":true,"claudeVersion":"%s","installed":"%s","skillsDir":"%s"}\n' \
    "$CLAUDE_VERSION" "$installed" "$SKILLS_DIR" > "$SKILLS_STATUS"
  chown openclaw:openclaw "$SKILLS_STATUS" 2>/dev/null || true
  echo "[skills] OK -> claude: $CLAUDE_VERSION | skills: $installed"
fi

# --- acpx session pre-init (fixes "session/load -> Resource not found" race) --
# A dispatched gstack turn runs `acpx claude` with cwd set to the repo being
# reviewed. acpx resolves a session by walking UP from cwd to the *git repo
# root* and matching a record whose cwd EXACTLY equals a level in that walk
# (matchesSessionEntry: session.cwd === dir). Creating a session also spawns
# claude + does session/new over ACP — so the FIRST dispatch races session/load
# against a not-yet-created session and fails with "Resource not found".
#
# Because the walk boundary is the git root, a session at the /data/workspace
# PARENT does NOT cover a child repo like /data/workspace/zwergalpost (its own
# git root). So we pre-create PER-REPO (Option B): `sessions ensure` (idempotent,
# "current cwd or ancestor") for /data/workspace itself AND for every git repo
# directly under it. Runs as the openclaw user, after the gateway is up.
# acpx is not on PATH; use its full path. Best-effort (|| true) throughout.
#
# Residual gap: repos cloned *during* a session (not present at boot) still race
# on their first dispatch — the durable fix for those is for the dispatch to run
# `sessions ensure` in its own cwd before the turn (OpenClaw-side, out of scope).
(
  set +e  # best-effort: a failed health poll must never abort the pre-init
  ACPX=/usr/local/lib/node_modules/openclaw/extensions/acpx/node_modules/.bin/acpx
  [ -x "$ACPX" ] || exit 0
  # Wait (bounded) for the wrapper to report the gateway is running.
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${PORT:-8080}/setup/healthz" 2>/dev/null \
      | grep -q '"gatewayRunning":true' && break
    sleep 5
  done
  ensure_session() {
    d="$1"
    [ -d "$d" ] || return 0
    echo "[acpx] ensuring claude session for cwd=$d"
    gosu openclaw sh -lc 'cd "$1" && exec "$2" claude sessions ensure' _ "$d" "$ACPX" \
      >/dev/null 2>&1 || true
  }
  ensure_session "$WORKSPACE_DIR"
  for repo in "$WORKSPACE_DIR"/*/; do
    [ -e "${repo}.git" ] && ensure_session "${repo%/}"
  done
  echo "[acpx] session pre-init complete"
) &

exec tini -- gosu openclaw node src/server.js
