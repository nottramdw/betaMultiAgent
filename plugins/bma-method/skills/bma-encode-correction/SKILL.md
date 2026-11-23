---
name: bma-encode-correction
description: Turn a mistake that keeps recurring into a constraint the toolchain enforces, choosing the strongest available layer. Use after a reviewer or user corrects the same kind of error twice. For the lead and executor in bma team.
---

# Encode a correction

Command: `bma team "<correction to encode>"`. The lead chooses the layer and plans it; the executor implements it.

## Layers, strongest first

1. **Architecture.** Make the mistake impossible: remove the API that allows it, move ownership, make the invalid state unrepresentable.
2. **Types, lint or CI.** Make the mistake fail the build: a stricter type, a lint rule, a repository check script.
3. **Tests.** Make the mistake fail a test that names the invariant.
4. **Written rules.** Project instructions or docs. Use only when no check can express the rule.

Choose the highest layer that is proportionate to the cost of the mistake. Record why higher layers were rejected.

## Steps

1. **State the mistake** as a concrete example: the wrong code, the correct code, and where it happened (`path:line`, commit or review finding).
2. **Find every existing instance.** `grep` for the pattern. The constraint must either fix them or the plan must list them.
3. **Pick the layer** as above.
4. **Write the constraint** so that it fails on the wrong example and passes on the correct one. Its error message must say what to do instead.
5. **Prove it bites.** Verification must show the constraint failing on the bad pattern, for example a test fixture containing it, and passing on the repository.
6. **Avoid noise.** No allow-lists that silently grow; if exceptions are needed, each one carries a reason.

## Output

- Plan `acceptance`: "the bad example fails with message X", "the repository passes".
- `findings`: the instances found, with `path:line`.
- Return with the packet from `bma-working-principles`, including which layer was chosen and why.
