-- Replaces the compound (status, next_attempt_at) index with a partial index
-- covering only PENDING rows.
--
-- Read latency is unchanged (0.217ms vs 0.241ms on 500k rows — within noise).
-- The win is size: 64 kB vs ~19 MB, because the index holds only the ~1% of
-- rows that are actually queued. Rows leave the index automatically when they
-- transition to SUCCEEDED or FAILED, so it stays flat as delivery volume grows
-- rather than tracking total table size.
--
-- Tradeoff: the planner must prove the query predicate implies the index
-- predicate. `status = 'PENDING'` as a literal works; a parameterised status
-- does not. The claim query in delivery.repository.ts hardcodes the literal
-- for this reason.

DROP INDEX IF EXISTS "deliveries_status_next_attempt_at_idx";

CREATE INDEX "deliveries_pending_idx"
  ON "deliveries" ("next_attempt_at")
  WHERE "status" = 'PENDING';