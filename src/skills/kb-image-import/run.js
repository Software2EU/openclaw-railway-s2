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
//
// Auth (PRIMARY — required for reliable operation):
//   ZOHO_EMAIL + ZOHO_PASSWORD — drives a headless Playwright login from inside
//                             the container. Zoho's /scroll/ image endpoints are
//                             IP-bound, so an externally-captured storageState
//                             replayed from a different IP is rejected. Logging
//                             in from the container produces a session bound to
//                             the SAME IP every image fetch runs from. The
//                             operator confirmed this account is email+password
//                             only (no MFA/SSO). The skill auto-detects ONE-step
//                             and TWO-step Zoho login layouts.
//
// Auth (FALLBACK — only if the storageState was captured on the SAME IP as the
// container; rarely true and surfaced honestly as an operator-known caveat):
//   ZOHO_STORAGE_STATE_PATH — path to a Playwright storageState.json. Used ONLY
//                             when ZOHO_EMAIL/ZOHO_PASSWORD are unset.
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

// Session 43 — anti-spin guard. The work-list endpoint can transiently 504
// (Vercel 60s cap) on a cold cache, so a single failure is NOT a stop signal;
// retry a bounded number of times with exponential backoff then ABORT the
// skill with a NAMED error. NEVER loop forever.
const WORKLIST_RETRIES = 3;
const WORKLIST_BACKOFF_MS = [2_000, 5_000, 10_000];

async function fetchOnce(endpoint, init) {
  // 90s socket timeout — Vercel caps at 60s but we add slack so a slow build
  // surfaces as a NAMED error rather than a hung fetch.
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 90_000) : null;
  try {
    return await fetch(endpoint, { ...init, signal: ctrl ? ctrl.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWorkList() {
  if (!BRAIN_URL) throw new Error("BRAIN_URL is unset");
  if (!BEARER) throw new Error("BRAIN_BEARER_TOKEN is unset");
  const endpoint = `${BRAIN_URL}/api/wissen/zoho/image-refs?pending=true`;
  let lastErr = null;
  for (let attempt = 0; attempt < WORKLIST_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = WORKLIST_BACKOFF_MS[attempt - 1] || 10_000;
      log("info", "work-list retry", { attempt: attempt + 1, delay });
      await sleep(delay);
    }
    log("info", "work-list GET", { endpoint, attempt: attempt + 1, bearerLen: BEARER.length });
    try {
      const res = await fetchOnce(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${BEARER}` },
      });
      if (res.ok) {
        return res.json();
      }
      const text = await res.text().catch(() => "");
      // A 401/403/409 is almost always a KB_IMAGE_UPLOAD_SECRET mismatch —
      // FAIL FAST + LOUD, never retry (the secret won't fix itself mid-run).
      if (res.status === 401 || res.status === 403 || res.status === 409) {
        throw new Error(
          `work-list ${res.status}: ${text.slice(0, 200)}. ` +
            `Almost certainly KB_IMAGE_UPLOAD_SECRET differs between OpenClaw and the dashboard — ` +
            `verify both envs hold the SAME value.`,
        );
      }
      // 504/5xx — transient; record + retry.
      lastErr = new Error(`work-list HTTP ${res.status} — ${text.slice(0, 200)}`);
    } catch (e) {
      // Catch-and-retry only NETWORK failures; the 4xx branch above rethrows.
      if (String(e).includes("KB_IMAGE_UPLOAD_SECRET")) throw e;
      lastErr = e;
    }
  }
  throw new Error(
    `work-list fetch failed after ${WORKLIST_RETRIES} attempts — aborting. ` +
      `Last error: ${String(lastErr).slice(0, 300)}. ` +
      `Likely cause: dashboard is rebuilding the work-list (cold cache + 60s Vercel cap). ` +
      `Re-trigger from Wissen-Center → Bilder importieren.`,
  );
}

/** Read the progress page's cancel flag (best-effort; never throws). The
 *  endpoint is the FAST `progressOnly` lane so this is cheap (~50ms). */
async function isCancelRequested() {
  try {
    const res = await fetchOnce(`${BRAIN_URL}/api/wissen/zoho/image-refs?progressOnly=true`, {
      method: "GET",
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.progress?.cancelRequested === true;
  } catch {
    return false;
  }
}

async function uploadImage(item, bytes, contentType) {
  const buf = Buffer.from(bytes);
  // Refuse to POST a zero-byte / non-image payload as a "success" — a failed
  // fetch must NEVER look like a stored image (the dashboard's upload endpoint
  // already rejects empty bytes, but we fail-fast here so a future endpoint
  // relax never lets a faux-success slip through).
  if (buf.length === 0) {
    throw new Error(`refusing to upload 0-byte payload for ${item.articleId}::${item.ref} (skip + log instead)`);
  }
  if (!contentType || !contentType.startsWith("image/")) {
    throw new Error(`refusing to upload non-image content-type "${contentType || "(none)"}" for ${item.articleId}::${item.ref}`);
  }
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

/** Headless in-container login to Zoho. The PRIMARY auth path: Zoho's
 *  `/scroll/` image endpoints are IP-bound (proven exhaustively in this
 *  session — a laptop-captured storageState with 45 valid cookies is
 *  rejected when replayed from Railway's IP and bounces to the login page),
 *  so the session MUST originate from the SAME IP it's replayed from. By
 *  driving the login form headless from inside the container, we get a
 *  session bound to Railway's egress IP — the IP every subsequent image
 *  fetch uses. The operator confirmed the account is email+password only
 *  (no MFA/SSO). Handles both ONE-step (email+password on one screen) and
 *  TWO-step (email → next → password) Zoho login layouts. */
async function loginToZoho(browser) {
  if (!ZOHO_EMAIL || !ZOHO_PASSWORD) {
    throw new Error(
      `ZOHO_EMAIL and ZOHO_PASSWORD env vars must be set on the OpenClaw Railway ` +
        `service to log in from inside the container. An IP-bound Zoho session ` +
        `captured on a different host cannot be replayed from Railway — Zoho ` +
        `enforces IP affinity on its /scroll/ image endpoints. In-container login ` +
        `is the only reliable path; the operator confirmed this account is ` +
        `email+password only (no MFA/SSO).`,
    );
  }
  log("info", "logging into Zoho Learn from container", { email: ZOHO_EMAIL, dataCenter: ZOHO_DATA_CENTER });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const learnOrigin = `https://learn.zoho.${ZOHO_DATA_CENTER}`;
    // Navigate to Learn first. If unauthed (which we always are on a fresh
    // context), Zoho redirects to accounts.zoho.<dc>/signin?servicename=…
    // with the SSO redirect-back wired up — completing login lands us back
    // on Learn, ready to fetch images.
    await page.goto(learnOrigin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let url = page.url();
    log("info", "initial navigation", { url, redirectedToLogin: url.includes("accounts.zoho") });
    if (!url.includes("accounts.zoho") && !url.includes("signin")) {
      log("info", "no login redirect — context already authed (unexpected on a fresh context)");
      await page.close();
      return context;
    }
    // Fill EMAIL. Cover the known Zoho selectors + a generic type="email" fallback.
    const emailSelector = 'input[name="LOGIN_ID"], input#login_id, input[type="email"]';
    await page.waitForSelector(emailSelector, { timeout: 15_000, state: "visible" });
    await page.fill(emailSelector, ZOHO_EMAIL);
    log("info", "filled email");
    // Detect ONE-step vs TWO-step layout: if the password field is already
    // visible right after filling the email, it's one-step. Otherwise it's
    // two-step (a Next button advances to a second screen with the password).
    const passwordSelector = 'input[name="PASSWORD"], input#password, input[type="password"]';
    let isOneStep = false;
    try {
      await page.waitForSelector(passwordSelector, { timeout: 1_500, state: "visible" });
      isOneStep = true;
    } catch {
      isOneStep = false;
    }
    if (!isOneStep) {
      // TWO-step: click Next and wait for the password field.
      const nextSelector = 'button#nextbtn, button[type="submit"], input#nextbtn';
      await page.click(nextSelector);
      log("info", "clicked next (two-step layout)");
      await page.waitForSelector(passwordSelector, { timeout: 15_000, state: "visible" });
    } else {
      log("info", "one-step layout — password field already visible");
    }
    // Fill PASSWORD and submit.
    await page.fill(passwordSelector, ZOHO_PASSWORD);
    log("info", "filled password");
    const submitSelector = 'button#nextbtn, button[type="submit"], input#nextbtn';
    await page.click(submitSelector);
    log("info", "submitted login form");
    // Wait for the SSO redirect to land back on Learn (away from accounts.zoho).
    try {
      await page.waitForURL((u) => !u.host.includes("accounts.zoho") && !u.toString().includes("signin"), { timeout: 30_000 });
    } catch (e) {
      const stuckUrl = page.url();
      // Look for an MFA / OTP / unusual-activity challenge that would block
      // unattended completion — surface it loudly so the operator knows.
      const looksMfa = await page.evaluate(() => {
        const html = document.body ? document.body.innerText || "" : "";
        return /OTP|verification|two[-\s]?factor|2FA|authenticator|verify|unusual/i.test(html);
      }).catch(() => false);
      throw new Error(
        `login did not redirect away from accounts.zoho within 30s — stuck at ${stuckUrl}. ` +
          (looksMfa
            ? "The login page shows an MFA / OTP / verification challenge — Playwright cannot solve it unattended. Disable MFA on this account OR use a service account without 2FA."
            : "Likely credentials rejected (verify ZOHO_EMAIL + ZOHO_PASSWORD are correct on the OpenClaw Railway env).") +
          ` Underlying timeout: ${String(e)}`,
      );
    }
    log("info", "login completed", { finalUrl: page.url() });
    const finalUrl = page.url();
    if (finalUrl.includes("accounts.zoho") || finalUrl.includes("signin")) {
      throw new Error(
        `login appeared to complete but landed at ${finalUrl} (still on the accounts host) — ` +
          `credentials rejected, MFA challenge, or unexpected redirect chain.`,
      );
    }
    await page.close();
    return context;
  } catch (e) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    throw new Error(`Zoho in-container login FAILED: ${String(e)}`);
  }
}

/** Post-login verification: navigate to Learn and assert we LAND on Learn
 *  (not redirected to login). Also assert the context now holds cookies for
 *  the Zoho Learn origin. If either check fails, throw — do NOT attempt
 *  image fetches against an unauthenticated session. */
async function verifyAuthenticatedSession(context) {
  const learnOrigin = `https://learn.zoho.${ZOHO_DATA_CENTER}`;
  const probePage = await context.newPage();
  try {
    const resp = await probePage.goto(learnOrigin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const finalUrl = probePage.url();
    const redirected = finalUrl.includes("accounts.zoho") || finalUrl.includes("signin");
    log("info", "auth verification probe", {
      origin: learnOrigin,
      status: resp ? resp.status() : null,
      finalUrl,
      redirectedToLogin: redirected,
    });
    if (redirected) {
      throw new Error(
        `auth verification FAILED — navigating to ${learnOrigin} redirected to ${finalUrl}. ` +
          `The session is NOT authenticated; refusing to attempt image fetches against a logged-out context. ` +
          `Verify ZOHO_EMAIL + ZOHO_PASSWORD are set correctly on the OpenClaw Railway service.`,
      );
    }
    const zohoCookies = await context.cookies(learnOrigin);
    log("info", "auth verification cookies", {
      forZohoOrigin: zohoCookies.length,
      zohoCookieNames: zohoCookies.map((c) => c.name).slice(0, 10),
    });
    if (zohoCookies.length === 0) {
      throw new Error(
        `auth verification: 0 cookies live for ${learnOrigin} after login — ` +
          `the login form completed but the cookie jar is empty for the Learn origin. ` +
          `Refusing to attempt image fetches against a cookie-less context.`,
      );
    }
  } finally {
    await probePage.close().catch(() => {});
  }
}

async function ensureAuthenticatedContext(browser) {
  // PRIMARY PATH — in-container login from ZOHO_EMAIL + ZOHO_PASSWORD.
  // The session originates from Railway's egress IP = same IP every image
  // fetch runs from, so Zoho's IP-bound /scroll/ endpoints honour it. This
  // is the only reliable path; a laptop-captured storageState is rejected
  // cross-IP (proven in the previous run: 45 cookies, still bounced to
  // login on the warm-up page.goto).
  if (ZOHO_EMAIL && ZOHO_PASSWORD) {
    const context = await loginToZoho(browser);
    await verifyAuthenticatedSession(context);
    // Best-effort: save the resulting state for THIS container's next run
    // (still IP-bound, so only valid as long as Railway's egress IP doesn't
    // rotate). A subsequent run can read it back via the fallback path
    // below for a fast start — but in-container login stays the primary.
    if (STORAGE_STATE_PATH) {
      try {
        await context.storageState({ path: STORAGE_STATE_PATH });
        log("info", "saved post-login storageState for diagnostic re-use", { path: STORAGE_STATE_PATH });
      } catch (e) {
        log("warn", "could not save post-login storageState (non-fatal)", { error: String(e) });
      }
    }
    return context;
  }

  // FALLBACK — operator-captured storageState. KEPT only as a manual escape
  // hatch (e.g. diagnosing a login regression). NOT the recommended path:
  // Zoho's /scroll/ endpoints are IP-bound, so a storageState captured on
  // any host other than Railway's egress IP will fail with login redirects.
  if (STORAGE_STATE_PATH && fs.existsSync(STORAGE_STATE_PATH)) {
    log("warn", "no ZOHO_EMAIL/ZOHO_PASSWORD set — falling back to storageState. " +
      "WARNING: Zoho's /scroll/ endpoints are IP-bound; a storageState captured on " +
      "any IP other than Railway's egress IP will be rejected with a login redirect. " +
      "Set ZOHO_EMAIL + ZOHO_PASSWORD on the OpenClaw Railway env for the reliable " +
      "in-container login path.");
    let parsedState = null;
    let stateMtime = null;
    let stateBytes = null;
    let cookieCount = 0;
    let zohoFileCookieCount = 0;
    try {
      const st = fs.statSync(STORAGE_STATE_PATH);
      stateMtime = st.mtime.toISOString();
      stateBytes = st.size;
      parsedState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, "utf8"));
      const cookies = Array.isArray(parsedState.cookies) ? parsedState.cookies : [];
      cookieCount = cookies.length;
      zohoFileCookieCount = cookies.filter((c) =>
        typeof c.domain === "string" && c.domain.toLowerCase().includes("zoho"),
      ).length;
    } catch (e) {
      throw new Error(
        `storageState parse FAILED at ${STORAGE_STATE_PATH}: ${String(e)}. ` +
          `Set ZOHO_EMAIL + ZOHO_PASSWORD instead to use the in-container login path.`,
      );
    }
    log("info", "using storageState fallback for Zoho session", {
      path: STORAGE_STATE_PATH,
      mtime: stateMtime,
      bytes: stateBytes,
      fileCookieCount: cookieCount,
      fileZohoCookieCount: zohoFileCookieCount,
    });
    const ctx = await browser.newContext({ storageState: parsedState });
    // Verify the fallback session is actually live — same probe as the primary path.
    await verifyAuthenticatedSession(ctx);
    return ctx;
  }

  // Neither path configured — fail loudly with the operator runbook.
  throw new Error(
    "No Zoho auth source configured. Set ZOHO_EMAIL + ZOHO_PASSWORD env vars on the " +
      "OpenClaw Railway service to log in from inside the container — Zoho's /scroll/ " +
      "image endpoints are IP-bound, so a captured storageState replayed from a " +
      "different IP will fail (proven in the previous session: 45 cookies, still " +
      "redirected to login). The operator confirmed this account is email+password " +
      "only (no MFA/SSO).",
  );
}

/** The Zoho Learn origin (e.g. https://learn.zoho.eu). Used as Referer/Origin
 *  headers so the session-bound endpoints accept the request. The dashboard's
 *  work-list passes absolute URLs against this origin; deriving the origin from
 *  the URL itself (not from ZOHO_DATA_CENTER) keeps this robust across DCs. */
function deriveOrigin(absoluteUrl) {
  try {
    return new URL(absoluteUrl).origin;
  } catch {
    return `https://learn.zoho.${ZOHO_DATA_CENTER}`;
  }
}

/** Truncate a Buffer/string to `n` chars of safe ASCII-ish preview so the log
 *  line stays one row (multi-MB image bytes never get dumped). */
function previewBody(buf, n = 240) {
  if (!buf) return "";
  const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  // Collapse newlines so the log JSON stays a single record; truncate hard.
  return s.replace(/\s+/g, " ").slice(0, n);
}

async function fetchOneImage(context, item, diagnostics) {
  // ROOT CAUSE (this iteration): the previous diagnostic showed every page.goto
  // arriving with cookiesSent="(no cookie header sent)" — i.e. an EMPTY cookie
  // jar on the context — AND `viewFile.do` threw "Protocol error: No resource
  // with given identifier" because page.goto refuses to expose a download-stream
  // body. So both prior fix paths (detached fetch in PR#13, navigated goto in
  // PR#14) were defeated by ONE upstream fault: the context's cookie jar was
  // empty after newContext({storageState}).
  //
  // The startup assert above now guarantees that when fetchOneImage runs, the
  // CONTEXT carries Zoho cookies. `context.request.get()` then carries those
  // cookies on its requests AND reads file-download response bodies (which
  // page.goto cannot). It's the right fetch method once cookies are real.
  //
  // GROUND-TRUTH PER-FETCH PROBE: before each request we ask the LIVE context
  // what cookies it will send for THIS URL (Playwright's cookie engine applies
  // the same Domain/Path/SameSite scoping it uses on the wire). If this is
  // empty for an individual URL we surface it in the diagnostic — that's the
  // true source-of-truth, NOT request.headers() which may strip cookies.
  let cookiesForUrl = [];
  try {
    cookiesForUrl = await context.cookies(item.url);
  } catch {
    /* fall through — diagnostic only */
  }
  const origin = deriveOrigin(item.url);
  let res;
  try {
    res = await context.request.get(item.url, {
      headers: {
        Referer: `${origin}/`,
        Accept: "image/*,application/json;q=0.9,*/*;q=0.5",
      },
    });
  } catch (e) {
    throw new Error(`context.request.get failed for ${item.url}: ${String(e)}`);
  }
  const status = res.status();
  const ct = (res.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();
  let buf;
  try {
    buf = await res.body();
  } catch (e) {
    throw new Error(`response.body() failed for ${item.url}: ${String(e)}`);
  }
  const sentCookies = cookiesForUrl.length === 0
    ? "(no cookies live for this URL — Domain/Path scoping excludes it)"
    : cookiesForUrl.map((c) => c.name).join(", ");
  const requestMethod = "context.request.get";

  // Diagnostic: every non-image response is logged with the EXACT URL + status
  // + content-type + the cookies actually sent + a body preview. The FIRST
  // non-image is dumped with NO body truncation (so the operator can see the
  // full envelope shape — e.g. whether viewImage.do's empty JSON is truly
  // empty or carries a real-image-url field we missed). Subsequent diagnostics
  // truncate at 240 chars to keep the log tractable.
  const isImage = ct.startsWith("image/");
  if (!isImage && diagnostics && diagnostics.remaining > 0) {
    const isFirst = diagnostics.remaining === diagnostics.budget;
    const previewLen = isFirst ? 4_000 : 240;
    log("info", "image diagnostic", {
      method: requestMethod,
      requestUrl: item.url,
      status,
      contentType: ct || "(none)",
      bodySize: buf ? buf.length : 0,
      bodyPreview: previewBody(buf, previewLen),
      cookiesForUrl: sentCookies,
      cookieCountForUrl: cookiesForUrl.length,
      articleId: item.articleId,
      ref: item.ref,
    });
    diagnostics.remaining -= 1;
  }

  // 3) Three shapes from Zoho:
  //    image/*          → bytes
  //    application/json → viewImage.do envelope { url } or { data: base64 }
  //                       OR an honest Zoho error envelope ({errorCode, status})
  //    text/html        → either an expired-session login redirect, OR (more
  //                       commonly with a FRESH session) a request-construction
  //                       fault — wrong URL pattern, missing Referer, etc.
  if (isImage) {
    return { bytes: buf, contentType: ct, endpoint: item.url, status };
  }
  if (ct.includes("json")) {
    const rawText = buf.toString("utf8");
    let env;
    try {
      env = JSON.parse(rawText);
    } catch {
      throw new Error(`Zoho returned non-parseable JSON at ${item.url}: ${previewBody(rawText)}`);
    }
    // Honest error envelope — surface verbatim. URL_RULE_NOT_CONFIGURED is the
    // tell that Zoho doesn't recognize the URL pattern (NOT auth) — usually means
    // the dashboard built a URL the modern Zoho Learn API doesn't accept.
    const errCode = env.errorCode || env.error_code || env.code;
    const errStatus = env.status || env.statusCode;
    if ((errCode && String(errCode).toUpperCase() !== "SUCCESS") || (errStatus && /failure|error/i.test(String(errStatus)))) {
      const reason = env.message || env.description || env.reason || rawText.slice(0, 200);
      throw new Error(
        `Zoho rejected ${item.url} — code=${errCode || "(none)"} status=${errStatus || "(none)"} reason=${reason}. ` +
          (String(errCode).toUpperCase() === "URL_RULE_NOT_CONFIGURED"
            ? "URL_RULE_NOT_CONFIGURED means Zoho doesn't recognize this URL pattern — this is a URL-construction bug, NOT a session/auth issue. Check absoluteImageUrl in zoho-client.ts."
            : "This is a request-construction or per-endpoint authorization failure, not a session expiry — the session file is fresh per the startup log."),
      );
    }
    // Pull either a url hop or base64 image data.
    const urlField = env.url || env.imageUrl || env.downloadUrl || env.fileUrl || env.viewUrl || env.src;
    const dataField = env.data || env.image || env.base64 || env.imageData;
    if (urlField) {
      const hopOrigin = deriveOrigin(item.url);
      const hopUrl = urlField.startsWith("http") ? urlField : `${hopOrigin}${urlField.startsWith("/") ? "" : "/"}${urlField}`;
      // Same fetch path as the primary — context.request.get carries the
      // context's cookies AND reads file-download bodies that page.goto
      // refuses ("No resource with given identifier"). Referer is the
      // original viewImage.do URL so the hop sees the right context.
      let hopResp;
      try {
        hopResp = await context.request.get(hopUrl, {
          headers: { Referer: item.url, Accept: "image/*,*/*;q=0.5" },
        });
      } catch (e) {
        throw new Error(`envelope hop context.request.get failed for ${hopUrl}: ${String(e)}`);
      }
      const hopCt = (hopResp.headers()["content-type"] || "").split(";")[0].trim().toLowerCase();
      const hopBuf = await hopResp.body();
      if (!hopCt.startsWith("image/")) {
        throw new Error(
          `envelope hop ${hopUrl} returned ${hopResp.status()} ${hopCt} — ` +
            `body=${previewBody(hopBuf)}. The viewImage.do envelope's url field pointed at a non-image resource.`,
        );
      }
      return { bytes: hopBuf, contentType: hopCt, endpoint: hopUrl, status: hopResp.status() };
    }
    if (typeof dataField === "string" && dataField.length > 0) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataField);
      const ctFromData = m ? m[1] : "image/png";
      const b64 = (m ? m[2] : dataField).replace(/\s+/g, "");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) throw new Error("Zoho JSON envelope decoded to 0 bytes");
      return { bytes, contentType: ctFromData, endpoint: item.url, status };
    }
    // Zoho's viewImage.do can return an EMPTY JSON envelope when the URL is
    // malformed/missing the article scope. The first diagnostic log dumps the
    // full body so the operator can see the actual envelope shape.
    throw new Error(
      `Zoho JSON envelope had no url/base64 fields at ${item.url}: ${previewBody(rawText)}. ` +
        `An empty envelope ({} / null body) usually means the URL is missing the article-scope param Zoho requires — ` +
        `check the dashboard's absoluteImageUrl construction.`,
    );
  }
  if (ct.includes("html") || ct.includes("text")) {
    // HONEST diagnosis: a FRESH session that returns HTML is almost always a
    // request-construction fault — NOT session expiry. The session-freshness
    // log line at startup is the ground truth; do not mislead the operator
    // into recapturing.
    const body = previewBody(buf);
    const looksLikeLogin = /<input[^>]+name=["']?LOGIN_ID/i.test(body) ||
      /accounts\.zoho\./i.test(body) ||
      /Sign In/i.test(body);
    if (looksLikeLogin) {
      throw new Error(
        `Zoho returned a LOGIN page at ${item.url} via context.request.get — ` +
          `the startup assert proved Zoho cookies are loaded in the context, so this ` +
          `means the cookies don't survive to this specific endpoint (likely a SameSite=Strict ` +
          `or Path=/api scoping issue — the per-fetch diagnostic shows the cookieCountForUrl). ` +
          `The session file at ${STORAGE_STATE_PATH || "(none)"} is fresh per the startup log. ` +
          `bodyPreview=${body}`,
      );
    }
    throw new Error(
      `Zoho returned HTML (not an image, not JSON) at ${item.url} — request-construction fault ` +
        `(wrong URL pattern, missing article-scope param, or per-endpoint authorization). The session file ` +
        `at ${STORAGE_STATE_PATH || "(none)"} is fresh per the startup log. bodyPreview=${body}`,
    );
  }
  throw new Error(`unexpected content-type "${ct || "(none)"}" for ${item.url} — bodyPreview=${previewBody(buf)}`);
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
  // PRIMARY auth path = in-container Zoho login (ZOHO_EMAIL + ZOHO_PASSWORD).
  // Required because Zoho's /scroll/ image endpoints are IP-bound — a session
  // captured on any IP other than Railway's egress IP gets bounced to login.
  // storageState is a FALLBACK only.
  const authMode = ZOHO_EMAIL && ZOHO_PASSWORD
    ? "in-container-login"
    : STORAGE_STATE_PATH && fs.existsSync(STORAGE_STATE_PATH)
      ? "storageState-fallback"
      : "none-configured";
  log("info", "kb-image-import start", {
    BRAIN_URL,
    dryRun: DRY_RUN,
    dataCenter: ZOHO_DATA_CENTER,
    authMode,
    zohoEmail: ZOHO_EMAIL || "(unset)",
    zohoPasswordSet: !!ZOHO_PASSWORD,
    storageStatePath: STORAGE_STATE_PATH || "(unset)",
    storageStateExists: STORAGE_STATE_PATH ? fs.existsSync(STORAGE_STATE_PATH) : false,
    politeDelayMs: POLITE_DELAY_MS,
    importLimit: IMPORT_LIMIT || "(none)",
  });

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

  // Warm-up: an honest live probe that the session reaches Zoho. We DO NOT
  // use the resulting page for image fetches — the per-image fetches go
  // through `context.request.get()` which (a) carries the SAME cookies the
  // context now holds (verified by the startup assert), (b) reads
  // file-download response bodies that page.goto refuses with "No resource
  // with given identifier". The warm-up page lets us log whether a navigated
  // request makes it to /learn or gets bounced to /accounts (login).
  let warmPage;
  try {
    warmPage = await context.newPage();
    const warmOrigin = `https://learn.zoho.${ZOHO_DATA_CENTER}`;
    const resp = await warmPage.goto(warmOrigin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    log("info", "warmed Zoho Learn context", {
      origin: warmOrigin,
      status: resp ? resp.status() : null,
      finalUrl: warmPage.url(),
      redirectedToLogin: warmPage.url().includes("accounts.zoho"),
    });
    await warmPage.close().catch(() => {});
    warmPage = null;
  } catch (e) {
    log("warn", "context warm-up navigation failed (continuing)", { error: String(e) });
    if (warmPage) await warmPage.close().catch(() => {});
  }

  const done = readResumeState();
  let processed = 0;
  // Diagnostic budget — log full request URL + raw response (FULL body on the
  // first, truncated on the next 7) for the first 8 non-image responses, then
  // quiet down so a 1000-image run doesn't drown the logs. The first failures
  // are what answer "why".
  const diagnostics = { remaining: 8, budget: 8 };
  // Cancel-check rate limit — read the progress page every N images, not
  // every image, so we stay polite to the dashboard endpoint.
  const CANCEL_CHECK_EVERY = 5;
  let cancelled = false;
  try {
    outer: for (const a of workList.items) {
      state.articles.add(a.articleId);
      for (const r of a.imageRefs) {
        if (IMPORT_LIMIT > 0 && processed >= IMPORT_LIMIT) break outer;
        // Cancel poll between images (cheap progressOnly endpoint).
        if (processed > 0 && processed % CANCEL_CHECK_EVERY === 0) {
          if (await isCancelRequested()) {
            cancelled = true;
            log("info", "cancel requested — exiting cleanly", { stored: state.stored, processed });
            break outer;
          }
        }
        state.total++;
        const key = `${a.articleId}::${r.slot}`;
        if (done.has(key)) {
          state.skipped++;
          continue;
        }
        try {
          const dl = await fetchOneImage(context, { articleId: a.articleId, ref: r.ref, url: r.url, slot: r.slot }, diagnostics);
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
    }
  } finally {
    writeResumeState(done);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // Stamp the run outcome on the progress page so the UI can stop polling +
  // surface complete/cancelled/failed honestly.
  await finalizeRun(state, cancelled).catch(() => {});
  return emitOutcome(state);
}

/** Best-effort write to the progress page on exit — sets `last_run_outcome`
 *  to complete/cancelled/failed and refreshes the heartbeat. Uses the same
 *  bearer secret the upload uses (no separate auth). Honest no-op on failure. */
async function finalizeRun(state, cancelled) {
  if (!BRAIN_URL || !BEARER) return;
  const outcome = cancelled ? "cancelled" : state.failed === 0 ? "complete" : state.stored > 0 ? "complete_with_failures" : "failed";
  try {
    await fetchOnce(`${BRAIN_URL}/api/wissen/zoho/image-upload?finalize=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEARER}` },
      body: JSON.stringify({ finalize: true, outcome, stored: state.stored, failed: state.failed }),
    });
  } catch (e) {
    log("warn", "finalize call failed (continuing)", { error: String(e) });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log("error", "fatal", { error: String(e), stack: e && e.stack ? e.stack : "" });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  });
