---
name: bma-benchmark-checklist
description: Check that a performance or cost measurement supports its conclusion before it is accepted. Use when a change claims to be faster, cheaper or smaller, or when reviewing benchmark code and results. For the reviewer in bma team, or bma run for a standalone check.
---

# Benchmark checklist

Command: `bma team` (reviewer assessing a claim) or `bma run "<check this measurement>"`. Tools: `read_file`, `grep`, and `run_command` where the role has it.

## Checklist

Mark each item PASS, FAIL or NOT_RUN with evidence.

1. **Question.** The claim names the metric, the unit, the workload and the comparison (before vs after, A vs B).
2. **Same conditions.** Both sides ran on the same machine, inputs, configuration, versions and data size. Differences are listed.
3. **Warm-up and caching.** The first runs are excluded or reported separately; caches (disk, compiler, prompt cache, CDN) are either controlled or stated.
4. **Repetitions.** Enough runs to see variance. Report median and spread (min–max or percentiles), not a single run or only the mean.
5. **Effect size against noise.** The difference is larger than the run-to-run spread. If not, the result is "no detectable difference".
6. **Measured thing.** The timer or counter wraps the code in question and not setup, I/O or logging. Read the harness to confirm.
7. **Correctness.** The faster or cheaper variant still produces correct output; a check runs on it.
8. **Cost accounting.** For model runs: tokens split into input, cached input and output; prices from the provider's current list; retries and failed runs counted.
9. **Reproducibility.** The command, commit and configuration needed to rerun are recorded.

## Windows variant

- Antivirus scanning and file indexing slow file-heavy workloads; note whether the work directory is excluded.
- Path length, line endings (`core.autocrlf`) and symlink permissions change behavior; record the settings.
- Power plan and thermal throttling affect laptops; record the power mode.
- Use `process.hrtime.bigint()` or `performance.now()`, not `Date.now()`, for short intervals.

## Output

The checklist with a status per item, then a verdict: the claim is supported, not supported, or not testable as stated. Reviewers map the verdict onto the criteria and findings of `submit_review`.
