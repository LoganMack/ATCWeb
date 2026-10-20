#!/usr/bin/env bash
# Dumps one database with the baseline's two-part method, for the CI workflows:
#   schema part:   supabase db dump --schema public,private
#   platform part: supabase/tools/dump-platform-objects.sql
#
#   bash supabase/tools/snapshot.sh local  <schema-out> <platform-out>
#   bash supabase/tools/snapshot.sh remote <schema-out> <platform-out>   # reads $DB_URL
#
# The remote URL comes from the environment, never from an argument to this script, so it does not
# appear in workflow files or command echoes. Nothing is printed except the CLI's progress lines.
set -euo pipefail

target="${1:?usage: snapshot.sh local|remote <schema-out> <platform-out>}"
schema_out="${2:?schema output path required}"
platform_out="${3:?platform output path required}"
tools_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$target" in
  local)
    # The well-known local development URL of `supabase start`; not a secret.
    url="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    npx supabase db dump --local --schema public,private -f "$schema_out"
    ;;
  remote)
    url="${DB_URL:?DB_URL must be set for a remote snapshot}"
    npx supabase db dump --db-url "$url" --schema public,private -f "$schema_out"
    ;;
  *)
    echo "snapshot.sh: target must be local or remote" >&2
    exit 2
    ;;
esac

psql "$url" -X -At -v ON_ERROR_STOP=1 -f "$tools_dir/dump-platform-objects.sql" > "$platform_out"
