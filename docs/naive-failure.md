# Naive idempotency handler under concurrency

Handler: `src/webhooks/webhooks.service.naive.ts` (check-then-insert, no transaction)
Test: `test/idempotency.e2e-spec.ts`, 20 concurrent POSTs, identical event ID

## Result

FAIL — `expect(responses.every((r) => r.status === 200)).toBe(true)`

8 of 20 requests returned 500. Postgres rejected them with:

    23505: duplicate key value violates unique constraint "events_source_provider_event_id_key"

Prisma surfaced this as P2002 at `event.create()`, line 37 — the INSERT immediately
following the `findFirst` that reported no existing row.

## Why

Between the SELECT and the INSERT there is a window in which another request can
commit the same event. Nine requests observed an empty result, nine attempted the
insert, one succeeded. The SELECT proves nothing about the state at INSERT time.

## Consequence

The unique constraint protected the data, so no duplicate events were stored.
The damage is at the API boundary: the provider receives 500s for an event that
was in fact ingested, treats those as failures, and retries — reopening the same
window. Error rate scales with provider concurrency and does not converge.

## Fix

`INSERT ... ON CONFLICT DO NOTHING RETURNING id` in a single statement; the empty
result set is the duplicate signal. See `src/webhooks/webhooks.service.ts`.
