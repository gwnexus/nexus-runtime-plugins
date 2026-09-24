---
description: Review an Architecture Decision Record (ADR) for completeness, internal consistency, and alignment with existing decisions before it is accepted.
---

Review the ADR the user points to (a file, a pasted draft, or the current diff) against this checklist. Be concise and actionable -- flag problems, do not rewrite the whole document unless asked.

## Structure
- Context section states the problem being solved and why it matters now, not just background.
- Decision section is a single clear statement of what was chosen, not a menu of options.
- Consequences section covers both benefits and costs/trade-offs -- a consequences section with only upside is incomplete.

## Content checks
- **Alternatives considered.** If the ADR doesn't mention at least one rejected alternative, ask why -- either it wasn't a real decision or the rationale is missing.
- **Reversibility.** Is this a one-way door or a two-way door? Flag if the ADR doesn't say, since that changes how much scrutiny it deserves.
- **Conflicts.** Check for existing ADRs or code that contradict this decision. Search the repo/knowledge base for related prior decisions before approving.
- **Scope creep.** The decision should be one coherent choice, not several bundled together. Split if it covers unrelated concerns.
- **Testability of consequences.** Claims like "this will improve performance" should have a way to verify them later, even informally.

## Red flags to call out explicitly
- Vague decision language ("we will consider...", "we may...") -- an ADR should commit.
- Missing owner/date/status.
- No mention of what happens to existing code/data under the new decision (migration path).

## Output
Give a short verdict (accept / needs revision / reject) with the specific line items that need to change, referencing section names, not line numbers (ADRs are usually short prose, not code).
