# Webhook Delivery Service

> **How to use this file:** everything in `[WRITE: ...]` is a prompt for you, not
> content. Replace each one with your own prose and delete the marker. The tables,
> numbers, and query plans are already filled in from your actual runs — don't
> change those. Delete this block when you're done.

A service that ingests webhooks from a provider exactly once and delivers them
onward to registered subscribers with retries, exponential backoff, and a
dead-letter queue.

NestJS · PostgreSQL 16 · Prisma 7 · Docker Compose · Jest · GitHub Actions

---

## The problem

[WRITE: Three or four sentences. Providers deliver at-least-once, so duplicates
are normal, not exceptional. Networks fail mid-response. Subscribers go down for
hours and come back all at once. State what sits in the middle and what it has to
guarantee. Don't sell — describe.]

---

## Guarantees

**Exactly-once ingestion.** A provider that delivers the same event ID fifty times
produces exactly one `events` row and exactly one fan-out. Enforced by a unique
constraint on `(source, provider_event_id)` and a single-statement
`INSERT ... ON CONFLICT DO NOTHING`, not by application-level checking.

**At-least-once delivery.** Every delivery is attempted until it succeeds or
exhausts its attempt budget. Subscribers may receive the same event more than
once and must deduplicate on `X-Webhook-Event-Id`.

**Bounded retry.** Six attempts with full-jitter exponential backoff from 1s to a
1h cap, after which the delivery moves to `dead_letters` and leaves the queue
permanently.

**Authenticated ingestion.** HMAC-SHA256 over the raw request bytes with a
timestamp inside the signed payload, compared in constant time.

---

## What is NOT guaranteed

### Ordering

[WRITE: Say plainly that ordering is not preserved, then explain why in terms of
the design — concurrent workers claim disjoint batches, each delivery carries
independent retry state, so a delivery that fails once will land after one that
never failed. Then the important half: what guaranteeing order would cost.
Per-subscriber serialisation means one slow subscriber blocks every event behind
it. Say why you'd rather have the current behaviour.]

### Exactly-once delivery

[WRITE: This is impossible over HTTP to a third party and you should say so
directly. Describe the specific case: subscriber returns 200, connection dies
before the response is read, you retry, they get it twice. There is no protocol
fix. Then say what you did instead — X-Webhook-Event-Id, so deduplication is
possible on their side — and be explicit that this moves the problem rather than
solving it.]

### Delivery within a bounded time

[WRITE: Backoff is exponential to a 1h cap, so a subscriber down for a day gets
deliveries spread across the retry window and then dead-lettered. State the actual
worst case from your config.]

---

## Architecture

```
POST /webhooks/:source
  │
  ├─ SignatureGuard ──── HMAC over raw bytes, ±300s timestamp window
  │
  ├─ INSERT ... ON CONFLICT DO NOTHING ─── duplicate? return 200, stop
  │
  └─ fan out to matching subscribers      ← same transaction as the insert
                │
                ▼
        deliveries (PENDING)
                │
     ┌──────────┴──────────┐
     │  worker poll loop   │  UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)
     └──────────┬──────────┘
                │ claim commits immediately; IN_FLIGHT + locked_at is a lease
                ▼
          POST to subscriber
                │
     ┌──────────┼──────────┬────────────────┐
     ▼          ▼          ▼                ▼
  SUCCEEDED  PENDING    FAILED         (worker dies)
             + backoff  + dead_letter        │
                                        reaper requeues
                                        after lease expiry
```

---

## Idempotency

Two implementations are in the repository. The incorrect one is kept
deliberately: `src/webhooks/webhooks.service.naive.ts`.

### The version that looks correct

```ts
const existing = await this.prisma.event.findFirst({
  where: { source, providerEventId: payload.id },
});
if (existing) return { status: 'duplicate' };

const event = await this.prisma.event.create({ ... });
```

[WRITE: Explain the race window in your own words — between the SELECT and the
INSERT another request can commit the same event, so the SELECT proves nothing
about the state at INSERT time. Note that this passes every single-threaded test.]

### Measured failure

20 concurrent POSTs with an identical event ID, against the naive handler:

```
expect(responses.every((r) => r.status === 200)).toBe(true)

8 of 20 requests returned 500.
23505: duplicate key value violates unique constraint "events_source_provider_event_id_key"
```

**8 of 20, not 19 of 20.** Twelve requests arrived after the winner had committed
and correctly returned `duplicate`. The window is real but narrow — which is
exactly why this survives code review and single-threaded tests, and only appears
in production under load.

[WRITE: One paragraph on why the 500s matter more than they look. The unique
constraint protected the data — no duplicate events were stored. The damage is at
the API boundary: the provider sees failures for an event that was ingested, and
retries, reopening the window. Say what that does to the error rate.]

Full writeup: [`docs/naive-failure.md`](docs/naive-failure.md)

### The version that ships

```ts
INSERT INTO events (...)
VALUES (...)
ON CONFLICT (source, provider_event_id) DO NOTHING
RETURNING id
```

[WRITE: Why the empty result set is the duplicate signal, why this is one round
trip, and why letting the database arbitrate beats coordinating in application
code.]

### The subtler bug: fan-out must be in the same transaction

[WRITE: This is the most important paragraph in the README. Walk the failure:
insert the event, commit, then create deliveries, then crash. The retry sees a
duplicate, returns 200, and that event is durably stored and permanently
undelivered. Silent loss that only appears under crash conditions. Say what
`$transaction` buys and what it costs — the transaction now scales with subscriber
count, and name the point at which you'd move fan-out to an outbox worker instead.]

---

## Concurrency: `SELECT ... FOR UPDATE SKIP LOCKED`

```sql
UPDATE deliveries d
SET status = 'IN_FLIGHT', attempts = d.attempts + 1, locked_at = now()
FROM (
  SELECT id FROM deliveries
  WHERE status = 'PENDING' AND next_attempt_at <= now()
  ORDER BY next_attempt_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
) AS claimed
WHERE d.id = claimed.id
RETURNING ...
```

Verified by `test/claim.e2e-spec.ts`: five concurrent workers claiming batches of
30 from 100 pending rows produce 100 distinct IDs, no row claimed twice, maximum
`attempts` of 1, completing well inside the timeout.

Three design decisions:

**The claim transaction commits before any HTTP call.** [WRITE: Why holding a row
lock across a request to a third party defeats the purpose — a subscriber taking
30s would hold a Postgres transaction open for 30s. `IN_FLIGHT` + `locked_at` is a
lease held in committed data, not a lock held in a transaction.]

**`attempts` increments at claim time, not on failure.** [WRITE: What a SIGKILL
mid-flight would otherwise do — the attempt wouldn't count, and a crash loop
retries forever without ever dead-lettering.]

**A reaper requeues expired leases.** [WRITE: Leases need something to reclaim
them when a worker dies. State your lease window and why it must exceed the HTTP
timeout with margin — too short and the reaper requeues live work, deliberately
double-delivering.]

---

## Retry policy

| Response                   | Treatment                                   |
| -------------------------- | ------------------------------------------- |
| 2xx                        | Success                                     |
| 429                        | Retry, honouring `Retry-After` when present |
| 408, 5xx                   | Retry with backoff                          |
| Other 4xx                  | Dead-letter — the payload will not improve  |
| Timeout / connection error | Retry with backoff                          |

```ts
const exponential = Math.min(capMs, baseMs * 2 ** (attempts - 1));
return Math.floor(random() * exponential); // full jitter
```

[WRITE: Why full jitter rather than `exponential + small random`. The thundering
herd case: a subscriber recovers from an outage and every queued delivery fires in
the same millisecond, knocking it over again. Then note that Stripe retries all
non-2xx while you distinguish permanent from transient, and say which you think is
right and why.]

---

## Query performance

500,000 deliveries: 490,000 `SUCCEEDED`, 5,000 `FAILED`, 5,000 `PENDING`, of which
3,334 are due. PostgreSQL 16.14 in Docker. Each plan run three times; the warm run
is reported.

Query under test:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM deliveries
WHERE status = 'PENDING' AND next_attempt_at <= now()
ORDER BY next_attempt_at
LIMIT 50
FOR UPDATE SKIP LOCKED;
```

| Index                                        | Execution | Buffers | Index size |
| -------------------------------------------- | --------- | ------- | ---------- |
| None                                         | 35.529 ms | 7,246   | —          |
| `(status, next_attempt_at)`                  | 0.217 ms  | 153     | 5,104 kB   |
| `(next_attempt_at) WHERE status = 'PENDING'` | 0.241 ms  | 152     | **64 kB**  |

### No index

```
Limit  (cost=15984.88..15985.51 rows=50) (actual time=35.269..35.440 rows=50)
  Buffers: shared hit=3546 read=3700 dirtied=50
  ->  Sort  (actual time=35.225..35.232 rows=50)
        Sort Method: quicksort  Memory: 279kB
        ->  Seq Scan on deliveries  (actual time=0.023..34.402 rows=3334)
              Filter: ((status = 'PENDING') AND (next_attempt_at <= now()))
              Rows Removed by Filter: 496666
Execution Time: 35.529 ms
```

Reads the entire table, discards 99.3% of it, then materialises and sorts all
3,334 matches to return 50.

### Partial index

```
Limit  (cost=0.29..165.09 rows=50) (actual time=0.053..0.205 rows=50)
  Buffers: shared hit=150 read=2
  ->  Index Scan using deliveries_pending_idx on deliveries
        Index Cond: (next_attempt_at <= now())
        Filter: (status = 'PENDING')
Execution Time: 0.241 ms
```

### Conclusion

[WRITE: Be honest here, it's the section that earns the most credit. The index is
worth 164×. The choice _between_ the two indexes is worth nothing on read latency —
0.217 vs 0.241 ms is noise, and the partial is marginally slower. The win is size:
64 kB vs 5,104 kB, 80×, because the index holds only the ~1% of rows actually
queued. Rows leave it automatically on transition to SUCCEEDED or FAILED, so it
stays flat as delivery volume grows while the compound index tracks total table
size forever. Say you chose it for write cost and cache residency, not read
latency.]

Two honest caveats:

- The partial index carries a `Filter: (status = 'PENDING')` line that the
  compound index resolves in the `Index Cond`. Status isn't a column in the
  partial index, only in its predicate, so Postgres re-checks it per heap row.
- The planner's estimated cost is _higher_ for the partial index (10,466 vs
  4,943). It is wrong at this scale, but the predicate must be provable — a
  literal `status = 'PENDING'` works, a parameterised status does not. The claim
  query hardcodes the literal for this reason.

Prisma cannot express partial indexes; the index is created by hand in
`prisma/migrations/20260819120000_partial_pending_index/migration.sql`.

---

## Failure modes

| Failure                                  | Behaviour                                      | Recovery                                  |
| ---------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Crash after event insert, before fan-out | Impossible — same transaction                  | n/a                                       |
| Worker killed mid-delivery               | Row stuck `IN_FLIGHT`, attempt already counted | Reaper requeues after lease expiry        |
| Subscriber returns 5xx                   | Classified retryable, backoff                  | Retried up to 6 times, then dead-lettered |
| Subscriber unreachable                   | Connection error, no status code recorded      | Same path as 5xx                          |
| Subscriber returns 4xx                   | Classified permanent                           | Dead-lettered immediately                 |
| Duplicate provider delivery              | `ON CONFLICT DO NOTHING`                       | 200, no reprocessing                      |
| Replayed request with captured signature | Rejected outside ±300s window                  | n/a                                       |
| Clock skew beyond 300s                   | Valid requests rejected                        | [WRITE: what you'd do]                    |

Observed in testing — three distinct failure signatures across one dead-lettered
event: `503` (subscriber rejecting), `500` (subscriber erroring), and `NULL`
(nothing listening, no response at all). All three exhausted 6 attempts and moved
to `dead_letters` correctly.

---

## Running it

```bash
docker compose up -d
npx prisma migrate deploy
npm run seed:dev

# stub subscribers, one terminal each
node scripts/stub-subscriber.js 4001 ok
node scripts/stub-subscriber.js 4002 flaky    # fails 3x then succeeds
node scripts/stub-subscriber.js 4003 fail     # always 500

npm run start:dev
```

Send a signed webhook:

```bash
node -e "require('fs').writeFileSync('payload.json', JSON.stringify({id:'evt_1',type:'payment.succeeded',data:{amount:4200}}))"
node scripts/sign.js          # prints a curl command with a valid signature
```

Load test data and query plans:

```bash
npm run seed:load             # 500k deliveries, ~40s
```

### Tests

```bash
npm run test:e2e
```

Requires the `db_test` service on port 5435. Tests run against real PostgreSQL,
not a mock — every behaviour worth testing here is a database behaviour, and a
mocked client will happily confirm a race condition doesn't exist.

Node prints an `ExperimentalWarning: VM Modules` on every test run. Prisma 7 loads
its query compiler via dynamic import, which Jest's CJS sandbox requires
`--experimental-vm-modules` to permit. Expected, not a fault.

`.env.test` is committed deliberately — it contains no real secrets, only local
container credentials, and CI needs it.

---

## Tradeoffs, and what would change at scale

[WRITE: This section is read first by senior engineers. Cover at minimum:]

**Postgres as a queue.** [WRITE: Why it's the right call here — one fewer moving
part, transactional fan-out is free, `SKIP LOCKED` genuinely solves the contention
problem. Then the honest half: name the specific point at which you'd move to a
real broker, and what signal would tell you you'd reached it.]

**Fan-out inside the ingest transaction.** [WRITE: Fine at hundreds of subscribers.
What breaks first, and what the outbox alternative would look like.]

**Polling rather than `LISTEN`/`NOTIFY`.** [WRITE: 1s poll latency is well inside
requirements. Say you considered NOTIFY and why you didn't build it — naming an
optimisation you declined reads better than building it.]

**No per-subscriber circuit breaking.** [WRITE: One dead subscriber currently
consumes worker capacity on every poll cycle. What you'd add.]

**High-churn table, no vacuum tuning.** Every claim is an `UPDATE`, and the
baseline plan showed `dirtied=50` — `FOR UPDATE` writes lock information back to
50 heap pages per claim. [WRITE: Dead tuples accumulate; mention autovacuum and
`fillfactor` for HOT updates. You don't need to have tuned it — noticing it is
the point.]

**Payload retention.** [WRITE: Full payloads are stored indefinitely. What that
means for PII and what a retention policy would look like.]

---

## What's not here, on purpose

No UI, no auth system, no admin dashboard. [WRITE: One sentence on why adding them
would have made this a worse demonstration of the thing it's actually about.]

Dead-letter replay is the obvious next step: reset the delivery to `PENDING`,
`attempts = 0`, delete the dead-letter row. Roughly three lines, and it turns the
DLQ from a graveyard into an operational tool.
