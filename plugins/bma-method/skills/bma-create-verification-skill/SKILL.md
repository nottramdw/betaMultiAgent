---
name: bma-create-verification-skill
description: Create a repository skill that tells agents how to launch, health-check, drive, capture and clean up a project's CLI or API, so changes can be verified end to end. Use when a project lacks a repeatable way to exercise its program. For the executor in bma team.
---

# Create a verification skill

Command: `bma team "Create a verification skill for <program>"`. The lead plans; the executor writes `.bma/skills/<name>/SKILL.md` in the repository. Tools: `read_file`, `glob`, `grep`, `write_file`, `run_command`.

## Gather facts first

1. **How it starts.** Read the package scripts, build files and README for the build and run commands, required environment variables (names only, never values), ports and data directories.
2. **How health is shown.** A `--version` flag, a `doctor` command, a health endpoint, or a log line that marks readiness.
3. **How it is driven.** The smallest real interaction: one CLI invocation with arguments, or one HTTP request.
4. **What to capture.** Exit code, stdout and stderr tails, response status and body, files written.
5. **How it stops.** The process to terminate, temporary directories and ports to free.

Run each command once through `run_command` to confirm it works. Record what you ran and the exit codes; if a command needs approval and is not approved, mark it NOT_RUN.

## Skill layout

The generated `SKILL.md` has frontmatter with `name` and `description`, then five sections in this order:

1. **Launch**: build and start commands, as argv arrays, with the working directory.
2. **Doctor**: the health check and the expected result.
3. **Drive**: one or more interactions, each with input and expected output.
4. **Capture**: what to record and how to bound it (tail lengths, timeouts).
5. **Cleanup**: how to stop the program and remove temporary state, safe to run twice.

## Rules

- No secrets, tokens or personal paths in the skill.
- Commands are argv arrays, run without a shell, so they can be matched by exact `exec` rules.
- Every expected result is checkable by an agent without judgment: an exit code, a substring, a status code.
- Keep the skill under the 64 KiB skill file limit; no scripts.

## Output

Acceptance criteria for the plan: each section exists, each command ran with the recorded exit code, and cleanup leaves no process or temporary directory. Return with the packet from `bma-working-principles`.
