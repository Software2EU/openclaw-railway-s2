#!/usr/bin/env node
// gbrain — the OpenClaw container's brain CLI (installed to /usr/local/bin/gbrain
// by entrypoint.sh). No dependencies, no secret baked into this file.
//
// READS go to the gbrain-mcp engine with a READ-ONLY OAuth client credential
// (client_credentials, scope=read) read from /etc/s2/gbrain-read.json, which the
// entrypoint writes at boot from GBRAIN_CLIENT_ID / GBRAIN_CLIENT_SECRET.
//
// WRITES never touch the engine. They go to the S2 dashboard's bridge, which runs
// them through the dashboard's single write pipeline. Each write needs the
// bridge URL and a per-dispatch grant: --bridge <url> --grant <token>, or env
// S2_BRIDGE / S2_GRANT (flags win). The dispatch prompt supplies both.
//
// Admin / mutation ops the old shim exposed against the engine (dream, delete,
// add-timeline, doctor, orphans, think, jobs) are REMOVED on purpose.
//
// Portability: this file is installed WITHOUT its .mjs extension, so it avoids
// import/require/top-level-await entirely and loads builtins through
// process.getBuiltinModule — it parses identically as CommonJS or as ESM.

const fs = process.getBuiltinModule("node:fs");
const os = process.getBuiltinModule("node:os");
const path = process.getBuiltinModule("node:path");
const http = process.getBuiltinModule("node:http");
const https = process.getBuiltinModule("node:https");
const crypto = process.getBuiltinModule("node:crypto");
const { pipeline } = process.getBuiltinModule("node:stream/promises");

const CONFIG_PATH = process.env.GBRAIN_READ_CONFIG || "/etc/s2/gbrain-read.json";
const ENGINE_HOST = "gbrain-mcp.railway.internal";

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set(["bridge", "grant", "set", "failed", "name"]);

function parseArgs(argv) {
  const positional = [];
  const flags = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (!VALUE_FLAGS.has(key)) fail(`unknown flag --${key}`);
      if (value === undefined) {
        if (i + 1 >= argv.length) fail(`--${key} needs a value`);
        value = argv[++i];
      }
      if (key === "set") flags.set.push(value);
      else flags[key] = value;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// HTTP (node:http/https so uploads/downloads stream with a real Content-Length)
// ---------------------------------------------------------------------------
function describeTarget(u) {
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.hostname}:${port}`;
}

function networkError(u, err) {
  const code = err?.code || err?.cause?.code || err?.message || "unknown";
  return new CliError(`cannot reach ${describeTarget(u)} (${code})`);
}

/**
 * request(url, { method, headers, body, bodyFile, outFile })
 * - body: string/Buffer; bodyFile: path streamed as the request body
 * - outFile: stream a 2xx response body to this path instead of buffering
 * Resolves { status, headers, text } (text empty when outFile is used).
 */
function request(urlString, opts = {}, redirects = 0) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return Promise.reject(new CliError(`invalid URL: ${urlString}`));
  }
  const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
  if (!mod) return Promise.reject(new CliError(`unsupported URL scheme: ${u.protocol}`));

  const headers = { ...(opts.headers || {}) };
  let size = null;
  if (opts.bodyFile) {
    size = fs.statSync(opts.bodyFile).size;
    headers["Content-Length"] = String(size);
  } else if (opts.body != null) {
    headers["Content-Length"] = String(Buffer.byteLength(opts.body));
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: opts.method || "GET", headers }, (res) => {
      const status = res.statusCode || 0;
      if (
        opts.outFile &&
        [301, 302, 303, 307, 308].includes(status) &&
        res.headers.location &&
        redirects < 5
      ) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        resolve(request(next, { ...opts, method: "GET", body: undefined, bodyFile: undefined }, redirects + 1));
        return;
      }
      if (opts.outFile && status >= 200 && status < 300) {
        pipeline(res, fs.createWriteStream(opts.outFile)).then(
          () => resolve({ status, headers: res.headers, text: "" }),
          (err) => reject(new CliError(`download to ${opts.outFile} failed (${err.code || err.message})`)),
        );
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", (err) => reject(networkError(u, err)));
    });
    req.on("error", (err) => reject(networkError(u, err)));
    req.setTimeout(opts.timeoutMs ?? 120_000, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    if (opts.bodyFile) {
      pipeline(fs.createReadStream(opts.bodyFile), req).catch((err) =>
        reject(new CliError(`upload of ${opts.bodyFile} failed (${err.code || err.message})`)),
      );
    } else {
      if (opts.body != null) req.write(opts.body);
      req.end();
    }
  });
}

// ---------------------------------------------------------------------------
// READS — engine, read-only OAuth client credential
// ---------------------------------------------------------------------------
function loadReadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    fail(
      `GBRAIN_READ_CONFIG_MISSING: cannot read ${CONFIG_PATH} (${err.code || err.message}). ` +
        "The entrypoint writes it at boot from GBRAIN_CLIENT_ID + GBRAIN_CLIENT_SECRET; " +
        "one of them is unset on this service, or this is not the OpenClaw container.",
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    fail(`GBRAIN_READ_CONFIG_INVALID: ${CONFIG_PATH} is not valid JSON`);
  }
  if (!cfg?.client_id || !cfg?.client_secret) {
    fail(`GBRAIN_READ_CONFIG_INVALID: ${CONFIG_PATH} lacks client_id/client_secret`);
  }
  const port = Number(cfg.port) || 8080;
  return { ...cfg, base: `http://${ENGINE_HOST}:${port}` };
}

function tokenCachePath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const home = os.homedir();
  const dir = home ? path.join(home, ".cache", "s2-gbrain") : os.tmpdir();
  return { dir, file: path.join(dir, `token-${uid}.json`), fallback: path.join(os.tmpdir(), `s2-gbrain-token-${uid}.json`) };
}

function clientKey(cfg) {
  return crypto.createHash("sha256").update(`${cfg.base}|${cfg.client_id}`).digest("hex").slice(0, 16);
}

function readCachedToken(cfg) {
  const { file, fallback } = tokenCachePath();
  for (const f of [file, fallback]) {
    try {
      const t = JSON.parse(fs.readFileSync(f, "utf8"));
      if (t.key === clientKey(cfg) && t.access_token && t.expires_at - Date.now() > 60_000) {
        return t.access_token;
      }
    } catch {}
  }
  return null;
}

function writeCachedToken(cfg, accessToken, expiresInSec) {
  const entry = JSON.stringify({
    key: clientKey(cfg),
    access_token: accessToken,
    expires_at: Date.now() + (Number(expiresInSec) || 3600) * 1000,
  });
  const { dir, file, fallback } = tokenCachePath();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, entry, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return;
  } catch {}
  try {
    fs.writeFileSync(fallback, entry, { mode: 0o600 });
    fs.chmodSync(fallback, 0o600);
  } catch {} // cache is an optimisation; a failed write only costs a /token call
}

async function fetchToken(cfg) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    scope: "read",
  }).toString();
  const res = await request(`${cfg.base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {}
  if (res.status < 200 || res.status >= 300 || !json?.access_token) {
    const detail = json?.error_description || json?.error || res.text.slice(0, 200);
    fail(`GBRAIN_TOKEN_REFUSED: POST /token returned ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  writeCachedToken(cfg, json.access_token, json.expires_in);
  return json.access_token;
}

// The engine may answer as SSE; the JSON-RPC payload is in the data: lines.
function unwrapRpcBody(text, contentType) {
  if (!String(contentType || "").includes("text/event-stream")) return text;
  const data = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  return data.length ? data.join("\n") : text;
}

async function engineCall(payload) {
  const cfg = loadReadConfig();
  let token = readCachedToken(cfg) || (await fetchToken(cfg));
  const send = (tok) =>
    request(`${cfg.base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify(payload),
    });
  let res = await send(token);
  if (res.status === 401) {
    token = await fetchToken(cfg);
    res = await send(token);
  }
  const out = unwrapRpcBody(res.text, res.headers["content-type"]);
  if (res.status < 200 || res.status >= 300) {
    fail(`GBRAIN_ENGINE_ERROR: ${payload.params?.name || payload.method} returned HTTP ${res.status}: ${out.slice(0, 500)}`);
  }
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  try {
    const j = JSON.parse(out);
    if (j.error || j.result?.isError) process.exitCode = 1;
  } catch {}
}

const rpc = (name, args = {}) => ({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name, arguments: args },
  id: 1,
});

function need(value, what, usage) {
  if (value == null || value === "") fail(`missing ${what}. Usage: ${usage}`);
  return value;
}

const READS = {
  get_page: (p) => rpc("get_page", { slug: need(p[0], "<slug>", "gbrain get_page <slug>") }),
  search: (p) => rpc("search", { query: need(p.join(" "), "<query>", "gbrain search <query>"), limit: 10 }),
  query: (p) => rpc("query", { query: need(p.join(" "), "<query>", "gbrain query <query>"), limit: 10 }),
  backlinks: (p) => rpc("get_backlinks", { slug: need(p[0], "<slug>", "gbrain backlinks <slug>") }),
  links: (p) => rpc("get_links", { slug: need(p[0], "<slug>", "gbrain links <slug>") }),
  timeline: (p) => rpc("get_timeline", { slug: need(p[0], "<slug>", "gbrain timeline <slug>") }),
  list: (p) => rpc("list_pages", p[0] ? { type: p[0], limit: 50 } : { limit: 50 }),
  versions: (p) => rpc("get_versions", { slug: need(p[0], "<slug>", "gbrain versions <slug>") }),
  stats: () => rpc("get_stats"),
  health: () => rpc("get_health"),
  "list-tools": () => ({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
};

// ---------------------------------------------------------------------------
// WRITES — the dashboard bridge
// ---------------------------------------------------------------------------
function bridgeContext(flags) {
  const bridge = flags.bridge || process.env.S2_BRIDGE || "";
  const grant = flags.grant || process.env.S2_GRANT || "";
  const missing = [];
  if (!bridge) missing.push("bridge URL (--bridge <url> or S2_BRIDGE)");
  if (!grant) missing.push("grant (--grant <token> or S2_GRANT)");
  if (missing.length) {
    fail(`BRIDGE_NOT_CONFIGURED: missing ${missing.join(" and ")}. The dispatch prompt supplies both; pass them on every write.`);
  }
  return { bridge: bridge.replace(/\/+$/, ""), grant };
}

async function bridgeCall(ctx, route, body) {
  const res = await request(`${ctx.bridge}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${ctx.grant}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {}
  const ok = res.status >= 200 && res.status < 300 && json && json.ok !== false;
  return { ok, status: res.status, json, text: res.text };
}

function bridgeFailure(route, r) {
  const detail = r.json ? JSON.stringify(r.json) : r.text.slice(0, 500);
  return new CliError(`BRIDGE_REFUSED: POST ${route} returned HTTP ${r.status}: ${detail}`);
}

function readFileOrFail(file, usage) {
  need(file, "<file>", usage);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read ${file} (${err.code || err.message})`);
  }
}

const CONTENT_TYPES = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  json: "application/json",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessContentType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

async function putPage(p, flags) {
  const usage = "gbrain put_page <slug> <file> --bridge <url> --grant <token>";
  const slug = need(p[0], "<slug>", usage);
  const markdown = readFileOrFail(p[1], usage);
  const ctx = bridgeContext(flags);
  const r = await bridgeCall(ctx, "/page", { slug, markdown });
  if (!r.ok) throw bridgeFailure("/page", r);
  console.log(JSON.stringify(r.json));
}

// One status line for the operator watching the project page ("Aufnahme
// läuft"). BEST-EFFORT by design: a refused or failed status line prints a
// warning and exits 0 — losing a status line must never stop a run that is
// otherwise working. Usage errors (no slug/message/grant) still fail loudly.
async function progress(p, flags) {
  const usage = 'gbrain progress <slug> "<one line: what you are doing now>" --bridge <url> --grant <token>';
  const slug = need(p[0], "<slug>", usage);
  const message = need(p.slice(1).join(" ").trim(), "<message>", usage);
  const ctx = bridgeContext(flags);
  try {
    const r = await bridgeCall(ctx, "/progress", { slug, message });
    if (!r.ok) {
      console.error(`gbrain: progress not recorded (${r.status}): ${JSON.stringify(r.json ?? {})} — continuing`);
      return;
    }
    console.log(JSON.stringify(r.json));
  } catch (e) {
    console.error(`gbrain: progress not recorded (${e && e.message ? e.message : e}) — continuing`);
  }
}

async function phaseResult(p, flags) {
  const usage =
    'gbrain phase-result <slug> <file> [--set key=value]... | gbrain phase-result <slug> --failed "<reason>"  (+ --bridge <url> --grant <token>)';
  const slug = need(p[0], "<slug>", usage);
  const body = { slug };
  if (flags.failed != null) {
    if (!String(flags.failed).trim()) fail(`--failed needs a concrete reason. Usage: ${usage}`);
    body.failed = flags.failed;
    if (p[1]) body.body = readFileOrFail(p[1], usage);
  } else {
    body.body = readFileOrFail(p[1], usage);
  }
  const frontmatter = {};
  for (const kv of flags.set) {
    const eq = kv.indexOf("=");
    if (eq <= 0) fail(`--set expects key=value, got "${kv}"`);
    frontmatter[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  body.frontmatter = frontmatter;
  const ctx = bridgeContext(flags);
  const r = await bridgeCall(ctx, "/phase-result", body);
  if (!r.ok) throw bridgeFailure("/phase-result", r);
  console.log(JSON.stringify(r.json));
}

async function putRaw(p, flags) {
  const usage = "gbrain put-raw <localfile> [--name <filename>] --bridge <url> --grant <token>";
  const local = need(p[0], "<localfile>", usage);
  let stat;
  try {
    stat = fs.statSync(local);
  } catch (err) {
    fail(`cannot read ${local} (${err.code || err.message})`);
  }
  if (!stat.isFile()) fail(`${local} is not a regular file`);
  const filename = flags.name || path.basename(local);
  const contentType = guessContentType(filename);
  const ctx = bridgeContext(flags);
  const r = await bridgeCall(ctx, "/raw/upload", { filename, contentType, size: stat.size });
  if (!r.ok) throw bridgeFailure("/raw/upload", r);
  if (!r.json.uploadUrl || !r.json.path) {
    fail(`BRIDGE_BAD_RESPONSE: /raw/upload did not return path + uploadUrl: ${JSON.stringify(r.json)}`);
  }
  const up = await request(r.json.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    bodyFile: local,
    timeoutMs: 30 * 60_000,
  });
  if (up.status < 200 || up.status >= 300) {
    fail(`UPLOAD_FAILED: PUT to the signed upload URL returned HTTP ${up.status}: ${up.text.slice(0, 300)}`);
  }
  // ONLY the stored path on stdout, so a workflow can do P=$(gbrain put-raw f).
  process.stdout.write(`${r.json.path}\n`);
}

async function getRaw(p, flags) {
  const usage = "gbrain get-raw <path> <outfile> --bridge <url> --grant <token>";
  const stored = need(p[0], "<path>", usage);
  const out = need(p[1], "<outfile>", usage);
  const ctx = bridgeContext(flags);
  const r = await bridgeCall(ctx, "/raw/download", { path: stored });
  if (!r.ok) throw bridgeFailure("/raw/download", r);
  if (!r.json.url) fail(`BRIDGE_BAD_RESPONSE: /raw/download did not return url: ${JSON.stringify(r.json)}`);
  const res = await request(r.json.url, { method: "GET", outFile: out, timeoutMs: 30 * 60_000 });
  if (res.status < 200 || res.status >= 300) {
    fail(`DOWNLOAD_FAILED: GET signed URL returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  }
  console.log(JSON.stringify({ ok: true, path: stored, file: out }));
}

const WRITES = {
  put_page: putPage,
  progress,
  "phase-result": phaseResult,
  "put-raw": putRaw,
  "get-raw": getRaw,
};

const REMOVED = new Set(["dream", "delete", "add-timeline", "add_timeline", "doctor", "orphans", "think", "jobs"]);

const ALIASES = { "get-page": "get_page", "put-page": "put_page", phase_result: "phase-result", put_raw: "put-raw", get_raw: "get-raw", list_tools: "list-tools" };

function usage() {
  return [
    "usage: gbrain <command> [args]",
    "",
    "reads (gbrain-mcp engine, read-only):",
    "  get_page <slug> | search <query> | query <query> | backlinks <slug> | links <slug>",
    "  timeline <slug> | list [type] | versions <slug> | stats | health | list-tools",
    "",
    "writes (dashboard bridge; need --bridge <url> --grant <token> or S2_BRIDGE/S2_GRANT):",
    "  put_page <slug> <file>",
    "  progress <slug> \"<what you are doing now>\"         (best-effort status line; never fails the run)",
    "  phase-result <slug> <file> [--set key=value]...   |   phase-result <slug> --failed \"<reason>\"",
    "  put-raw <localfile> [--name <filename>]            (prints the stored path only)",
    "  get-raw <path> <outfile>",
    "",
    "hyphen and underscore spellings are interchangeable (get-page = get_page).",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const rawCmd = argv[0];
  if (!rawCmd || rawCmd === "help" || rawCmd === "--help" || rawCmd === "-h") {
    console.error(usage());
    process.exitCode = rawCmd ? 0 : 1;
    return;
  }
  const cmd = ALIASES[rawCmd] || rawCmd;
  if (REMOVED.has(cmd)) {
    fail(`${rawCmd}: not available: brain writes/admin ops go through the dashboard bridge`);
  }
  const { positional, flags } = parseArgs(argv.slice(1));
  if (READS[cmd]) {
    await engineCall(READS[cmd](positional));
    return;
  }
  if (WRITES[cmd]) {
    await WRITES[cmd](positional, flags);
    return;
  }
  console.error(`gbrain: unknown command "${rawCmd}"\n\n${usage()}`);
  process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`gbrain: ${err.message}`);
  } else {
    console.error(`gbrain: unexpected error: ${err?.code || ""} ${err?.message || err}`.trim());
  }
  process.exitCode = 1;
});
