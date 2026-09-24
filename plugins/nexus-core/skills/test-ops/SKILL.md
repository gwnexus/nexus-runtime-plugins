---
description: Run, triage, and fix failing tests; identify missing test coverage; keep the test suite fast and reliable. Use when asked to "run the tests", "fix failing tests", or "make sure this is tested".
---

Handle test-suite operations end to end: running, diagnosing failures, fixing root causes (not just making a test pass), and identifying coverage gaps.

## When running tests

1. Use the project's actual test command (check `package.json`/`Makefile`/CI config -- don't assume a generic command).
2. Run the narrowest relevant scope first (the file/module you changed), then the full suite before declaring done, unless the suite is prohibitively slow -- ask if unsure.
3. Capture and read the actual failure output, not just pass/fail counts.

## When a test fails

1. **Determine whether the test or the code is wrong.** Do not "fix" a failing test by loosening its assertion unless the assertion was actually incorrect for the new intended behavior -- state which case it is before changing anything.
2. **Find the root cause**, not the symptom. A flaky test that "passes on retry" usually indicates a real race condition or shared-state bug; do not paper over it with retries/sleeps unless that's a deliberate, stated decision.
3. **Reproduce in isolation** before fixing -- run just that test to confirm you can reliably reproduce, then confirm the fix by re-running.

## When asked to add/check test coverage

- Identify untested branches: error paths, edge cases (empty/null/boundary values), and any logic added in the current change.
- A good test asserts behavior, not implementation detail -- avoid tests that would still pass after the logic is broken (e.g. mocking away the thing being tested).
- Don't add trivial tests that assert nothing meaningful just to raise a coverage number.

## Test health

- Flag tests that take unusually long, depend on wall-clock time, hit real network/external services, or depend on test execution order -- these cause flakiness and should be called out even if not explicitly asked about.
- Flag skipped/disabled tests found along the way and ask whether they should be fixed or removed.

## Output

Report: what was run, what failed and why (root cause, not just the error message), what was changed, and the final pass/fail state after the fix. If coverage gaps were found, list them separately from the fix.
