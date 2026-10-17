#!/usr/bin/env bash
# Applies every numbered migration to a throwaway Postgres in Docker, applies
# them a second time to prove they are repeatable, then runs migrations/selftest.sql,
# which drives every RPC the way the application does and checks privileges.
#
#   npm run test:migrations
#
# Needs Docker. Never points at the live database.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${PG_TEST_IMAGE:-postgres:15-alpine}"
NAME="wg-migrations-test-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -d --name "$NAME" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gateway \
  "$IMAGE" >/dev/null

for _ in $(seq 1 120); do
  if docker exec "$NAME" pg_isready -U postgres -d gateway -q 2>/dev/null; then break; fi
  sleep 0.5
done
docker exec "$NAME" pg_isready -U postgres -d gateway -q || { echo "postgres did not start"; exit 1; }

psqlx() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -X -q -U postgres -d gateway "$@"; }

# Supabase ships these roles; a plain Postgres does not.
psqlx -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"

# Every numbered migration, in order (000 base, then 008 onward).
MIGRATIONS=$(ls migrations/[0-9][0-9][0-9]_*.sql | sort)
for f in $MIGRATIONS; do
  psqlx < "$f"
  echo "applied   $f"
done
for f in $MIGRATIONS; do
  psqlx < "$f"
done
echo "re-applied all: repeatable"

psqlx < migrations/selftest.sql 2>&1 | sed 's/^psql:.*NOTICE:  //'
echo "migrations self-test passed"
