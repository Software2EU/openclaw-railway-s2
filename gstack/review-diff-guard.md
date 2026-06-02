<!-- s2-diff-guard -->
## Step 3.1: Diff-size scope guard (cost safety — DO NOT SKIP)

`/review` fans out into many parallel specialist subagents (Step 4.5), and each
one re-reads the **entire** diff. On a very large diff that is slow and can cost
tens of dollars in a single run. Before the critical pass, measure the diff and
**hard-stop if it is too large — UNLESS a full audit was explicitly requested.**

```bash
DIFF_BASE=$(git merge-base origin/<base> HEAD)
GUARD_INS=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
GUARD_DEL=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
GUARD_LINES=$((GUARD_INS + GUARD_DEL))
GUARD_FILES=$(git diff "$DIFF_BASE" --name-only | wc -l | tr -d ' ')
# Explicit override: env GSTACK_FULL_AUDIT=1 (deliberate full-codebase audit).
GUARD_OVERRIDE=0
[ "${GSTACK_FULL_AUDIT:-0}" = "1" ] && GUARD_OVERRIDE=1
echo "DIFF GUARD: ${GUARD_LINES} changed lines across ${GUARD_FILES} files (limit 2000 lines / 40 files); override(GSTACK_FULL_AUDIT)=${GUARD_OVERRIDE}"
```

**Decision:**

- **If `GUARD_LINES` ≤ 2000 AND `GUARD_FILES` ≤ 40:** within limits — continue
  normally to Step 4.
- **If over the limit, an override applies when EITHER is true:**
  1. `GUARD_OVERRIDE=1` (the env var `GSTACK_FULL_AUDIT=1` is set), OR
  2. the user's review request contains the exact phrase **`full audit confirmed`**.
- **If over the limit AND an override applies:** proceed with the full review.
  Print one line first: `⚠ Diff over limit (${GUARD_LINES} lines / ${GUARD_FILES} files) — full-audit override active; proceeding (this run will be expensive).` Then continue to Step 4.
- **If over the limit AND NO override applies: STOP NOW.** Do not run the critical
  pass (Step 4) and do not dispatch any specialists (Step 4.5). Output exactly
  this, then end the skill with telemetry status `abort`:

> ⚠ **Diff too large for auto-review** — {GUARD_LINES} changed lines across
> {GUARD_FILES} files (limit: 2000 lines / 40 files). A full /review would fan out
> many parallel specialists over this diff at high cost. Either **scope it down**
> (review a single commit range, a subdirectory `git diff <base> -- <path>`, or
> split the branch) and re-run, **or** if you intend a deliberate full-codebase
> audit, re-run with `GSTACK_FULL_AUDIT=1` set or include the phrase
> `full audit confirmed` in your request.

This guard is intentional cost protection (a single unscoped /review on a ~10k-line
diff cost ~$33). The default is BLOCK; the override is for an INTENTIONAL full audit
only — never bypass it silently.
<!-- /s2-diff-guard -->
