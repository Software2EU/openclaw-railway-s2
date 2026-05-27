#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# Kill any stale gateway from a previous container lifecycle
pkill -f openclaw-gateway 2>/dev/null || true
sleep 1

# Install gbrain CLI shim (calls GBrain MCP via HTTP)
cat > /usr/local/bin/gbrain << 'GBRAIN_SHIM'
#!/usr/bin/env node
const http = require('http');
const args = process.argv.slice(2);
const cmd = args[0];
const slug = args[1];
const opts = {
  hostname: 'gbrain-mcp.railway.internal',
  port: 3131,
  path: '/mcp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer gbrain_5d9b1e7e83b44b4f8ec1c813eacd99888868675ef27b3661334bfa414be55709'
  }
};
let body;
if (cmd === 'get_page') {
  body = JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'get_page',arguments:{slug}},id:1});
} else if (cmd === 'put_page') {
  const content = require('fs').readFileSync(args[2],'utf8');
  const summary = args[3] || slug;
  body = JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'put_page',arguments:{slug,content,summary}},id:1});
} else if (cmd === 'search') {
  body = JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'query',arguments:{question:slug,limit:5}},id:1});
} else {
  console.log('Usage: gbrain get_page <slug> | put_page <slug> <file> [summary] | search <query>');
  process.exit(1);
}
const req = http.request(opts, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => console.log(data));
});
req.write(body);
req.end();
GBRAIN_SHIM
chmod +x /usr/local/bin/gbrain

exec tini -- gosu openclaw node src/server.js
