#!/usr/bin/env bash
#
# check-leaks.sh — guard against accidental tenant/operator leaks in the
# tree. We've had a couple of near-misses where a maintainer's internal
# names (org, employee handles, internal URLs) slipped into commit
# messages or doc examples; CI runs this on every PR to make the next
# one impossible to merge without a deliberate exception.
#
# Greps are intentionally narrow — we only block strings that have no
# legitimate reason to appear in a public connector. Add to the list
# when a new operator-private term shows up.
#
# Exits 1 on first hit so CI fails loudly. To intentionally allow a
# match, add an inline `# allow-leak` marker on the same line.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files we never want to scan (build output, deps, lockfiles, the
# script itself which has to mention the patterns).
EXCLUDES=(
  ":!dist"
  ":!node_modules"
  ":!package-lock.json"
  ":!scripts/check-leaks.sh"
)

# Operator/tenant terms that should not appear in the public repo.
# Each pattern is anchored loosely; case-insensitive.
PATTERNS=(
  'openssl[-_ ]?(corp|corporation|foundation|internal)'
  'soil[-_ ]?dev[-/]internal'
  '\bkajal\b'
)

fail=0
for pat in "${PATTERNS[@]}"; do
  # `git grep -n -I -i` — line numbers, skip binaries, case-insensitive.
  # `|| true` so a no-match doesn't trip set -e.
  hits="$(git grep -n -I -i -E "$pat" -- "${EXCLUDES[@]}" || true)"
  if [ -n "$hits" ]; then
    # Filter out lines explicitly marked allow-leak.
    filtered="$(echo "$hits" | grep -v 'allow-leak' || true)"
    if [ -n "$filtered" ]; then
      echo "leak guard: pattern '$pat' matched:"
      echo "$filtered"
      fail=1
    fi
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Refusing to pass — operator-private terms found above."
  echo "If a match is intentional, append '# allow-leak' on the line."
  exit 1
fi

echo "leak guard: clean"
