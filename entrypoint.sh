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
const http=require('http'),fs=require('fs'),args=process.argv.slice(2),cmd=args[0],slug=args[1];
const opts={hostname:'gbrain-mcp.railway.internal',port:3131,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer gbrain_5d9b1e7e83b44b4f8ec1c813eacd99888868675ef27b3661334bfa414be55709'}};
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

exec tini -- gosu openclaw node src/server.js
