# Knowledge Center — Zoho image import (Playwright skill)

The dashboard (`brain.software2eu.com`) cannot fetch Zoho Learn article images
itself: `/scroll/viewImage.do` + `/scroll/viewFile.do` are session-authenticated
(JSESSIONID + CSRF) + IP-bound, so an OAuth token doesn't reach them. This skill
drives a real authenticated browser to do it.

## Dispatch contract

POST `/v1/chat/completions` with `Content-Type: text/plain`, NO Authorization
header (the OpenClaw wrapper injects it). The body is a single user message
(the dashboard builds the exact text — see `acp-chat.ts:dispatchPrompt`):

```
Run the knowledge-center skill "kb-image-import". This is a baked Playwright Node
script — do not improvise.
Resolve the script path: `ls -la /data/workspace/skills/kb-image-import/run.js`
(fall back to `/app/skills/kb-image-import/run.js` if the workspace copy is
missing — log the path you chose).
Run it with these env vars:
   BRAIN_URL='https://brain.software2eu.com'
   BRAIN_BEARER_TOKEN="$KB_IMAGE_UPLOAD_SECRET"
   DRY_RUN=0
Command: `BRAIN_URL='https://brain.software2eu.com' BRAIN_BEARER_TOKEN="$KB_IMAGE_UPLOAD_SECRET" DRY_RUN=0 node /data/workspace/skills/kb-image-import/run.js`
Capture the full stdout + stderr and summarise the last-line JSON outcome
({ ok, articles, stored, failed }) in your reply.
Do NOT spawn subagents. Do NOT call any workflow other than this script.
```

## Required environment

| Env var                   | Required | Purpose                                                                                                                       |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BRAIN_URL`               | YES      | Dashboard origin (the production URL is `https://brain.software2eu.com`).                                                     |
| `BRAIN_BEARER_TOKEN`      | YES      | Set to `$KB_IMAGE_UPLOAD_SECRET` — the same secret the dashboard validates. Set BOTH envs to the same value.                  |
| `ZOHO_DATA_CENTER`        | optional | `eu` / `com` / `in` / … (default `eu`).                                                                                       |
| `ZOHO_STORAGE_STATE_PATH` | one of   | Path to a Playwright storageState JSON the operator captured once (recommended: `/data/zoho-storage-state.json` for persistence). |
| `ZOHO_EMAIL` + `ZOHO_PASSWORD` | one of   | Headless login — only works for accounts without MFA/SSO. The script falls back to this if no storageState is available.       |
| `DRY_RUN`                 | optional | `1` lists the work and exits.                                                                                                  |
| `POLITE_DELAY_MS`         | optional | Sleep between per-image fetches (default `750`).                                                                              |
| `IMPORT_LIMIT`            | optional | Hard cap on images this run (default: no cap).                                                                                |
| `RESUME_STATE_PATH`       | optional | Resume marker file (default `/data/kb-image-import-state.json`).                                                              |

## Behaviour (the morning run)

1. `GET ${BRAIN_URL}/api/wissen/zoho/image-refs?pending=true` — returns
   `{ items: [{ articleId, brainSlug, imageRefs: [{ ref, url, slot }] }] }`,
   already filtered to refs whose storage slot doesn't yet hold bytes (so a
   re-run resumes).
2. `chromium.launch({ headless: true })` + a per-session-source context:
   - `ZOHO_STORAGE_STATE_PATH` present → `browser.newContext({ storageState: ... })`
   - else `ZOHO_EMAIL` + `ZOHO_PASSWORD` set → attempt headless login from
     creds; on success the script also persists the captured state at the same
     path for future runs (no fresh login needed each morning).
   - neither set → fail-fast with a clear reason (an honest "no session
     source configured", NOT a faked run).
3. For each `(articleId, ref)`:
   - `context.request.get(url)` reuses the authenticated cookies + the
     consistent browser IP, so Zoho's session/IP bind is satisfied.
   - Three response shapes are handled:
     - `image/*` → bytes go straight to upload.
     - `application/json` → `/scroll/viewImage.do` envelope; the script reads
       either a `url`/`imageUrl`/`downloadUrl` field (one hop fetch via the same
       authenticated context) or a `data`/`base64` field (decode).
     - `text/html` → session expired → re-capture `storageState`.
   - Upload: `POST ${BRAIN_URL}/api/wissen/zoho/image-upload` with
     `{ articleId, originalRef, bytes (base64), contentType }` and
     `Authorization: Bearer ${BRAIN_BEARER_TOKEN}`. The dashboard validates the
     (articleId, ref) pair against the article's planned `image_refs` and stores
     bytes at the predicted slot (`_raw/kb-zoho/<articleId>/<i>`). The article's
     `<img src>` already points at that slot — no body re-write is needed.
   - Polite delay (`POLITE_DELAY_MS`, default 750ms).
4. Resume state (`RESUME_STATE_PATH`) is updated every 5 successful uploads and
   on exit. A mid-run interruption is recoverable on the next run.
5. The LAST stdout line is a single-line JSON outcome:
   `{ ok, articles, total, stored, skipped, failed, failures: [...] }`. The
   dispatch reads it and summarises.

## Per-image logging (no silent successes)

Every per-image event is one structured JSON line on stdout:

```json
{"level":"info","ts":"...","msg":"image stored","article":"z-100","slot":"_raw/kb-zoho/z-100/0","endpoint":"https://learn.zoho.eu/scroll/viewImage.do?imgurl=abc","status":200,"bytes":4823,"contentType":"image/png"}
{"level":"warn","ts":"...","msg":"image failed","article":"z-101","slot":"_raw/kb-zoho/z-101/1","ref":"...","error":"Zoho returned HTML at ..."}
```

`grep "image failed"` over the log answers “which images failed and why” without
opening the resume-state file.

## Operator setup (one-time)

1. **Storage state (recommended).** SSO/MFA usually rejects headless login, so
   capture a state file once from your workstation:
   ```bash
   npx playwright codegen https://learn.zoho.eu
   # Log in normally → close the inspector → save the saved cookies:
   npx playwright codegen --save-storage=zoho-storage-state.json https://learn.zoho.eu
   ```
   Upload `zoho-storage-state.json` onto the OpenClaw container volume at
   `/data/zoho-storage-state.json` (e.g. via `railway run` / `scp` / a manual
   `cat > /data/zoho-storage-state.json` in a Railway shell). Set
   `ZOHO_STORAGE_STATE_PATH=/data/zoho-storage-state.json` on the Railway
   service. Re-capture only when Zoho logs you out.
2. **Bearer secret.** Set the same `KB_IMAGE_UPLOAD_SECRET` on both the
   dashboard env and this service's env.
3. **Morning run.** Open Wissen-Center → admin sees a "Bilder importieren"
   section → click "Bild-Import starten". The dashboard dispatches this
   workflow, the script runs end-to-end, and the section live-updates with
   `X / Y gespeichert`.

## DO NOT

- Never log the bearer token / storage state cookies. Both go to env / disk only.
- Never improvise the import by writing fake brain bytes if the Zoho session is
  dead — surface the named reason and let the operator re-capture the state.
- Never run more than one importer instance concurrently (the dashboard's
  upload route is idempotent, but parallel runs waste Zoho API budget).
