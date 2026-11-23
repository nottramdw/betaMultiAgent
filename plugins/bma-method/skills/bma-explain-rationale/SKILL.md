---
name: bma-explain-rationale
description: Explain why code is the way it is, using git history and project documents as sources. Use for "why was this done", "why not the obvious alternative", or before reverting a design decision. Needs bma run with an exact git rule; falls back to reading files.
---

# Explain rationale

Command: `bma run "<question>"` with the default executor role, which has `run_command`. Read-only team roles cannot run git; they use the fallback below.

A `git` command with no matching rule asks the user for approval, so history reads work interactively. `git` rules never use a trailing `*`; a rule matches only the exact argv, including the file path. To pre-approve one read in a trusted workspace:

```json
{ "kind": "exec", "match": ["git", "log", "--follow", "--format=%h %ad %s", "--date=short", "--", "src/module.ts"], "decision": "allow" }
```

Use the same argv when you call `run_command`. Without approval or a rule, mark the history step NOT_RUN and use the fallback.

## Steps

1. **Locate the code** in question with `grep` and `read_file`. Record `path:line`.
2. **Read the history** when git is permitted: `git log` for the file, then `git show <commit>` for the commits that introduced or last changed the lines. Record each commit hash and its message.
3. **Read the documents.** `glob` for `docs/**`, `README*`, `CHANGELOG*`, design notes and plan files. Search them for the identifiers involved.
4. **Fallback without git.** Use documents, tests and nearby code only, and state that history was not available.
5. **Classify each reason** as one of:
   - *Stated*: written in a commit message or document. Cite it.
   - *Implied by constraints*: follows from a test, limit or interface you read. Cite the constraint.
   - *Inferred*: plausible but unsupported. Label it `Inference:`.
6. **Answer the alternative.** If the question names an alternative, say what in the sources rules it out, or that nothing does.

## Output

- The reasons, each with its class and source.
- What would change if the reason no longer held.
- Return with the packet from `bma-working-principles`.
