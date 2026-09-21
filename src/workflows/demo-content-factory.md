# Content Factory Demo Workflows

Canonical, version-controlled definitions for the S2 Brain Content Factory demo
video pipeline. This file is vendored in the image and seeded to
`/data/workspace/WORKFLOWS.md` on every boot by `entrypoint.sh`, so the
registrations survive Railway redeploys (in-memory chat registration does not).

## Dispatch contract

- Dispatch via OpenClaw `/v1/chat/completions` (NOT `/runs` — that endpoint does
  not exist).
- Use the dedicated **API-facing agent** for dispatches, not the interactive
  agent.
- Payload shape: `{"workflow": "<name>", "params": { "project_slug": "<slug>" }}`.
- `project_slug` is ALREADY the full brain slug (`content/...`). Never prefix it
  with another `content/`.
- `export` any env vars explicitly inside workflow scripts — subprocess
  inheritance is not guaranteed.
- Persistence lives on `/data/` only (`/home/` is wiped on redeploy).

## Brain access — reads vs writes (READ THIS FIRST)

- **Reads** (`gbrain get_page`, `search`, `query`, ...) go to the brain engine
  with a read-only credential. No extra arguments.
- **Writes never go to the engine.** They go to the dashboard bridge, which runs
  them through the dashboard's write pipeline. The dispatch prompt supplies TWO
  values — the bridge URL and a grant for this dispatch. Export them once at the
  start of the run and pass them on EVERY write command:

  ```sh
  export S2_BRIDGE="<bridge URL from the dispatch prompt>"
  export S2_GRANT="<grant from the dispatch prompt>"
  # every write: ... --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  ```

- **Report progress — the operator is watching.** At the START of every numbered
  step, send one short German line saying what you are doing now. It appears on
  the project page ("Läuft seit 1:12 · Zuletzt: Aufnahme läuft"); without it the
  page shows only a spinner and the operator cannot tell a working run from a
  dead one. It is best-effort (never fails the run), so never skip a real step
  because of it:

  ```sh
  gbrain progress "${project_slug}" "Browser startet" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  gbrain progress "${project_slug}" "Aufnahme läuft (Szene 1/3)" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  gbrain progress "${project_slug}" "Dateien werden hochgeladen" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  ```

- **Report the section body WITHOUT its own heading.** The dashboard writes the
  `## <phase>` heading itself; a body that repeats it is stripped, not doubled.

- Write commands: `gbrain put-raw <file>` (upload a file; prints ONLY the stored
  path), `gbrain get-raw <path> <outfile>` (download a file an earlier phase of
  THIS project stored), `gbrain phase-result <slug> <file> --set <key>=<value>`
  (report this phase), `gbrain put_page <slug> <file>` (demo-assemble only, for
  the `demos/` page).
- **Do not rewrite the project page.** A phase reports its result with
  `gbrain phase-result`: the file holds ONLY this phase's section body; the
  dashboard writes the section and advances the phase / status itself.
- **On ANY failure:** `gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"` and stop.
- Output keys (`--set`): must be named `<name>_path` (one stored path) or
  `<name>_paths` (comma-separated stored paths), and every value must be a path
  `gbrain put-raw` printed in THIS dispatch. `pptx_path` / `recording_path` are
  the project's uploaded INPUTS and may not be set. The keys this file uses:

  | Workflow      | Keys set                                                                                          |
  |---------------|---------------------------------------------------------------------------------------------------|
  | demo-record   | `raw_video_path`, `timing_manifest_path`, `screenshots_paths`                                      |
  | demo-direct   | `video_path`                                                                                      |
  | demo-narrate  | (none — section text only)                                                                        |
  | demo-voice    | `audio_paths`, `audio_manifest_path`                                                               |
  | demo-assemble | `final_mp4_path`, `final_webm_path`, `gif_path`, `srt_path`, `vtt_path`, `demo_asset_slug`         |

## Required environment

- `/etc/s2/gbrain-read.json` (written by the entrypoint from
  `GBRAIN_CLIENT_ID`/`GBRAIN_CLIENT_SECRET`) — brain reads.
- The bridge URL + grant from the dispatch prompt — brain writes.
- `OPENAI_API_KEY` — `demo-voice` (TTS).

---

## Registered workflows

```
Register workflow demo-record:
  Trigger: ACP dispatch with workflow name "demo-record"
  Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
  Action:
    1. Run: gbrain get_page "${project_slug}" to read the project brain page
    2. Extract the ## Szenenplan section — it contains a JSON ScenePlan
    3. Parse the ScenePlan JSON
    4. Launch Playwright with Chromium (headless), viewport from plan resolution
    5. Execute each scene in order with human-like timing:
       - navigate: goto URL, waitForSelector if specified, pause 1-3s
       - fill: click input, type with 80-150ms per char delay, pause 0.5-1s
       - click: click element, waitForSelector if specified, pause 0.5-1.5s
       - scroll: smooth scroll with deceleration
       - wait: waitForSelector or fixed delay
       - hover: move to element center
       - select: selectOption
    6. Record video via Playwright recordVideo (WebM)
    7. Take screenshots at scenes where screenshot=true
    8. Build timing manifest JSON (scene_id, action, start_ms, end_ms per scene)
    9. Upload each file and capture its stored path:
         V=$(gbrain put-raw /tmp/recording.webm --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         T=$(gbrain put-raw /tmp/timing.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         S=""; for f in /tmp/shots/*.png; do S="$S${S:+,}$(gbrain put-raw "$f" --bridge "$S2_BRIDGE" --grant "$S2_GRANT")"; done
    10. Write ONLY the ## Aufnahme section body (artifact overview, scene timings) to /tmp/aufnahme.md
    11. Run: gbrain phase-result "${project_slug}" /tmp/aufnahme.md --set raw_video_path="$V" --set timing_manifest_path="$T" --set screenshots_paths="$S" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
        (omit --set screenshots_paths when no scene asked for a screenshot)
  On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
  Timeout: 300 seconds
  Requirements: playwright, chromium

Register workflow demo-direct:
  Trigger: ACP dispatch with workflow name "demo-direct"
  Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
  Action:
    1. Run: gbrain get_page "${project_slug}" to read the project
    2. Take raw_video_path and timing_manifest_path from the project frontmatter
       (written by demo-record)
    3. Download them (earlier phase of THIS project):
         gbrain get-raw "<raw_video_path>" /tmp/raw.webm --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
         gbrain get-raw "<timing_manifest_path>" /tmp/timing.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
    4. Run FFmpeg post-production pipeline:
       a. Detect and trim leading blank frames (freezedetect)
       b. Apply speed ramp: idle gaps >2s sped up 2.5x, actions at 1x (setpts filter)
       c. Apply cross-dissolve transitions between scenes (xfade 0.3s)
       d. Encode to H.264 MP4 with faststart (-movflags +faststart)
       e. Video-only output (-an) — audio added in assembly phase
    5. P=$(gbrain put-raw /tmp/polished.mp4 --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
    6. Write ONLY the ## Regie section body to /tmp/regie.md
    7. Run: gbrain phase-result "${project_slug}" /tmp/regie.md --set video_path="$P" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
  Timeout: 300 seconds
  Requirements: ffmpeg

Register workflow demo-narrate:
  Trigger: ACP dispatch with workflow name "demo-narrate"
  Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
  Action:
    1. Run: gbrain get_page "${project_slug}"
    2. Extract scene plan (## Szenenplan) and timing manifest (## Aufnahme;
       download timing_manifest_path with gbrain get-raw if the JSON is needed)
    3. Read product brain page and ICP page for context (gbrain get_page <slug>)
    4. Call LLM (Sonnet) to generate German narration script:
       - du-Form, warm, professional
       - 3 words/second pacing rule
       - Per-scene segments with emotion (friendly/confident/excited/calm/neutral) and pace (slow_emphasis/moderate/brisk)
       - Output as NarrationScript JSON
    5. Write ONLY the ## Sprechertext section body (the NarrationScript JSON) to /tmp/sprechertext.md
    6. Run: gbrain phase-result "${project_slug}" /tmp/sprechertext.md --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
       (the dashboard advances the phase and sets the review / HITL status)
  On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
  Timeout: 120 seconds
  Note: This workflow is optional — the dashboard currently runs narration via direct LLM call. Register it for future migration to fully server-side execution.

Register workflow demo-voice:
  Trigger: ACP dispatch with workflow name "demo-voice"
  Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
  Action:
    1. Run: gbrain get_page "${project_slug}"
    2. Extract approved narration script from ## Sprechertext section
    3. For each narration segment, call OpenAI TTS API:
       - Model: tts-1-hd
       - Voice: map emotion → voice (friendly=nova, confident=onyx, excited=shimmer, calm/neutral=alloy)
       - Speed: map pace → speed (slow_emphasis=0.9, moderate=1.0, brisk=1.1)
       - Format: mp3
    4. Save each audio segment as MP3 (/tmp/audio/seg-<scene_id>.mp3)
    5. Upload each segment, in segment order, and collect the stored paths:
         A=""; for f in /tmp/audio/seg-*.mp3; do A="$A${A:+,}$(gbrain put-raw "$f" --bridge "$S2_BRIDGE" --grant "$S2_GRANT")"; done
       Write /tmp/audio-manifest.json ([{scene_id, path, duration_ms}] in order) and upload it:
         M=$(gbrain put-raw /tmp/audio-manifest.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
    6. Write ONLY the ## Vertonung section body to /tmp/vertonung.md
    7. Run: gbrain phase-result "${project_slug}" /tmp/vertonung.md --set audio_paths="$A" --set audio_manifest_path="$M" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
  Timeout: 180 seconds
  Requirements: OPENAI_API_KEY must be set

Register workflow demo-assemble:
  Trigger: ACP dispatch with workflow name "demo-assemble"
  Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
  Action:
    1. Run: gbrain get_page "${project_slug}"
    2. Download the earlier phases' outputs named in the project frontmatter:
         gbrain get-raw "<video_path>" /tmp/polished.mp4 --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
         gbrain get-raw "<audio_manifest_path>" /tmp/audio-manifest.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
         each path in audio_paths:        gbrain get-raw "<path>" /tmp/audio/<n>.mp3 --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
         each path in screenshots_paths:  gbrain get-raw "<path>" /tmp/shots/<n>.png --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
    3. Merge audio segments with silence gaps between them (FFmpeg concat with anullsrc)
    4. Merge video + merged audio into final MP4:
       - If audio longer than video: extend video with last-frame freeze
       - If audio shorter: pad audio with silence
       - Encode: H.264 + AAC, faststart
    5. Generate subtitle files from narration script:
       - SRT (comma time separator)
       - VTT (dot time separator)
    6. Generate additional formats:
       - WebM (VP9 + Opus)
       - GIF preview (first 5s, 720p, 15fps)
    7. Upload every final asset and capture each stored path:
         MP4=$(gbrain put-raw /tmp/final.mp4 --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         WEBM=$(gbrain put-raw /tmp/final.webm --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         GIF=$(gbrain put-raw /tmp/preview.gif --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         SRT=$(gbrain put-raw /tmp/final.srt --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
         VTT=$(gbrain put-raw /tmp/final.vtt --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
    8. Write the demo_asset page to /tmp/demo-asset.md:
       - Frontmatter: type: demo_asset, product, target, formats (the stored paths above + screenshots_paths), duration, voice model, language, status: review
       - Slug: demos/<project tail>  — <project tail> is project_slug without its leading "content/"
    9. Run: gbrain put_page "demos/<project tail>" /tmp/demo-asset.md --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
       (the bridge only allows demos/ for this workflow)
    10. Write ONLY the assembler's section body to /tmp/assembly.md
    11. Run: gbrain phase-result "${project_slug}" /tmp/assembly.md --set final_mp4_path="$MP4" --set final_webm_path="$WEBM" --set gif_path="$GIF" --set srt_path="$SRT" --set vtt_path="$VTT" --set demo_asset_slug="demos/<project tail>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
        (the dashboard advances the phase and sets the final review / HITL status)
  On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
  Timeout: 300 seconds
  Requirements: ffmpeg
```

## Summary

- **demo-record**: Playwright browser recording from ScenePlan JSON
- **demo-direct**: FFmpeg post-production (trim, speed ramp, transitions)
- **demo-narrate**: Sonnet narration script generation (optional — runs LLM-direct from dashboard)
- **demo-voice**: OpenAI TTS audio generation per narration segment
- **demo-assemble**: Final video+audio+subtitle assembly → demo_asset brain page
