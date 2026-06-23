#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
"use strict";

// kb-image-import — Playwright-based, self-contained KB image importer.
//
// The dashboard (s2-brain-dashboard) cannot fetch Zoho Learn article images
// (`/scroll/viewImage.do` + `/scroll/viewFile.do` are session-authenticated +
// IP-bound). Playwright drives a real headless Chromium that:
//   1. authenticates to Zoho Learn (login from creds OR a saved storageState),
//   2. fetches the work-list from the dashboard
//      (`GET /api/wissen/zoho/image-refs`),
//   3. for each (articleId, ref), navigates SAME-ORIGIN to the absolute URL
//      using the authenticated browser context (so cookies + IP match Zoho's
//      session bind),
//   4. POSTs the bytes to the dashboard
//      (`POST /api/wissen/zoho/image-upload`, bearer-secret protected).
//
// Honest behaviour:
//   - resumable: an image whose slot already has bytes is skipped by the
//     dashboard's work-list (server-side filter), so a re-run continues where
//     the last one stopped.
//   - per-image log line with endpoint + HTTP status + outcome so a session-
//     death mid-run surfaces in the logs, not as a silent success.
//   - the LAST stdout line is a single-line JSON outcome so OpenClaw's dispatch
//     can extract the summary.
//
// Required env:
//   BRAIN_URL              — the dashboard origin (e.g. https://brain.software2eu.com)
//   BRAIN_BEARER_TOKEN     — KB_IMAGE_UPLOAD_SECRET (the dashboard validates this)
//   ZOHO_DATA_CENTER       — e.g. "eu" (default: eu)
// One of:
//   ZOHO_STORAGE_STATE_PATH — path to a Playwright storageState.json the operator
//                             captured once from the browser ($STATE_DIR is the
//                             persistent /data volume so this survives redeploys)
//   ZOHO_EMAIL + ZOHO_PASSWORD — for headless login from credentials (may fail
//                             behind SSO/MFA — falls back to storageState if set)
//
// Optional:
//   DRY_RUN=1              — list the work and exit without uploading
//   POLITE_DELAY_MS        — sleep between per-image fetches (default 750ms)
//   IMPORT_LIMIT           — hard cap on images this run (default: no cap)

const fs = require("fs");
const path = require("path");

// Resolve the playwright module. The OpenClaw image already carries playwright
// — installed by gstack at $GSTACK_DIR/node_modules/playwright (the
// `bun install` step in the Dockerfile) — and Chromium binaries at the
// openclaw user's playwright cache. We DO NOT re-install playwright; instead
// we require() it by explicit path. Honour an env override
// (PLAYWRIGHT_NODE_MODULE) so an operator can point at a different install
// (e.g. a workspace-local one) without touching the script.
function resolvePlaywright() {
  const override = process.env.PLAYWRIGHT_NODE_MODULE;
  const candidates = [
    ...(override ? [override] : []),
    "/home/openclaw/.claude/skills/gstack/node_modules/playwright", // canonical: gstack's install
    "playwright", // fall back to normal resolution if the script runs in a workspace with its own
    "/usr/local/lib/node_modules/playwright",
    "/home/openclaw/.bun/install/global/node_modules/playwright",
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line global-require
      return require(c);
    } catch (e) {
      errors.push(`${c}: ${e.message || e}`);
    }
  }
  throw new Error(
    "playwright module not found. Tried:\n  - " + errors.join("\n  - ") +
      "\nExpected gstack's install at /home/openclaw/.claude/skills/gstack/node_modules/playwright — " +
      "verify the gstack build step ran (Dockerfile `bun install` in $GSTACK_DIR).",
  );
}

const BRAIN_URL = (process.env.BRAIN_URL || "").replace(/\/+$/, "");
const BEARER = process.env.BRAIN_BEARER_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const POLITE_DELAY_MS = Number(process.env.POLITE_DELAY_MS) > 0 ? Number(process.env.POLITE_DELAY_MS) : 750;
const IMPORT_LIMIT = Number(process.env.IMPORT_LIMIT) > 0 ? Number(process.env.IMPORT_LIMIT) : 0;
const STORAGE_STATE_PATH = process.env.ZOHO_STORAGE_STATE_PATH || "";
const ZOHO_EMAIL = process.env.ZOHO_EMAIL || "";
const ZOHO_PASSWORD = process.env.ZOHO_PASSWORD || "";
const ZOHO_DATA_CENTER = (process.env.ZOHO_DATA_CENTER || "eu").trim();
const RESUME_STATE_PATH = process.env.RESUME_STATE_PATH || "/data/kb-image-import-state.json";

function log(level, msg, extra) {
  const line = { level, ts: new Date().toISOString(), msg, ...(extra || {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summary(state) {
  return {
    ok: state.failed === 0,
    articles: state.articles.size,
    total: state.total,
    stored: state.stored,
    skipped: state.skipped,
    failed: state.failed,
    failures: state.failures.slice(0, 10),
  };
}

function emitOutcome(state) {
  const final = summary(state);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(final));
  return final;
}

function readResumeState() {
  try {
    const raw = fs.readFileSync(RESUME_STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.done)) return new Set(j.done);
  } catch {
    /* fresh */
  }
  return new Set();
}

function writeResumeState(doneSet) {
  try {
    fs.mkdirSync(path.dirname(RESUME_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      RESUME_STATE_PATH,
      JSON.stringify({ done: [...doneSet], updatedAt: new Date().toISOString() }, null, 0),
    );
  } catch (e) {
    log("warn", "could not write resume state", { error: String(e) });
  }
}

async function fetchWorkList() {
  if (!BRAIN_URL) throw new Error("BRAIN_URL is unset");
  if (!BEARER) throw new Error("BRAIN_BEARER_TOKEN is unset");
  const endpoint = `${BRAIN_URL}/api/wissen/zoho/image-refs?pending=true`;
  log("info", "work-list GET", { endpoint, bearerLen: BEARER.length });
  const res = await fetch(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  if (!res.ok) {
    const text = await res.text();
    // A 401/403/409 here is almost always a KB_IMAGE_UPLOAD_SECRET mismatch
    // between this OpenClaw container's env and the dashboard's env — surface
    // it loudly so the operator can correlate it with the dashboard secret.
    if (res.status === 401 || res.status === 403 || res.status === 409) {
      throw new Error(
        `work-list fetch ${res.status}: ${text.slice(0, 200)}. ` +
          `Almost certainly KB_IMAGE_UPLOAD_SECRET differs between OpenClaw and the dashboard — ` +
          `verify both envs hold the SAME value.`,
      );
    }
    throw new Error(`work-list fetch failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function uploadImage(item, bytes, contentType) {
  const buf = Buffer.from(bytes);
  const body = JSON.stringify({
    articleId: item.articleId,
    originalRef: item.ref,
    bytes: buf.toString("base64"),
    contentType,
  });
  const endpoint = `${BRAIN_URL}/api/wissen/zoho/image-upload`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEARER}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    const reason = (j && j.error && j.error.message) || text.slice(0, 200);
    // 401/403/409 here is the same SECRET MISMATCH signal as the work-list path.
    if (res.status === 401 || res.status === 403 || res.status === 409) {
      throw new Error(
        `upload ${res.status} at ${endpoint}: ${reason}. ` +
          `Verify KB_IMAGE_UPLOAD_SECRET matches between OpenClaw and the dashboard.`,
      );
    }
    throw new Error(`upload failed: HTTP ${res.status} — ${reason}`);
  }
  return JSON.parse(text);
}

async function ensureAuthenticatedContext(browser) {
  // 1) storageState path is the operator-friendly path — capture once, reuse forever.
  if (STORAGE_STATE_PATH && fs.existsSync(STORAGE_STATE_PATH)) {
    log("info", "using storageState for Zoho session", { path: STORAGE_STATE_PATH });
    return browser.newContext({ storageState: STORAGE_STATE_PATH });
  }
  // 2) Headless login from creds — only works if Zoho One bypasses MFA for the user.
  if (ZOHO_EMAIL && ZOHO_PASSWORD) {
    log("info", "attempting headless Zoho login from credentials");
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`https://accounts.zoho.${ZOHO_DATA_CENTER}/signin`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="LOGIN_ID"], input#login_id', ZOHO_EMAIL);
      await page.click('button#nextbtn, button[type="submit"], input#nextbtn');
      await page.waitForSelector('input[name="PASSWORD"], input#password', { timeout: 10_000 });
      await page.fill('input[name="PASSWORD"], input#password', ZOHO_PASSWORD);
      await page.click('button#nextbtn, button[type="submit"], input#nextbtn');
      // Wait for a successful redirect away from accounts.zoho — if MFA is on,
      // this won't complete and we surface that honestly.
      await page.waitForURL((url) => !url.host.includes("accounts.zoho"), { timeout: 20_000 });
      log("info", "headless Zoho login succeeded");
      // Optionally persist the storage state for next run.
      if (STORAGE_STATE_PATH) {
        await context.storageState({ path: STORAGE_STATE_PATH });
        log("info", "saved storageState for future runs", { path: STORAGE_STATE_PATH });
      }
      await page.close();
      return context;
    } catch (e) {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      throw new Error(
        `headless Zoho login failed: ${String(e)}. ` +
          `Most likely the account requires MFA/SSO that Playwright cannot solve unattended — ` +
          `capture a storageState.json manually (\`npx playwright codegen https://learn.zoho.${ZOHO_DATA_CENTER}\`) and ` +
          `set ZOHO_STORAGE_STATE_PATH to its persistent path (recommended: /data/zoho-storage-state.json).`,
      );
    }
  }
  throw new Error(
    "No Zoho session source configured. Set either ZOHO_STORAGE_STATE_PATH (recommended) or " +
      "ZOHO_EMAIL + ZOHO_PASSWORD (only works without MFA/SSO).",
  );
}

async function fetchOneImage(context, item) {
  // Use the authenticated browser context's request to fetch the image — this
  // preserves cookies + reuses the same IP the browser would. We DO NOT
  // navigate the page (a viewImage.do JSON payload would render as text in a
  // tab); we issue an XHR-style GET inside the context.
  let res;
  try {
    res = await context.request.get(item.url);
  } catch (e) {
    throw new Error(`network error fetching ${item.url}: ${String(e)}`);
  }
  const status = res.status();
  const ct = (res.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();
  const buf = await res.body();
  // Three shapes from Zoho:
  //   image/* → bytes
  //   application/json → viewImage.do envelope { url } or { data: base64 }
  //   text/html → expired session (re-capture storageState)
  if (ct.startsWith("image/")) {
    return { bytes: buf, contentType: ct, endpoint: item.url, status };
  }
  if (ct.includes("json")) {
    let env;
    try {
      env = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new Error(`viewImage.do returned non-parseable JSON at ${item.url}`);
    }
    // Pull either a url hop or base64 image data.
    const urlField = env.url || env.imageUrl || env.downloadUrl || env.fileUrl || env.viewUrl || env.src;
    const dataField = env.data || env.image || env.base64 || env.imageData;
    if (urlField) {
      const origin = `https://learn.zoho.${ZOHO_DATA_CENTER}`;
      const hopUrl = urlField.startsWith("http") ? urlField : `${origin}${urlField.startsWith("/") ? "" : "/"}${urlField}`;
      const hop = await context.request.get(hopUrl);
      const hopCt = (hop.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();
      const hopBuf = await hop.body();
      if (!hopCt.startsWith("image/")) {
        throw new Error(`envelope hop ${hopUrl} returned ${hop.status()} ${hopCt} — likely expired session`);
      }
      return { bytes: hopBuf, contentType: hopCt, endpoint: hopUrl, status: hop.status() };
    }
    if (typeof dataField === "string" && dataField.length > 0) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataField);
      const ctFromData = m ? m[1] : "image/png";
      const b64 = (m ? m[2] : dataField).replace(/\s+/g, "");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) throw new Error("viewImage.do base64 decoded to 0 bytes");
      return { bytes, contentType: ctFromData, endpoint: item.url, status };
    }
    throw new Error(`viewImage.do JSON envelope had no url/base64 fields: ${buf.toString("utf8").slice(0, 200)}`);
  }
  if (ct.includes("html") || ct.includes("text")) {
    throw new Error(`Zoho returned HTML at ${item.url} — the session is expired or the URL is unreachable`);
  }
  throw new Error(`unexpected content-type ${ct} for ${item.url}`);
}

async function main() {
  const state = {
    articles: new Set(),
    total: 0,
    stored: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  log("info", "kb-image-import start", { BRAIN_URL, dryRun: DRY_RUN, dataCenter: ZOHO_DATA_CENTER });

  let workList;
  try {
    workList = await fetchWorkList();
  } catch (e) {
    log("error", "work-list fetch failed", { error: String(e) });
    return emitOutcome({ ...state, failed: 1, failures: [{ articleId: "_", ref: "_", reason: String(e) }] });
  }
  log("info", "work-list received", {
    articles: workList.summary?.articles ?? 0,
    pending: workList.summary?.pendingRefs ?? 0,
    items: (workList.items || []).length,
  });

  if (DRY_RUN) {
    log("info", "DRY_RUN — listing only, no uploads");
    for (const a of workList.items || []) {
      state.articles.add(a.articleId);
      state.total += a.imageRefs.length;
    }
    return emitOutcome(state);
  }

  if (!workList.items || workList.items.length === 0) {
    log("info", "nothing pending — every article's images are already stored");
    return emitOutcome(state);
  }

  const playwright = resolvePlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  let context;
  try {
    context = await ensureAuthenticatedContext(browser);
  } catch (e) {
    log("error", "Zoho authentication failed", { error: String(e) });
    await browser.close().catch(() => {});
    return emitOutcome({ ...state, failed: 1, failures: [{ articleId: "_", ref: "_", reason: String(e) }] });
  }

  const done = readResumeState();
  let processed = 0;
  try {
    for (const a of workList.items) {
      state.articles.add(a.articleId);
      for (const r of a.imageRefs) {
        if (IMPORT_LIMIT > 0 && processed >= IMPORT_LIMIT) break;
        state.total++;
        const key = `${a.articleId}::${r.slot}`;
        if (done.has(key)) {
          state.skipped++;
          continue;
        }
        try {
          const dl = await fetchOneImage(context, { articleId: a.articleId, ref: r.ref, url: r.url, slot: r.slot });
          await uploadImage({ articleId: a.articleId, ref: r.ref }, dl.bytes, dl.contentType);
          state.stored++;
          done.add(key);
          if (state.stored % 5 === 0) writeResumeState(done); // checkpoint
          log("info", "image stored", {
            article: a.articleId,
            slot: r.slot,
            endpoint: dl.endpoint,
            status: dl.status,
            bytes: dl.bytes.length,
            contentType: dl.contentType,
          });
        } catch (e) {
          state.failed++;
          state.failures.push({ articleId: a.articleId, ref: r.ref, reason: String(e) });
          log("warn", "image failed", { article: a.articleId, slot: r.slot, ref: r.ref, error: String(e) });
        }
        processed++;
        await sleep(POLITE_DELAY_MS);
      }
      if (IMPORT_LIMIT > 0 && processed >= IMPORT_LIMIT) break;
    }
  } finally {
    writeResumeState(done);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return emitOutcome(state);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log("error", "fatal", { error: String(e), stack: e && e.stack ? e.stack : "" });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  });
