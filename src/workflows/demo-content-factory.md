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
- `export` any env vars explicitly inside workflow scripts — subprocess
  inheritance is not guaranteed.
- Persistence lives on `/data/` only (`/home/` is wiped on redeploy).

## Required environment

- `GBRAIN_URL`, `GBRAIN_CLIENT_ID`, `GBRAIN_CLIENT_SECRET` — gbrain CLU (all
  workflows).
- `OPENAI_API_KEY` — `demo-voice` (TTS) and `demo-assemble` (TTS download).

---

## Registered workflows

```
Register workflow demo-record:
  Trigger: ACP dispatch with workflow name "demo-record"
  Parameters: { project_slug: string }
  Action:
    1. Run: gbrain get-page "content/${project_slug}" to read the project brain page
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
    9. Upload video + screenshots + timing manifest via: gbrain put-raw-data
    10. Update project page: set recorder phase to completed, write ## Aufnahme section with artifact references
    11. Run: gbrain put-page "content/${project_slug}" with updated content
  Timeout: 300 seconds
  Requirements: playwright, chromium

Register workflow demo-direct:
  Trigger: ACP dispatch with workflow name "demo-direct"
  Parameters: { project_slug: string }
  Action:
    1. Run: gbrain get-page "content/${project_slug}" to read the project
    2. Extract recorder artifacts from ## Aufnahme section (video path, timing manifest)
    3. Download the raw video from brain storage via: gbrain get-raw-data
    4. Run FFmpeg post-production pipeline:
       a. Detect and trim leading blank frames (freezedetect)
       b. Apply speed ramp: idle gaps >2s sped up 2.5x, actions at 1x (setpts filter)
       c. Apply cross-dissolve transitions between scenes (xfade 0.3s)
       d. Encode to H.264 MP4 with faststart (-movflags +faststart)
       e. Video-only output (-an) — audio added in assembly phase
    5. Upload polished MP4 via: gbrain put-raw-data
    6. Update project page: set director phase to completed, write ## Regie section
    7. Run: gbrain put-page "content/${project_slug}" with updated content
  Timeout: 300 seconds
  Requirements: ffmpeg

Register workflow demo-narrate:
  Trigger: ACP dispatch with workflow name "demo-narrate"
  Parameters: { project_slug: string }
  Action:
    1. Run: gbrain get-page "content/${project_slug}"
    2. Extract scene plan (## Szenenplan) and timing manifest (## Aufnahme)
    3. Read product brain page and ICP page for context
    4. Call LLM (Sonnet) to generate German narration script:
       - du-Form, warm, professional
       - 3 words/second pacing rule
       - Per-scene segments with emotion (friendly/confident/excited/calm/neutral) and pace (slow_emphasis/moderate/brisk)
       - Output as NarrationScript JSON
    5. Write narration script to ## Sprechertext section
    6. Set narrator phase to completed, project status to review (HITL gate)
    7. Run: gbrain put-page "content/${project_slug}" with updated content
  Timeout: 120 seconds
  Note: This workflow is optional — the dashboard currently runs narration via direct LLM call. Register it for future migration to fully server-side execution.

Register workflow demo-voice:
  Trigger: ACP dispatch with workflow name "demo-voice"
  Parameters: { project_slug: string }
  Action:
    1. Run: gbrain get-page "content/${project_slug}"
    2. Extract approved narration script from ## Sprechertext section
    3. For each narration segment, call OpenAI TTS API:
       - Model: tts-1-hd
       - Voice: map emotion → voice (friendly=nova, confident=onyx, excited=shimmer, calm/neutral=alloy)
       - Speed: map pace → speed (slow_emphasis=0.9, moderate=1.0, brisk=1.1)
       - Format: mp3
    4. Save each audio segment as MP3
    5. Upload all audio segments via: gbrain put-raw-data
    6. Update project page: set voice phase to completed, write ## Vertonung section with audio references
    7. Run: gbrain put-page "content/${project_slug}" with updated content
  Timeout: 180 seconds
  Requirements: OPENAI_API_KEY must be set

Register workflow demo-assemble:
  Trigger: ACP dispatch with workflow name "demo-assemble"
  Parameters: { project_slug: string }
  Action:
    1. Run: gbrain get-page "content/${project_slug}"
    2. Download polished video (from ## Regie) and audio segments (from ## Vertonung)
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
    7. Collect screenshots from recorder phase
    8. Upload all final assets via: gbrain put-raw-data
    9. Create demo_asset brain page:
       - Type: demo_asset
       - Directory: demos/
       - Slug: demos/{product}-{target}-{date}
       - Frontmatter: product, target, formats (mp4/webm/gif/srt/vtt/screenshots), duration, voice model, language
       - Status: review
    10. Run: gbrain put-page for the demo_asset page
    11. Update project page: set assembler phase to completed, project status to review (final HITL gate)
    12. Run: gbrain put-page "content/${project_slug}" with updated content
  Timeout: 300 seconds
  Requirements: ffmpeg, OPENAI_API_KEY (for TTS audio reading — already generated, just downloading)
```

## Summary

- **demo-record**: Playwright browser recording from ScenePlan JSON
- **demo-direct**: FFmpeg post-production (trim, speed ramp, transitions)
- **demo-narrate**: Sonnet narration script generation (optional — runs LLM-direct from dashboard)
- **demo-voice**: OpenAI TTS audio generation per narration segment
- **demo-assemble**: Final video+audio+subtitle assembly → demo_asset brain page
