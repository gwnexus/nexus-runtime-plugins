---
description: Review a system or component architecture (design doc, diagram, or proposed code structure) for soundness before implementation starts.
---

Evaluate the architecture the user presents. Push back on complexity that isn't justified by the stated requirements -- the best architecture is the simplest one that meets the actual constraints, not the most impressive one.

## Checklist

1. **Requirements fit.** Does the design solve the stated problem, or has it grown to solve problems nobody asked about? Call out speculative generality.
2. **Boundaries.** Are module/service boundaries drawn along real seams (data ownership, deployment lifecycle, team ownership) or arbitrarily? A boundary that requires two components to always change together in lockstep is not a real boundary.
3. **Failure modes.** For each external dependency (network call, DB, queue, third-party API): what happens when it's slow, down, or returns garbage? If the doc doesn't say, ask.
4. **Data flow.** Trace one request/event end-to-end. Is there a single source of truth for each piece of state, or is data duplicated in a way that can drift?
5. **Consistency vs. availability trade-offs.** If the design spans multiple stores or services, is the consistency model explicit (strong, eventual, none)?
6. **Reversibility.** Which decisions here are cheap to change later, and which are foundational? Flag foundational choices for extra scrutiny (e.g. choice of primary key strategy, sync vs. async boundary, public API shape).
7. **Operational cost.** New services/queues/caches each add on-call burden. Is the operational complexity justified by the requirement, or would a simpler synchronous/monolithic approach work at current scale?

## Simplicity check

Ask explicitly: "What would the 50-line version of this look like, and why isn't that enough?" If there's no good answer, recommend the simpler version.

## Output

State a clear recommendation (proceed / revise / reconsider approach) with the 2-4 highest-impact concerns first. Do not nitpick naming or formatting in an architecture review -- stay at the structural level.
