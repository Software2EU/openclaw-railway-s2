<!-- s2-diff-guard -->
## Step 3.1: Diff-size scope guard (cost safety — DO NOT SKIP)

`/review` fans out into many parallel specialist subagents (Step 4.5), and each
one re-reads the **entire** diff. On a very large diff that is slow and can cost
tens of dollars in a single run. Before the critical pass, measure the diff and
**hard-stop** if it is too large to auto-review.

```bash
DIFF_BASE=$(git merge-base origin/<base> HEAD)
GUARD_INS=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
GUARD_DEL=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
GUARD_LINES=$((GUARD_INS + GUARD_DEL))
GUARD_FILES=$(git diff "$DIFF_BASE" --name-only | wc -l | tr -d ' ')
echo "DIFF GUARD: ${GUARD_LINES} changed lines across ${GUARD_FILES} files (limit 2000 lines / 40 files)"
```

**If `GUARD_LINES` > 2000 OR `GUARD_FILES` > 40: STOP NOW.** Do not run the critical
pass (Step 4) and do not dispatch any specialists (Step 4.5). Output exactly this,
then end the skill with telemetry status `abort`:

> ⚠ **Diff too large for auto-review** — {GUARD_LINES} changed lines across
> {GUARD_FILES} files (limit: 2000 lines / 40 files). A full /review would fan out
> many parallel specialists over this diff at high cost. Scope it down and re-run:
> review a single commit range, a subdirectory (`git diff <base> -- <path>`), or
> split the branch into smaller PRs.

This guard is intentional cost protection (a single unscoped /review on a ~10k-line
diff cost ~$33). Do not bypass it unless the user explicitly asks to review the
entire oversized diff anyway.
<!-- /s2-diff-guard -->
