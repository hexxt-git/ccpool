# ccshare dev helpers — a throwaway Postgres for the PG-gated suites and manual
# server testing. Uses Docker so it stays isolated from any local Postgres; the
# container listens on 5433 (not the default 5432) precisely so it can coexist
# with a brew/system Postgres you already run.
#
#   make db-up        start the dev Postgres (idempotent; waits until ready)
#   make db-down      stop and remove it (all data gone — it's throwaway)
#   make db-reset     down + up (a clean database)
#   make db-psql      open a psql shell into it
#   make db-url       print the connection URL (eval "$(make db-url)")
#   make test-pg      run the Postgres-gated suites against it (db-up first)

DB_CONTAINER := ccshare-dev-pg
DB_IMAGE     := postgres:16
DB_PORT      := 5433
DB_USER      := ccshare
DB_PASS      := ccshare
DB_NAME      := ccshare
DB_URL       := postgres://$(DB_USER):$(DB_PASS)@localhost:$(DB_PORT)/$(DB_NAME)

.PHONY: db-up db-down db-reset db-psql db-url db-logs test-pg db-clear

db-up:
	@# Idempotent: `docker start` succeeds whether the container is stopped OR
	@# already running, and fails only when it doesn't exist yet — then create it.
	@if docker start $(DB_CONTAINER) >/dev/null 2>&1; then \
		echo "$(DB_CONTAINER) is up."; \
	else \
		echo "creating $(DB_CONTAINER) on port $(DB_PORT)…"; \
		docker run -d --name $(DB_CONTAINER) \
			-e POSTGRES_USER=$(DB_USER) \
			-e POSTGRES_PASSWORD=$(DB_PASS) \
			-e POSTGRES_DB=$(DB_NAME) \
			-p $(DB_PORT):5432 $(DB_IMAGE) >/dev/null; \
	fi
	@printf "waiting for postgres"; \
	for i in $$(seq 1 30); do \
		if docker exec $(DB_CONTAINER) pg_isready -U $(DB_USER) -d $(DB_NAME) >/dev/null 2>&1; then \
			echo " ready."; echo "  $(DB_URL)"; exit 0; \
		fi; \
		printf "."; sleep 1; \
	done; \
	echo " timed out — check 'make db-logs'."; exit 1

db-down:
	@docker rm -f $(DB_CONTAINER) >/dev/null 2>&1 && echo "removed $(DB_CONTAINER)." || echo "$(DB_CONTAINER) not present."

db-reset: db-down db-up

db-clear:
	@if docker ps --format '{{.Names}}' | grep -q "^$(DB_CONTAINER)$$" >/dev/null 2>&1; then \
		echo "clearing postgres database $(DB_NAME)…"; \
		docker exec -i $(DB_CONTAINER) psql -U $(DB_USER) -d postgres -c "REVOKE CONNECT ON DATABASE $(DB_NAME) FROM public;" >/dev/null 2>&1 || true; \
		docker exec -i $(DB_CONTAINER) psql -U $(DB_USER) -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$(DB_NAME)' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true; \
		docker exec -i $(DB_CONTAINER) psql -U $(DB_USER) -d postgres -c "DROP DATABASE IF EXISTS $(DB_NAME);" >/dev/null && \
		docker exec -i $(DB_CONTAINER) psql -U $(DB_USER) -d postgres -c "CREATE DATABASE $(DB_NAME);" >/dev/null && \
		echo "postgres database $(DB_NAME) cleared."; \
	fi

db-psql:
	@docker exec -it $(DB_CONTAINER) psql -U $(DB_USER) -d $(DB_NAME)

db-logs:
	@docker logs --tail 50 -f $(DB_CONTAINER)

db-url:
	@echo "export CCSHARE_TEST_PG_URL=$(DB_URL)"

# Bring the DB up, then run the suites that are gated on CCSHARE_TEST_PG_URL
# (storage-postgres contract + the server integration tests).
test-pg: db-up
	@CCSHARE_TEST_PG_URL=$(DB_URL) pnpm vitest run packages/storage-postgres apps/server
