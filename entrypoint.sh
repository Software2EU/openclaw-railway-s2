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

# --- Skill preflight: FAIL LOUDLY if GStack skills are not installed ---------
# The dashboard dispatches named skills (product-review, qa, ...). If the image
# was built without GStack (the bug this commit fixes), the worker must NOT
# silently improvise a "review" — it surfaces an explicit, machine-detectable
# error (skills-status.json + non-zero exit) so the dashboard can react.
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-/home/openclaw/.claude/skills}"
REQUIRED_SKILLS="${REQUIRED_SKILLS:-gstack}"
SKILLS_STATUS="$STATE_DIR/skills-status.json"
mkdir -p "$STATE_DIR"
missing=""
for s in $REQUIRED_SKILLS; do
  [ -e "$SKILLS_DIR/$s" ] || missing="$missing $s"
done
installed="$(ls -1 "$SKILLS_DIR" 2>/dev/null | paste -sd, - || true)"
missing="$(echo $missing | xargs || true)"
if [ -n "$missing" ]; then
  printf '{"ok":false,"error":"SKILLS_NOT_INSTALLED","missing":"%s","installed":"%s","skillsDir":"%s"}\n' \
    "$missing" "$installed" "$SKILLS_DIR" > "$SKILLS_STATUS"
  chown openclaw:openclaw "$SKILLS_STATUS" 2>/dev/null || true
  echo "========================================================================" >&2
  echo "[skills] FATAL: required GStack skill(s) NOT installed: $missing" >&2
  echo "[skills] scanned $SKILLS_DIR (found: ${installed:-none})" >&2
  echo "[skills] The worker refuses to improvise reviews. Rebuild the image with" >&2
  echo "[skills] the GStack install (see Dockerfile) before dispatching skills." >&2
  echo "========================================================================" >&2
  if [ "${REQUIRE_SKILLS:-1}" = "1" ]; then
    echo "[skills] REQUIRE_SKILLS=1 -> refusing to start (set REQUIRE_SKILLS=0 to override)" >&2
    exit 1
  fi
else
  printf '{"ok":true,"installed":"%s","skillsDir":"%s"}\n' "$installed" "$SKILLS_DIR" > "$SKILLS_STATUS"
  chown openclaw:openclaw "$SKILLS_STATUS" 2>/dev/null || true
  echo "[skills] OK -> installed: $installed"
fi

exec tini -- gosu openclaw node src/server.js
