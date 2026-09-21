#!/usr/bin/env node
// Black-box check of the proxy gate in src/server.js.
//
// Starts the REAL src/server.js (nothing is copied or imported from it) with
// OPENCLAW_ENTRY pointed at a dummy "openclaw" that, for `gateway run`, starts a
// tiny HTTP server on INTERNAL_GATEWAY_PORT and records every request it
// receives. Then asserts, over real HTTP/WebSocket-upgrade requests:
//   - no auth / wrong bearer            -> 401, never reaches the gateway
//   - Bearer ACP_TOKEN / Basic password -> proxied, Authorization REPLACED by the gateway token
//   - /healthz, /setup/healthz          -> public (not 401)
//   - /openclaw without auth            -> 401, and the gateway token appears in NO response
//   - /hooks/*                          -> gated too
//   - WebSocket upgrade                 -> same gate
//   - no secret appears in the wrapper's log output
//
// Usage: node scripts/check-server-gate.mjs     (needs `pnpm install` for server.js deps)
// Exit code 0 = all assertions passed.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rand = (n = 16) => crypto.randomBytes(n).toString("hex");

const ACP_TOKEN = `acp-${rand()}`;
const SETUP_PASSWORD = `pw-${rand()}`;
const GATEWAY_TOKEN = `gw-${rand()}`;
const WRONG_TOKEN = `wrong-${rand()}`;
const SECRETS = { ACP_TOKEN, SETUP_PASSWORD, GATEWAY_TOKEN, WRONG_TOKEN };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-check-"));
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n"); // "configured"
const gwLog = path.join(tmp, "gateway-requests.jsonl");
const gwPidFile = path.join(tmp, "gateway.pid");

// Dummy `openclaw` entry. Only `gateway run` does anything.
const dummyEntry = path.join(tmp, "fake-openclaw-entry.mjs");
fs.writeFileSync(
  dummyEntry,
  `
import http from "node:http";
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "gateway" && args[1] === "run") {
  const port = Number(args[args.indexOf("--port") + 1]);
  fs.writeFileSync(${JSON.stringify(gwPidFile)}, String(process.pid));
  const rec = (o) => fs.appendFileSync(${JSON.stringify(gwLog)}, JSON.stringify(o) + "\\n");
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      rec({ kind: "http", method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"dummy":"gateway"}');
    });
  });
  srv.on("upgrade", (req, socket) => {
    rec({ kind: "ws", url: req.url, authorization: req.headers.authorization ?? null });
    socket.end("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  });
  srv.listen(port, "127.0.0.1");
  setTimeout(() => process.exit(0), 120000); // never outlive the check
} else {
  process.exit(0);
}
`,
);

const wrapperPort = await freePort();
const gatewayPort = await freePort();
const base = `http://127.0.0.1:${wrapperPort}`;

const env = { ...process.env };
delete env.RAILWAY_PUBLIC_DOMAIN;
Object.assign(env, {
  PORT: String(wrapperPort),
  INTERNAL_GATEWAY_PORT: String(gatewayPort),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_WORKSPACE_DIR: path.join(tmp, "workspace"),
  OPENCLAW_ENTRY: dummyEntry,
  OPENCLAW_NODE: process.execPath,
  OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
  ACP_TOKEN,
  SETUP_PASSWORD,
});

let wrapperOut = "";
const wrapper = spawn(process.execPath, ["src/server.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
wrapper.stdout.on("data", (d) => (wrapperOut += d));
wrapper.stderr.on("data", (d) => (wrapperOut += d));

function cleanup() {
  try { wrapper.kill(); } catch {}
  try { process.kill(Number(fs.readFileSync(gwPidFile, "utf8"))); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

function req(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function wsUpgrade(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${urlPath}`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), ...headers },
    });
    r.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: "" }); });
    r.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (err) => (err.code === "ECONNRESET" ? resolve({ status: 0, headers: {}, body: "", reset: true }) : reject(err)));
    r.end();
  });
}

const gatewayRecords = () =>
  fs.existsSync(gwLog) ? fs.readFileSync(gwLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const basic = (p) => ({ Authorization: `Basic ${Buffer.from(`admin:${p}`).toString("base64")}` });

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const noToken = (r) => !JSON.stringify(r.headers).includes(GATEWAY_TOKEN) && !r.body.includes(GATEWAY_TOKEN);

try {
  // Wait for the wrapper + dummy gateway.
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const h = await req("GET", "/healthz");
      if (h.status === 200 && JSON.parse(h.body).gateway === "ready") { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error(`wrapper/gateway not ready within 60s. Wrapper output:\n${wrapperOut}`);

  const n0 = gatewayRecords().length; // readiness probes

  let r = await req("GET", "/v1/models");
  check("no-auth GET /v1/models -> 401", r.status === 401, `status=${r.status}`);
  check("401 carries WWW-Authenticate Basic realm=OpenClaw", r.headers["www-authenticate"] === 'Basic realm="OpenClaw"', r.headers["www-authenticate"]);

  r = await req("GET", "/v1/models", bearer(WRONG_TOKEN));
  check("wrong bearer GET /v1/models -> 401", r.status === 401, `status=${r.status}`);

  r = await req("GET", "/v1/models", basic("not-the-password"));
  check("wrong Basic password -> 401", r.status === 401, `status=${r.status}`);

  check("refused requests never reached the gateway", gatewayRecords().length === n0);

  r = await req("GET", "/v1/models", bearer(ACP_TOKEN));
  let last = gatewayRecords().at(-1);
  check("Bearer ACP_TOKEN GET /v1/models -> proxied (200 from dummy)", r.status === 200 && r.body.includes("dummy"), `status=${r.status}`);
  check("gateway saw Authorization replaced by the gateway token", last?.url === "/v1/models" && last?.authorization === `Bearer ${GATEWAY_TOKEN}`);
  check("gateway token not echoed back to the Bearer caller", noToken(r));

  r = await req("GET", "/v1/models", basic(SETUP_PASSWORD));
  last = gatewayRecords().at(-1);
  check("Basic SETUP_PASSWORD GET /v1/models -> proxied", r.status === 200 && last?.authorization === `Bearer ${GATEWAY_TOKEN}`, `status=${r.status}`);

  const payload = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
  r = await req("POST", "/v1/chat/completions", { ...bearer(ACP_TOKEN), "Content-Type": "application/json" }, payload);
  last = gatewayRecords().at(-1);
  check("Bearer POST /v1/chat/completions -> proxied", r.status === 200 && last?.url === "/v1/chat/completions", `status=${r.status}`);
  check("gateway received the POST body intact", last?.body === payload, `got ${JSON.stringify(last?.body ?? null).slice(0, 80)}`);

  r = await req("POST", "/v1/chat/completions", { "Content-Type": "application/json" }, payload);
  check("no-auth POST /v1/chat/completions -> 401", r.status === 401, `status=${r.status}`);

  r = await req("GET", "/healthz");
  check("/healthz is public", r.status === 200, `status=${r.status}`);
  r = await req("GET", "/setup/healthz");
  check("/setup/healthz is public", r.status === 200, `status=${r.status}`);
  r = await req("GET", "/setup/api/status", bearer(ACP_TOKEN));
  check("/setup/api/* does NOT accept the ACP bearer", r.status === 401, `status=${r.status}`);

  // The JSON parser is now mounted on /setup/api only; the wizard must still get
  // a parsed body (400 "Missing channel or code" would mean it did not).
  r = await req("POST", "/setup/api/pairing/approve", { ...basic(SETUP_PASSWORD), "Content-Type": "application/json" }, JSON.stringify({ channel: "telegram", code: "ABC" }));
  check("/setup/api still parses JSON bodies", r.status === 200, `status=${r.status} ${r.body.slice(0, 60)}`);

  r = await req("GET", "/openclaw");
  check("no-auth GET /openclaw -> 401", r.status === 401, `status=${r.status}`);
  check("no-auth /openclaw response contains no gateway token", noToken(r) && !r.headers.location);
  r = await req("GET", "/openclaw", bearer(ACP_TOKEN));
  check("Bearer /openclaw is proxied, NOT redirected to ?token=", r.status === 200 && noToken(r), `status=${r.status}`);
  r = await req("GET", "/openclaw", basic(SETUP_PASSWORD));
  check("Basic /openclaw -> redirect to ?token= (operator browser only)", r.status === 302 && r.headers.location?.startsWith("/openclaw?token="), `status=${r.status}`);

  r = await req("POST", "/hooks/agent", { "Content-Type": "application/json" }, "{}");
  check("no-auth POST /hooks/agent -> 401", r.status === 401, `status=${r.status}`);

  const beforeWs = gatewayRecords().length;
  r = await wsUpgrade("/");
  check("no-auth WebSocket upgrade -> 401", r.status === 401, `status=${r.status}`);
  check("refused upgrade never reached the gateway", gatewayRecords().length === beforeWs);
  r = await wsUpgrade("/", bearer(ACP_TOKEN));
  last = gatewayRecords().at(-1);
  check("Bearer WebSocket upgrade -> proxied (101)", r.status === 101, `status=${r.status}`);
  check("gateway saw WS Authorization replaced by the gateway token", last?.kind === "ws" && last?.authorization === `Bearer ${GATEWAY_TOKEN}`);

  await new Promise((res) => setTimeout(res, 200));
  const refusals = wrapperOut.split("\n").filter((l) => l.includes("[auth] refused"));
  // 7 refused PROXIED requests above: 3x GET /v1/models, POST /v1/chat/completions,
  // GET /openclaw, POST /hooks/agent, WS upgrade. (/setup refusals go through
  // requireSetupAuth, which answers the browser's Basic challenge and does not log.)
  check("each proxied refusal logged exactly one line", refusals.length === 7, `${refusals.length} lines, e.g. ${refusals[0]?.trim()}`);
  const leaked = Object.entries(SECRETS).filter(([, v]) => wrapperOut.includes(v)).map(([k]) => k);
  check("no secret appears in the wrapper log output", leaked.length === 0, leaked.length ? `leaked: ${leaked.join(",")}` : "");
} catch (err) {
  failures++;
  console.error(`ERROR ${err.message}`);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
