# Deals CRM API

Laravel 12, PHP 8.4, PostgreSQL 17, Redis 7.4. See the repository [README](../README.md) for Docker setup, API examples and conflict policy.

The `operations` table is a durable inbox for both webhook delivery and manual sync. Acceptance writes only PostgreSQL; HTTP requests never wait for Redis. Redis contains transport jobs only. `inbox:dispatch --loop` runs every two seconds and dispatches received operations, lost queue pushes, due retries and expired processing leases. `OperationProcessor` claims work under a row lock, performs bounded HTTP requests outside the transaction, then fences and atomically commits the operation and deal changes. A transaction advisory lock on `external_id` also protects concurrent creation before a deal row exists. Only strictly greater external versions apply.

Tests run against a **separate PostgreSQL database** named `crm_test` (forced by `phpunit.xml`):

```sh
docker compose exec db createdb -U crm crm_test
docker compose run --rm -e DB_DATABASE=crm_test -e APP_ENV=testing api php artisan test
```

`CrmTest` covers idempotency, stale versions, an interleaved late GET, retry backoff and final errors, local conflict policy, validation, inbox recovery and CRUD. HTTP and queue transport are faked in these tests; SQL uses real PostgreSQL. The root smoke test additionally exercises real HTTP, Redis and worker processes.
