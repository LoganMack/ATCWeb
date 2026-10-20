#!/usr/bin/env bash
# Compares two two-part snapshots (made by snapshot.sh) with the schema normaliser.
#
#   bash supabase/tools/compare.sh <label> <a-schema> <a-platform> <b-schema> <b-platform>
#
# Exits 1 on any difference. The diff can contain production function bodies and this repo's
# Actions logs are public, so it is secret-scanned first and withheld when the scan finds anything.
set -uo pipefail

label="${1:?usage: compare.sh <label> <a-schema> <a-platform> <b-schema> <b-platform>}"
tools_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
diff_file="$(mktemp)"
status=0

node "$tools_dir/normalise-schema.mjs" --diff "$2" "$4" > "$diff_file" || status=1
node "$tools_dir/normalise-schema.mjs" --diff "$3" "$5" >> "$diff_file" || status=1

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ "$status" -eq 0 ]; then
  echo "$label: no schema differences."
  echo "### $label: no schema differences" >> "$summary"
  exit 0
fi

if node "$tools_dir/secret-scan.mjs" "$diff_file" > /dev/null 2>&1; then
  echo "$label: schema differences found:"
  cat "$diff_file"
  {
    echo "### $label: schema differences"
    echo '```diff'
    cat "$diff_file"
    echo '```'
  } >> "$summary"
else
  echo "$label: schema differences found; the diff is withheld because it contains secret-shaped text."
  echo "### $label: schema differences (diff withheld: secret-shaped text)" >> "$summary"
fi
exit 1
