#!/usr/bin/env bash
# Regression check for .gitleaks.toml: the repo config must detect a
# synthetic GitHub token. Guards against a config that silently drops the
# built-in ruleset (a custom config without [extend] useDefault = true).
#
# The fixture is generated at runtime so no token-shaped string is committed.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Synthetic, non-functional token: "ghp_" + 36 alphanumerics.
printf 'token = "%s%s"\n' "ghp_" "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4" > "$work/fixture.txt"

set +e
gitleaks detect --no-git --no-banner --redact \
  --config "$repo_root/.gitleaks.toml" \
  --source "$work/fixture.txt" \
  --report-format json --report-path "$work/report.json" >/dev/null 2>&1
code=$?
set -e

if [ "$code" -ne 1 ]; then
  echo "gitleaks config check failed: expected exit code 1 (leak found), got $code" >&2
  exit 1
fi

count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$work/report.json")"
if [ "$count" -ne 1 ]; then
  echo "gitleaks config check failed: expected exactly 1 finding, got $count" >&2
  exit 1
fi

echo "gitleaks config check passed: synthetic token detected (1 finding)."
