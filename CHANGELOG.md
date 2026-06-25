# Changelog — OpenClaw Railway S2

Running session history for the OpenClaw worker wrapper. Append new entries at the top; never overwrite prior ones.

---

## Overnight consolidation — spec-kit + kb-image-import (P3)

**P3B — kb-image-import is already gone; stale Dockerfile reference removed.** The retired `kb-image-import` skill has no presence in this repo (no `src/skills/` tree; grepped clean). `entrypoint.sh` already actively prunes any copy a persistent volume carried from an old boot — `rm -rf "$WORKSPACE_DIR/skills/kb-image-import"` (line ~285) and strips the `<!-- s2:kb-image-import -->` block from `WORKFLOWS.md` (lines ~286-294). That cleanup stays. The only residue was a misleading Dockerfile comment (lines 67-68) pointing at a non-existent `src/skills/kb-image-import/run.js` — replaced with an accurate note. Comment-only change; no build impact.

**P3A — spec-kit remap lives in the DASHBOARD, not here.** Verify-first finding: the 4 `/speckit.*` phase workflows (`product-specify/plan/tasks/implement`) are translated to gstack/skill commands by the dashboard's `SKILL_FOR_WORKFLOW` registry (`s2-brain-dashboard/src/lib/workflows/acp-chat.ts`), which mapped them to `/speckit.*`. Spec-Kit is NOT installed in this worker — gstack ships a single `/spec` skill — so those dispatches returned an honest "unknown workflow" refusal (VOID). Installing Spec-Kit here was rejected as the higher-risk option: Spec-Kit ships as `specify init` command-scaffolding (a Python/uv tool that writes `.claude/commands/speckit.*.md`), NOT a clean gstack-style skill-folder `git clone` install line like the existing gstack/gbrain steps, and a failed Docker RUN would dark the worker deploy. The lower-risk fix shipped on the dashboard side: remap the 4 workflows to the installed `/spec` skill (pure string-map, reversible, no build change here). No OpenClaw image change required for P3A.

**Lint:** `node -c src/server.js` passes (server.js untouched).
