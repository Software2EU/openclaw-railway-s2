# PPTX Content Factory Workflows

## Dispatch Contract

Same as demo workflows: POST to `/v1/chat/completions` with `{"workflow": "<name>", "params": {"project_slug": "<slug>"}}`.
`project_slug` is ALREADY the full brain slug (`content/...`) — never prefix it with another `content/`.

## Brain access — reads vs writes (READ THIS FIRST)

- **Reads** (`gbrain get_page`, ...) go to the brain engine with a read-only credential.
- **Writes never go to the engine.** They go to the dashboard bridge. The dispatch
  prompt supplies TWO values — the bridge URL and a grant for this dispatch.
  Export them once and pass them on EVERY write command:

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

- **Input files** (the uploaded deck / webinar recording) arrive as signed
  download URLs in the dispatch prompt (valid 24h) — fetch them with `curl`:
  the deck to `/tmp/input.pptx`, the recording to `/tmp/input.mp4`. Do not look
  for a `pptx_ref` / `recording_ref` key; there is none.
- **Files an EARLIER phase of this project produced**: take the stored path from
  the project frontmatter and run `gbrain get-raw <path> <outfile> --bridge "$S2_BRIDGE" --grant "$S2_GRANT"`.
- **Output files**: `P=$(gbrain put-raw <file> --bridge "$S2_BRIDGE" --grant "$S2_GRANT")` prints ONLY the stored path.
- **Report the phase** with `gbrain phase-result "${project_slug}" <file> --set <key>=<path> --bridge "$S2_BRIDGE" --grant "$S2_GRANT"`.
  The file holds ONLY this phase's section body; the dashboard writes the section
  and advances the phase itself. **Do not rewrite the project page.**
- **On ANY failure:** `gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"` and stop.
- Output keys must be `<name>_path` (one stored path) or `<name>_paths`
  (comma-separated), with values `gbrain put-raw` printed in THIS dispatch;
  `pptx_path` / `recording_path` are the project's INPUTS and may not be set.
  `has_animations=true|false` is also accepted (pptx-ingest). The keys this file uses:

  | Workflow              | Keys set                                                  |
  |-----------------------|-----------------------------------------------------------|
  | pptx-ingest           | `slides_paths`, `extraction_path`, `has_animations`        |
  | webinar-transcribe    | `transcript_path`                                         |
  | slide-redesign-render | `redesigned_slides_paths`                                 |
  | slide-animate         | `animation_video_path`                                    |
  | slide-present         | `presentation_video_path`                                 |

## Required Environment Variables

- `/etc/s2/gbrain-read.json` (entrypoint, from GBRAIN_CLIENT_ID/GBRAIN_CLIENT_SECRET) — brain reads
- The bridge URL + grant from the dispatch prompt — brain writes
- OPENAI_API_KEY (Whisper transcription in webinar-transcribe)

## Workflows

### pptx-ingest
Trigger: ACP dispatch with workflow name "pptx-ingest"
Parameters: { project_slug: string }   (+ PPTX signed URL, bridge URL and grant in the dispatch prompt)
Action:
  1. gbrain get_page "${project_slug}" — read the project
  2. curl -fL "<PPTX URL from the dispatch prompt>" -o /tmp/input.pptx
  3. Run python3 extract script:
     - python-pptx: extract slide titles, body text, speaker notes, shape metadata
     - Output: /tmp/extraction.json (also note whether any slide carries PowerPoint animations)
  4. Run LibreOffice headless:
     - libreoffice --headless --convert-to png --outdir /tmp/slides/ /tmp/input.pptx
     - Produces one PNG per slide at native resolution
  5. Upload, in slide order:
       S=""; for f in /tmp/slides/*.png; do S="$S${S:+,}$(gbrain put-raw "$f" --bridge "$S2_BRIDGE" --grant "$S2_GRANT")"; done
       E=$(gbrain put-raw /tmp/extraction.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
  6. Write ONLY the ## Folien section body (extraction JSON + slide list) to /tmp/folien.md
  7. gbrain phase-result "${project_slug}" /tmp/folien.md --set slides_paths="$S" --set extraction_path="$E" --set has_animations=<true|false> --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
Timeout: 120 seconds
Requirements: libreoffice-impress, python-pptx

### webinar-transcribe
Trigger: ACP dispatch with workflow name "webinar-transcribe"
Parameters: { project_slug: string }   (+ recording signed URL, bridge URL and grant in the dispatch prompt)
Action:
  1. gbrain get_page "${project_slug}" — read the project
  2. curl -fL "<recording URL from the dispatch prompt>" -o /tmp/input.mp4
  3. FFmpeg: extract audio track if input is video
     - ffmpeg -i /tmp/input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 /tmp/audio.wav
  4. Split audio into ≤25MB chunks if needed (Whisper API limit)
  5. For each chunk, call OpenAI Whisper API:
     - model: whisper-1
     - response_format: verbose_json
     - timestamp_granularities: [segment]
  6. Merge all segment results with offset correction → /tmp/transcript.json
  7. T=$(gbrain put-raw /tmp/transcript.json --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
  8. Write ONLY the ## Transkript section body (timestamped segments JSON) to /tmp/transkript.md
  9. gbrain phase-result "${project_slug}" /tmp/transkript.md --set transcript_path="$T" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
Timeout: 300 seconds
Requirements: ffmpeg, OPENAI_API_KEY

### slide-redesign-render
Trigger: ACP dispatch with workflow name "slide-redesign-render"
Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
Action:
  1. gbrain get_page "${project_slug}" — read the project
  2. Extract HTML slides from the design section (LLM already generated these on the dashboard)
  3. For each HTML slide:
     - Write HTML to temp file
     - Launch Playwright (headless Chromium, viewport 1920×1080)
     - Navigate to file:///tmp/slide-N.html
     - Wait 500ms for fonts
     - Screenshot → /tmp/slide-N-redesigned.png
  4. Upload, in slide order:
       R=""; for f in /tmp/slide-*-redesigned.png; do R="$R${R:+,}$(gbrain put-raw "$f" --bridge "$S2_BRIDGE" --grant "$S2_GRANT")"; done
     (sort numerically so slide-10 follows slide-9)
  5. Write ONLY the design section's result body (redesigned PNG list) to /tmp/design.md
  6. gbrain phase-result "${project_slug}" /tmp/design.md --set redesigned_slides_paths="$R" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
Timeout: 180 seconds
Requirements: playwright, chromium

### slide-animate
Trigger: ACP dispatch with workflow name "slide-animate"
Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
Action:
  1. gbrain get_page "${project_slug}" — read the project
  2. Download the redesigned slide PNGs (earlier phase of THIS project) — each path in redesigned_slides_paths:
       gbrain get-raw "<path>" /tmp/slides/slide-<N>.png --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
  3. Read narration timing from ## Sprechertext section (determines per-slide duration)
  4. For each slide, generate a video segment with Ken Burns effect:
     - Alternate effects: zoom_in → pan_right → zoom_out → pan_left
     - ffmpeg -loop 1 -i slide.png -vf "zoompan=..." -c:v libx264 -t {duration}s segment.mp4
  5. Concatenate all segments with crossfade transitions (0.5s xfade)
  6. Output: silent MP4 (-an), video-only, H.264 with faststart → /tmp/animation.mp4
  7. V=$(gbrain put-raw /tmp/animation.mp4 --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
  8. Write ONLY the ## Animation section body to /tmp/animation.md
  9. gbrain phase-result "${project_slug}" /tmp/animation.md --set animation_video_path="$V" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
Timeout: 300 seconds
Requirements: ffmpeg

### slide-present
Trigger: ACP dispatch with workflow name "slide-present"
Parameters: { project_slug: string }   (+ bridge URL and grant in the dispatch prompt)
Action:
  1. gbrain get_page "${project_slug}" — read the project
  2. Extract animation-injected HTML slides from the design section + narration timing from ## Sprechertext
  3. For each slide:
     - Write the animation-injected HTML to a temp file
     - Launch Playwright (headless Chromium, viewport 1920×1080)
     - Navigate to file:///tmp/slide-N.html
     - Wait 300ms for initial render
     - Read click count from the slide's animation metadata
     - For each click: fire page.click('body'), wait for narration-timed pause
     - Hold on final state for remaining narration duration
  4. Playwright recordVideo captures the entire click-through as WebM → /tmp/presentation.webm
  5. V=$(gbrain put-raw /tmp/presentation.webm --bridge "$S2_BRIDGE" --grant "$S2_GRANT")
  6. Write ONLY the ## Präsentation section body to /tmp/praesentation.md
  7. gbrain phase-result "${project_slug}" /tmp/praesentation.md --set presentation_video_path="$V" --bridge "$S2_BRIDGE" --grant "$S2_GRANT"
On failure: gbrain phase-result "${project_slug}" --failed "<concrete reason>" --bridge "$S2_BRIDGE" --grant "$S2_GRANT" and stop
Timeout: 600 seconds (real-time recording — longer than other phases)
Requirements: playwright, chromium, pptx-viewer-core
Note: This workflow replaces slide-animate for decks that have PowerPoint animations. Static decks still use slide-animate (Ken Burns fallback).
