---
description: Review documentation (README, API docs, inline comments, migration guides) for accuracy, completeness, and whether it actually helps the reader accomplish their task.
---

Review the documentation in scope against the code/system it describes. Documentation review is not a grammar check -- the primary question is: "if a new reader followed this exactly, would it work?"

## Checklist

- **Accuracy.** Every command, code sample, config value, and API signature actually matches the current codebase. Run/trace through examples if feasible rather than assuming they're correct.
- **Completeness for the stated purpose.** A "getting started" doc should get a reader from zero to a working state with no undocumented prerequisite steps. Flag any assumed knowledge or missing setup step.
- **Staleness signals.** References to removed features, old version numbers, deprecated flags, or renamed concepts that weren't updated.
- **Structure.** Can a reader scanning headers find what they need, or is critical information buried in prose? Prefer short sections with clear headers over long unbroken paragraphs for reference material.
- **Audience match.** Is the level of detail appropriate for who reads this doc (end user vs. contributor vs. operator)? A README shouldn't require reading the source to understand a basic example.
- **Consistency with other docs.** Terminology matches other docs and the codebase (no doc calling something a "widget" when the code calls it a "component").
- **Links and cross-references.** Internal links resolve, external links still exist.

## Red flags
- Instructions that require an undocumented environment variable, file, or prior step.
- Sample code that would not compile/run as written.
- Claims that aren't backed by anything checkable ("this is fast", "this is secure") without a way to verify.

## Output

List concrete fixes with the exact line/section and the corrected text (or the missing text to add). If the doc is fundamentally out of date rather than needing edits, say so and recommend a rewrite scope instead of patching around it.
