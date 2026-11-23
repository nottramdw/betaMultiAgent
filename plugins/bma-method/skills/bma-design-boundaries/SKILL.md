---
name: bma-design-boundaries
description: Design types, function signatures and module boundaries before any implementation is written. Use when a task adds a module, a public interface or a data format. For the lead in bma team, so the plan fixes the contract the executor implements.
---

# Design boundaries first

Command: `bma team "<task>"`; used by the lead while planning. Tools: `glob`, `grep`, `read_file`, `delegate` for research.

## Steps

1. **Find the existing contracts.** `grep` for the types, schemas and exports the new code must fit. Read how similar features are structured and follow that structure.
2. **Name the boundary.** Decide which module owns the new behavior and which modules may call it. One owner per piece of state.
3. **Write the types first.** In the plan steps, give the exact type names, fields and function signatures, including error cases. Prefer data that cannot represent invalid states over runtime checks.
4. **Define the inputs that are not trusted.** For every value that comes from a user, a file, a model or the network, say where it is validated and what happens when validation fails.
5. **Fix the compatibility rule.** State whether existing callers, files or outputs change. If they do, list each one in `inScope` and add a stop condition for unexpected callers.
6. **Derive the acceptance criteria** from the contract: one criterion per observable behavior of the boundary, each testable.
7. **Choose verification** that exercises the boundary, such as the package's typecheck and the tests that cover it.

## Output in the plan

- `steps`: types and signatures first, implementation after.
- `inScope`: the owning module and its tests; `outOfScope`: modules that must not change.
- `stopConditions`: for example "a caller outside inScope needs a signature change".
- `acceptance`: behaviors of the boundary.
- `findings`: existing contracts relied on, with `path:line`.
