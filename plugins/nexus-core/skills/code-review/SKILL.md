---
description: Run a structured code review of the current diff or a specified set of files, covering correctness, security, performance, readability, error handling, and test coverage.
---

Review the code in scope (current git diff by default, or files/PR the user specifies). Report findings with file:line references. Do not rewrite large sections unless asked -- point out problems and suggest a fix.

## Checklist

**Correctness**
- Logic matches the stated intent (check against the PR description/task, not just internal consistency).
- Edge cases: empty input, null/undefined, zero, negative numbers, very large input, concurrent access.
- Off-by-one errors in loops/slicing/pagination.

**Security**
- Injection: SQL, command, path traversal, template injection.
- Auth/authz: is every new endpoint or mutation checking permissions, not just authentication?
- Secrets: no hardcoded credentials, tokens, or keys; no secrets in logs.
- Input validation on anything crossing a trust boundary (user input, external API response).

**Performance**
- N+1 queries, unnecessary loops over large collections, unbounded queries with no pagination/limit.
- Obvious algorithmic issues (e.g. O(n^2) where O(n log n) is easy).
- Unnecessary re-renders/re-computation in hot paths (if UI code).

**Error handling**
- Errors are caught at the right layer, not swallowed silently.
- Error messages are actionable (not just "something went wrong").
- Resources (files, connections, locks) are released on the error path, not just the happy path.

**Readability & maintainability**
- Naming reflects intent.
- Function/method does one thing; if it's doing three things, say so.
- No dead code or commented-out blocks left behind.
- Change is scoped to the task -- flag unrelated refactors mixed into the diff.

**Test coverage**
- New logic has a test that would fail if the logic were wrong (not just a test that exercises the code path).
- Edge cases identified above are covered.
- No test-only code paths leaking into production code.

## Output

Group findings by severity: **blocking** (must fix before merge: correctness/security bugs), **should-fix** (real but not blocking), **nit** (style/preference, clearly labeled as optional). Lead with blocking issues.
