#!/usr/bin/env bash
# Applies migrations 000 -> 008 -> 009 to a throwaway Postgres in Docker, applies
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

for m in 000 008 009; do
  f=$(ls migrations/${m}_*.sql)
  psqlx < "$f"
  echo "applied   $f"
done
for m in 000 008 009; do
  psqlx < "$(ls migrations/${m}_*.sql)"
done
echo "re-applied 000, 008, 009: repeatable"

psqlx < migrations/selftest.sql 2>&1 | sed 's/^psql:.*NOTICE:  //'
echo "migrations self-test passed"
