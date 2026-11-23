---
name: bma-teach-codebase
description: Teach a newcomer one area of a codebase by combining a traced explanation of how it works with the reasons behind it. Use for onboarding questions such as "walk me through the permission engine". Best with bma run.
---

# Teach a codebase area

Command: `bma run "<area to learn>"`. Uses `bma-explain-mechanics` and `bma-explain-rationale`; load both with `load_skill`.

## Steps

1. **Bound the area.** Name the directory or module and the one or two questions a newcomer must be able to answer afterwards. Say what is out of scope.
2. **Map it.** `glob` the area. List its files with one line each on their role, from `read_file` of their exports and imports.
3. **Trace one main path** with `bma-explain-mechanics`: the most common use, from entry to effect.
4. **Explain the key decisions** on that path with `bma-explain-rationale`. Choose at most three: the ones a newcomer would most likely get wrong.
5. **Point to the tests** that pin the behavior, so the reader can check claims and experiment.
6. **Give exercises.** Two or three small questions the reader can answer by reading specific files, with the file to start from.

## Output

```
Area: <module> — <one sentence>
Map: <file — role>, ...
Main path: <numbered trace with path:line>
Decisions: <decision — reason — source class>
Tests: <path — what it pins>
Exercises: <question — start at path>
```

Return with the packet from `bma-working-principles`. Mark anything not traced as `Inference:`.
