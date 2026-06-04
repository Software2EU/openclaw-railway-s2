# Report: Add FFmpeg to OpenClaw Container

## Summary

Added FFmpeg to the OpenClaw Railway (EU) container to support the new S2 Brain
demo video production pipeline (trimming, speed ramping, transitions, format
conversion).

## Change

One new line added to the `Dockerfile`, placed immediately after the existing
`apt-get` block (lines 8–19), still running as `root` and before
`USER openclaw`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

### Why this placement
- Runs as `root` (before `USER openclaw`), which apt requires.
- Standalone `RUN` keeps the diff to exactly one new line and gives FFmpeg its
  own cache layer.
- `--no-install-recommends` keeps the layer small (~80MB vs ~150MB).
- `rm -rf /var/lib/apt/lists/*` cleans the apt cache from the layer.

## Constraints Honored

| Constraint | Status |
|---|---|
| Only added the FFmpeg line — no other Dockerfile lines changed | ✅ |
| Used `--no-install-recommends` to keep layer small | ✅ |
| No upgrade to Node, Bun, Playwright, or other deps | ✅ |
| No application code changes | ✅ |
| No Railway config or env var changes | ✅ |

## Git

- **Branch:** `claude/add-ffmpeg-container-XeH5b`
- **Commit:** `chore: add ffmpeg to container for demo video pipeline`
- **Pushed:** yes — Railway auto-deploys from push.
- **Pull request:** not opened (none requested).

## Verify After Deploy

Once Railway finishes the build, exec into the container and run:

```bash
ffmpeg -version
```

Expected: FFmpeg 7.x (Debian Bookworm ships 7.x via the `ffmpeg` package).

> Note: Railway console/exec access was not available from this session, so this
> verification step was not run here.
