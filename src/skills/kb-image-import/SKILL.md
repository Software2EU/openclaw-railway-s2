---
name: kb-image-import
purpose: |
  Pull Zoho Learn article images that the dashboard cannot fetch (session +
  IP-bound endpoints) into the brain via a headless Playwright session.
trigger:
  - "Run the knowledge-center skill \"kb-image-import\""
  - "kb-image-import"
inputs:
  - BRAIN_URL: dashboard origin
  - BRAIN_BEARER_TOKEN: KB_IMAGE_UPLOAD_SECRET
  - ZOHO_STORAGE_STATE_PATH OR ZOHO_EMAIL+ZOHO_PASSWORD
  - DRY_RUN: optional
---

# kb-image-import — Knowledge Center image importer

See the full spec in
[`src/workflows/kb-image-import.md`](../../workflows/kb-image-import.md).

## What this skill does

The dashboard plans every Zoho image's destination slot during text sync, so
each article carries a `image_refs: ref|url|slot` frontmatter row. This skill:

1. fetches the work-list from `${BRAIN_URL}/api/wissen/zoho/image-refs?pending=true`,
2. launches headless Chromium with a Zoho session (storageState or login),
3. for each (article × ref) GET-fetches the image inside the authenticated
   browser context (matches Zoho's session + IP bind),
4. POSTs the bytes to `${BRAIN_URL}/api/wissen/zoho/image-upload`.

## How to run it

```bash
BRAIN_URL='https://brain.software2eu.com' \
BRAIN_BEARER_TOKEN="$KB_IMAGE_UPLOAD_SECRET" \
ZOHO_STORAGE_STATE_PATH=/data/zoho-storage-state.json \
DRY_RUN=0 \
node /data/workspace/skills/kb-image-import/run.js
```

The LAST line of stdout is a single-line JSON outcome the dispatch parses:

```json
{"ok":true,"articles":12,"total":54,"stored":52,"skipped":0,"failed":2,"failures":[...]}
```

## Resumability

- The dashboard work-list ALREADY filters out refs whose storage slot has bytes,
  so a re-run skips completed images server-side.
- A local resume marker (`/data/kb-image-import-state.json`) records every
  successful `(articleId, slot)` pair as a belt-and-suspenders skip.

## Honest failure modes

| Symptom (last-line outcome)        | Most likely cause                                                         | Operator fix                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ok:false, error:"BRAIN_URL ..."`  | The dispatch didn't pass env. Check the dispatch message + Railway env.   | Set BRAIN_URL/BRAIN_BEARER_TOKEN on the OpenClaw service.                            |
| `Zoho authentication failed`       | No storageState + login from credentials hit MFA/SSO.                     | Capture a storageState (see workflows .md) and set `ZOHO_STORAGE_STATE_PATH`.        |
| `HTML at ... session is expired`   | StorageState expired (Zoho rotated the cookie or your account signed out). | Re-capture the storageState locally and upload it again.                             |
| `upload failed: HTTP 400 No planned slot` | The dashboard hasn't planned this image (text sync didn't run, or article changed). | Re-run the Zoho TEXT sync first (Wissen-Center → Jetzt synchronisieren).             |
| `upload failed: HTTP 409`          | `KB_IMAGE_UPLOAD_SECRET` is unset on the dashboard side.                  | Set the same value on both envs.                                                     |

## DO NOT

- Spawn subagents.
- Improvise: if the script reports `ok:false`, do not invent a successful answer.
- Log the bearer token or storage state contents.
