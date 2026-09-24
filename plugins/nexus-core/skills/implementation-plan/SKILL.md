---
description: Turn a feature request, bug report, or task description into a concrete, verifiable implementation plan before writing code.
---

Convert the task into a plan the user can approve or correct before implementation starts. Do not start writing code until the plan is confirmed for anything non-trivial (multi-file changes, new dependencies, schema changes, or anything with more than one reasonable approach).

## Steps

1. **Restate the goal** in one or two sentences, in your own words, to confirm shared understanding. If anything is ambiguous, ask before proceeding -- do not guess and silently pick an interpretation.
2. **Identify the smallest change that satisfies the requirement.** State it explicitly. If a broader refactor seems tempting, note it but exclude it from the plan unless the user asks for it.
3. **List affected files/modules** based on actually reading the relevant code, not assumptions about where things "usually" live in a codebase like this.
4. **Call out unknowns and risks**: existing behavior that might be relied upon elsewhere, external dependencies, data migrations, backward compatibility.
5. **Define verification steps** up front: which tests will prove this works (existing tests to run, new tests to write, manual steps if no automated check exists). A plan without a verification step is incomplete.
6. **Sequence the work** into an ordered list of concrete steps (not vague phases like "implement backend" -- name the functions/files).
7. **State what is explicitly out of scope**, especially anything adjacent that might look related but wasn't asked for.

## Rules

- If multiple valid approaches exist, present them with trade-offs and a recommendation -- don't pick silently.
- If the request implies a larger scope than what was literally asked, flag the gap rather than silently expanding or silently under-delivering.
- Prefer the simplest approach that meets the actual requirement; note when a more robust approach would cost significantly more effort and let the user decide.

## Output

A numbered plan (goal, approach, affected files, risks, verification, sequence, explicit non-goals). Wait for confirmation before implementing, unless the user has already said "go ahead" for this specific task.
