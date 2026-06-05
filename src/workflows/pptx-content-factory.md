# PPTX Content Factory Workflows

## Dispatch Contract

Same as demo workflows: POST to `/v1/chat/completions` with `{"workflow": "<name>", "params": {"project_slug": "<slug>"}}`.

## Required Environment Variables

- GBRAIN_URL, GBRAIN_CLIENT_ID, GBRAIN_CLIENT_SECRET (brain access)
- OPENAI_API_KEY (Whisper transcription in webinar-transcribe)

## Workflows

### pptx-ingest
Trigger: ACP dispatch with workflow name "pptx-ingest"
Parameters: { project_slug: string }
Action:
  1. gbrain get-page "content/${project_slug}" — read project, extract pptx_ref
  2. gbrain get-raw-data — download the .pptx file to /tmp/
  3. Run python3 extract script:
     - python-pptx: extract slide titles, body text, speaker notes, shape metadata
     - Output: /tmp/extraction.json
  4. Run LibreOffice headless:
     - libreoffice --headless --convert-to png --outdir /tmp/slides/ /tmp/input.pptx
     - Produces one PNG per slide at native resolution
  5. Upload all PNGs via gbrain put-raw-data
  6. Write ## Folien section to project page with extraction JSON + PNG refs
  7. gbrain put-page "content/${project_slug}" — update project, set ingest phase to completed
Timeout: 120 seconds
Requirements: libreoffice-impress, python-pptx

### webinar-transcribe
Trigger: ACP dispatch with workflow name "webinar-transcribe"
Parameters: { project_slug: string }
Action:
  1. gbrain get-page "content/${project_slug}" — read project, extract recording_ref
  2. gbrain get-raw-data — download the audio/video file
  3. FFmpeg: extract audio track if input is video
     - ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.wav
  4. Split audio into ≤25MB chunks if needed (Whisper API limit)
  5. For each chunk, call OpenAI Whisper API:
     - model: whisper-1
     - response_format: verbose_json
     - timestamp_granularities: [segment]
  6. Merge all segment results with offset correction
  7. Write ## Transkript section with timestamped segments JSON
  8. gbrain put-page "content/${project_slug}" — update project, set transcribe phase to completed
Timeout: 300 seconds
Requirements: ffmpeg, OPENAI_API_KEY

### slide-redesign-render
Trigger: ACP dispatch with workflow name "slide-redesign-render"
Parameters: { project_slug: string }
Action:
  1. gbrain get-page "content/${project_slug}" — read project
  2. Extract HTML slides from ## Design section (LLM already generated these on the dashboard)
  3. For each HTML slide:
     - Write HTML to temp file
     - Launch Playwright (headless Chromium, viewport 1920×1080)
     - Navigate to file:///tmp/slide-N.html
     - Wait 500ms for fonts
     - Screenshot → /tmp/slide-N-redesigned.png
  4. Upload all redesigned PNGs via gbrain put-raw-data
  5. Update ## Design section with redesigned PNG refs
  6. gbrain put-page "content/${project_slug}" — update project, set redesign phase to completed
Timeout: 180 seconds
Requirements: playwright, chromium

### slide-animate
Trigger: ACP dispatch with workflow name "slide-animate"
Parameters: { project_slug: string }
Action:
  1. gbrain get-page "content/${project_slug}" — read project
  2. Download redesigned slide PNGs from ## Design section refs
  3. Read narration timing from ## Sprechertext section (determines per-slide duration)
  4. For each slide, generate a video segment with Ken Burns effect:
     - Alternate effects: zoom_in → pan_right → zoom_out → pan_left
     - ffmpeg -loop 1 -i slide.png -vf "zoompan=..." -c:v libx264 -t {duration}s segment.mp4
  5. Concatenate all segments with crossfade transitions (0.5s xfade)
  6. Output: silent MP4 (-an), video-only, H.264 with faststart
  7. Upload animated MP4 via gbrain put-raw-data
  8. Write ## Animation section with video ref
  9. gbrain put-page "content/${project_slug}" — update project, set animate phase to completed
Timeout: 300 seconds
Requirements: ffmpeg
