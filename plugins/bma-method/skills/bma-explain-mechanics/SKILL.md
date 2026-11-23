---
name: bma-explain-mechanics
description: Explain how existing code behaves today by tracing it from an entry point to its effects. Use for "how does X work", "what happens when", or before changing unfamiliar code. Best with bma run; the lead and researcher can use it in bma team.
---

# Explain mechanics

Command: `bma run "<question>"` (any role), or inside `bma team` as the lead or a delegated researcher. Tools: `glob`, `grep`, `read_file`.

## Steps

1. **Restate the question** as one observable behavior: an input, a trigger, or a command, and the effect to explain.
2. **Find the entry point.** `grep` for the command name, exported function, route or event. Confirm with `read_file`. If there are several candidates, list them and say which one the question refers to.
3. **Trace forward.** Follow calls in execution order. For each step record `path:line`, what it receives, what it decides, and what it passes on. Stop at the effect (file written, process run, value returned, error thrown).
4. **Note branches.** For each condition that changes the path, give the condition and where each branch goes. Do not expand branches that the question does not reach.
5. **Check the edges.** Look for error handling, limits and defaults on the traced path. These are where explanations usually go wrong.
6. **Confirm with tests.** `grep` the test directory for the entry point. A test that exercises the path is stronger evidence than reading; cite it.

## Output

- A numbered trace, one line per step: `path:line — what happens`.
- A short answer to the question in plain words, under the trace.
- Unverified links in the chain marked `Inference:`.
- Return with the packet from `bma-working-principles`.

Do not explain why the code was designed this way; that is `bma-explain-rationale`.
