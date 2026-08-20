# Webhook Delivery Service

[![CI](https://github.com/Asad586/webhook-delivery-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Asad586/webhook-delivery-service/actions/workflows/ci.yml)

A service that ingests webhooks from a provider exactly once and delivers them
onward to registered subscribers with retries, exponential backoff, and a
dead-letter queue.

NestJS · PostgreSQL 16 · Prisma 7 · Docker Compose · Jest · GitHub Actions

---

## The problem

Webhook providers deliver at-least-once. A duplicate is not an error condition,
it is the normal case — the provider cannot know whether its last request reached
you, so it sends it again. Networks fail after the request is processed but
before the response is read. Subscribers go down for hours and then come back all
at once, expecting everything that queued up in the meantime.

This service sits between the two. It has to accept duplicates without
reprocessing them, hold events durably while a subscriber is unavailable, and
retry in a way that does not make a recovering subscriber's problem worse.

---

## Guarantees

**Exactly-once ingestion.** A provider that delivers the same event ID fifty times
produces exactly one `events` row and exactly one fan-out. Enforced by a unique
constraint on `(source, provider_event_id)` and a single-statement
`INSERT ... ON CONFLICT DO NOTHING`, not by application-level checking.

**At-least-once delivery.** Every delivery is attempted until it succeeds or
exhausts its attempt budget. Subscribers may receive the same event more than
once and must deduplicate on `X-Webhook-Event-Id`.

**Bounded retry.** Six attempts with full-jitter exponential backoff, after which
the delivery moves to `dead_letters` and leaves the queue permanently.

**Authenticated ingestion.** HMAC-SHA256 over the raw request bytes with a
timestamp inside the signed payload, compared in constant time.

---

## What is NOT guaranteed

### Ordering

Events are not delivered in the order they were received.

Workers claim disjoint batches concurrently, and each delivery carries its own
retry state. An event whose first attempt fails is rescheduled and lands after
events that were received later and succeeded immediately. Even without failures,
two workers processing two events give no ordering between them.

Guaranteeing order would mean serialising deliveries per subscriber: one in
flight at a time, and no event proceeds until the one before it succeeds. That
turns a single slow or failing subscriber into a head-of-line block for every
event behind it — an outage on one endpoint becomes a growing backlog rather than
a set of independent retries. I would rather have out-of-order delivery that
drains, and let subscribers order by event timestamp if they need to.

### Exactly-once delivery

This is not achievable over HTTP to a third party.

The subscriber returns 200, and the connection drops before the response reaches
this service. From here, a successful delivery and a lost one look identical, so
the delivery is retried and the subscriber receives the event twice. No protocol
change fixes this; the acknowledgement itself can always be the thing that gets
lost.

Every request therefore carries `X-Webhook-Event-Id`, a stable identifier that is
the same across all attempts for the same event. That does not make delivery
exactly-once — it moves the deduplication to the subscriber, who is the only
party that can actually observe whether they have already processed it.

### Delivery within a bounded time

Retries are scheduled with full jitter against an exponential ceiling, so the
delay between attempts is random rather than fixed. With the current
configuration — base 1s, six attempts — the ceilings across the five retries are
1s, 2s, 4s, 8s and 16s, giving a worst case of roughly 31 seconds before an event
dead-letters, and an expected time of about half that.

Worth noting honestly: the 1h cap in the configuration is never reached at these
settings, because six attempts from a 1s base never climb that high. The cap only
becomes meaningful with a larger base or a higher attempt budget. A subscriber
down for an hour currently loses everything sent during that hour to the
dead-letter queue, which is the correct behaviour only if dead letters are
actually monitored and replayed.

---

## Architecture

```
POST /webhooks/:source
  │
  ├─ SignatureGuard ──── HMAC over raw bytes, ±300s timestamp window
  │
  └─ one statement: INSERT ... ON CONFLICT DO NOTHING
                    + fan-out to matching subscribers via CTE
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

The `SELECT` describes the state of the database at the moment it ran, not at the
moment the `INSERT` runs. Between those two statements another request can insert
the same event and commit. Both requests then believe they are the first, and
both attempt the insert.

Nothing about this is visible in a single-threaded test. Send the same event
twice in sequence and it behaves correctly every time, because the first insert
has already committed before the second request starts.

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

The data was never at risk. The unique constraint did its job and no duplicate
event was stored. The damage is entirely at the API boundary: the provider is
told that eight requests failed for an event that was in fact ingested
successfully. It will retry those, and those retries can race in the same way.
The error rate is then a function of how much concurrency the provider applies,
and it does not settle — a busier provider produces more errors, which produce
more retries, which produce more concurrency.

Full writeup: [`docs/naive-failure.md`](docs/naive-failure.md)

### The version that ships

```sql
WITH new_event AS (
  INSERT INTO events (...)
  VALUES (...)
  ON CONFLICT (source, provider_event_id) DO NOTHING
  RETURNING id
),
fanout AS (
  INSERT INTO deliveries (...)
  SELECT ... FROM new_event ne
  CROSS JOIN subscribers s
  WHERE s.active = true AND $type = ANY(s.event_types)
  RETURNING id
)
SELECT ne.id, (SELECT count(*) FROM fanout) FROM new_event ne
```

There is no separate check. The insert either produces a row or it does not, and
an empty result set is itself the duplicate signal — one statement, one round
trip, no window between reading and writing.

This also avoids using an exception as control flow. Catching `P2002` would work,
but it treats an expected, routine outcome as an error, and it means the
duplicate path is only correct as long as no other unique constraint on the table
can throw the same code.

The wider point is that the database is the only component that can arbitrate
here. Two application processes cannot agree on who inserted first without asking
the database anyway, so the check belongs in the same statement as the write.

### The subtler bug: fan-out must be atomic with the insert

If the event insert and the delivery inserts commit separately, a crash between
them leaves the event stored with nothing to deliver. The provider retries, the
handler sees the event already exists and returns 200, so the provider stops.
Nothing errors and nothing alerts — the worker only reads `deliveries`, and there
is no row there to read.

Both writes are therefore in a single statement, using data-modifying CTEs. A
single statement is atomic in PostgreSQL, and data-modifying CTEs are guaranteed
to execute exactly once and to completion, so the guarantee is the same as a
transaction would give.

The first version did use an interactive `$transaction`, and CI is what showed
the problem with it. An interactive transaction holds a pooled connection across
several round trips, so ingest concurrency is capped by the pool size. Running 20
concurrent duplicates on a 2-core GitHub Actions runner, transactions expired
waiting for connections before their first query ran — a limit that a 12-core
development machine hid completely. The single-statement version holds one
connection for one round trip and the failure disappeared, along with most of the
latency.

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

**The claim transaction commits before any HTTP call.** A row lock is only held
for as long as its transaction, so holding one across a request to a third party
means a subscriber that takes 30 seconds to respond holds a Postgres transaction
open for 30 seconds. At that point `SKIP LOCKED` stops helping — it avoids
blocking on locked rows, but the locks themselves are now long-lived, and the
open transaction holds back vacuum for the whole table. Instead the claim commits
immediately, and `IN_FLIGHT` plus `locked_at` acts as a lease recorded in
committed data. The database is not waiting on anything while the delivery is in
flight.

**`attempts` increments at claim time, not on failure.** If the counter only
advanced on a recorded failure, a worker killed mid-delivery would never record
one. The row would return to the queue with the same attempt count, be claimed
again, and be killed again — a crash loop that retries forever and never reaches
the dead-letter threshold. Counting the attempt when it is claimed means the
budget is spent whether or not the worker survives to report the outcome.

**A reaper requeues expired leases.** A lease is only useful if something reclaims
it when the holder dies. Rows left `IN_FLIGHT` beyond `WORKER_LEASE_SECONDS`
(300s) are reset to `PENDING` on a timer. That window has to be comfortably longer
than the HTTP timeout (10s) — if the reaper can fire while a request is still
legitimately in flight, it requeues live work and a second worker sends the same
delivery, which is a duplicate this service caused rather than one it inherited.
The cost of the margin is that genuinely abandoned work waits up to five minutes
before recovery, so the number is a trade between duplicate deliveries and
recovery latency rather than a value with a correct answer.

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

The delay is a random value between zero and the exponential ceiling, not the
ceiling plus a small random offset. The difference matters when a subscriber
comes back after an outage: every delivery that queued up during the outage has
been backing off on the same schedule, so with a fixed delay they all become due
within a few milliseconds of each other and arrive as a single burst. The service
would then knock over the endpoint it just watched recover. Full jitter spreads
those deliveries evenly across the whole window instead, and the spread widens
with each attempt.

On classification, Stripe retries every non-2xx response. This service treats
most 4xx as permanent and dead-letters immediately. The argument for retrying
everything is that a 4xx can be transient — a subscriber misconfigured for a few
minutes returns 404 and then recovers. The argument for distinguishing is that
retrying a 400 six times over half a minute cannot succeed, because the payload
being rejected is identical on every attempt, and all it does is spend worker
capacity and delay the dead-letter signal that tells an operator something is
wrong. I chose to distinguish, and the cost of being wrong is bounded: a
mistakenly dead-lettered delivery is still stored and replayable, whereas a
subscriber drowning in pointless retries is not something the service can undo
for them.

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

Having an index is worth 164× — 35.5ms down to 0.2ms, and 7,246 buffers down to
around 150. That is the real result, and it is entirely about not reading 500,000
rows to find 50.

Choosing between the two indexes is worth nothing on read latency. 0.217ms against
0.241ms is measurement noise, and if anything the partial index is marginally
slower. Any claim of a speedup here would be invented.

The reason I kept the partial index is size: 64 kB against 5,104 kB, roughly 80×.
The partial index contains only the rows that are actually queued — about 1% of
the table — and rows leave it automatically when they transition to `SUCCEEDED` or
`FAILED`. It therefore stays roughly the size of the outstanding queue no matter
how many deliveries the service has completed, whereas the compound index has one
entry per row ever inserted and grows without bound. The benefit is in write cost
on a high-churn table and in staying resident in cache, not in the latency of the
query I measured.

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
| Crash after event insert, before fan-out | Impossible — one atomic statement              | n/a                                       |
| Worker killed mid-delivery               | Row stuck `IN_FLIGHT`, attempt already counted | Reaper requeues after lease expiry        |
| Subscriber returns 5xx                   | Classified retryable, backoff                  | Retried up to 6 times, then dead-lettered |
| Subscriber unreachable                   | Connection error, no status code recorded      | Same path as 5xx                          |
| Subscriber returns 4xx                   | Classified permanent                           | Dead-lettered immediately                 |
| Duplicate provider delivery              | `ON CONFLICT DO NOTHING`                       | 200, no reprocessing                      |
| Replayed request with captured signature | Rejected outside ±300s window                  | n/a                                       |
| Clock skew beyond 300s                   | Valid requests rejected                        | Widen window, or use NTP on both ends     |

The clock skew row is a genuine weakness. The ±300s tolerance protects against
replay, but it means a server whose clock has drifted rejects legitimate traffic
and the failure looks like a signature mismatch rather than a time problem. The
error message distinguishes the two cases for exactly this reason.

Observed in testing — three distinct failure signatures across one dead-lettered
event: `503` (subscriber rejecting), `500` (subscriber erroring), and `NULL`
(nothing listening, no response at all). All three exhausted 6 attempts and moved
to `dead_letters` correctly.

---

## Running it

```bash
cp .env.example .env          # Windows: copy .env.example .env
docker compose up -d
npm ci
npx prisma generate
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

Stop the dev server before seeding load data — a running worker will claim rows
mid-seed and skew the status distribution the query plans depend on.

### Tests

```bash
npm run test:e2e
```

Requires the `db_test` service on port 5435. Tests run against real PostgreSQL,
not a mock — every behaviour worth testing here is a database behaviour, and a
mocked client will happily confirm a race condition doesn't exist.

CI runs the same suite on a 2-core runner, which is deliberately smaller than a
development machine. That difference has already earned its keep: it surfaced the
connection-pool bound on interactive transactions described above, which local
runs never hit.

Node prints an `ExperimentalWarning: VM Modules` on every test run. Prisma 7 loads
its query compiler via dynamic import, which Jest's CJS sandbox requires
`--experimental-vm-modules` to permit. Expected, not a fault.

`.env.test` is committed deliberately — it contains no real secrets, only local
container credentials, and CI needs it. `.env` is not; copy `.env.example`.

---

## Tradeoffs, and what would change at scale

**Postgres as a queue.** For this workload it is the right call. There is one
datastore instead of two, so there is no window in which an event is committed to
the database but not yet published to a broker — the fan-out is atomic for free,
which is the guarantee the whole design rests on. `SKIP LOCKED` handles worker
contention properly, as the concurrency test shows.

Where it stops being right is throughput on the claim query. Every worker polls
the same index and every claim is an `UPDATE`, so contention and write
amplification both scale with worker count. The signal to move would be claim
latency rising under load while the queue depth is not falling — that is the point
where workers are competing rather than working, and adding more makes it worse. A
broker with real consumer groups would be the answer then, at the cost of having
to reintroduce the outbox pattern to keep fan-out atomic.

**Fan-out inside the ingest statement.** The fan-out CTE inserts one row per
matching subscriber, so the statement's cost scales with subscriber count on the
hottest write path in the service. What breaks first is receive latency, and it
degrades gradually rather than failing outright. The alternative is to insert only
the event and have a separate worker create the delivery rows by scanning for
events without them — the event row becomes the outbox record. That keeps the
atomicity guarantee while making the request path constant-time, and it is the
change I would make first if subscriber counts grew.

**Polling rather than `LISTEN`/`NOTIFY`.** Polling every second means up to a
second of added latency on a delivery that could have started immediately.
`LISTEN`/`NOTIFY` would remove most of that, at the cost of a second code path
that still needs the poll loop as a fallback, since notifications are not
delivered to a worker that is not connected at the time. A second of latency on
webhook delivery is not a problem worth that complexity, so I left it out.

**No per-subscriber circuit breaking.** A subscriber that is down still gets
claimed and attempted on schedule, and each attempt occupies a worker slot for the
full HTTP timeout. One dead endpoint with a large backlog can therefore consume
most of the worker pool while delivering nothing. The fix is to track consecutive
failures per subscriber and skip claiming for that subscriber entirely once a
threshold is crossed, retrying a single probe delivery periodically instead.

**High-churn table, no vacuum tuning.** Every claim is an `UPDATE`, and the
baseline plan showed `dirtied=50` — `FOR UPDATE` writes lock information back to
50 heap pages per claim. Each status transition also produces a dead tuple, so a
row that is claimed, retried and finally dead-lettered leaves several behind.
Autovacuum handles this by default, but on a table with this update rate it is
worth tuning the per-table thresholds so cleanup keeps pace, and lowering
`fillfactor` so updates can stay on the same page as HOT updates rather than
forcing index writes. I have not tuned either; the plan output is the evidence
that it would eventually matter.

**Payload retention.** Full webhook payloads are stored in `events` indefinitely,
and those payloads are whatever the provider sent — for a payments provider that
plausibly includes names, email addresses and partial card details. There is
currently no deletion path at all. A real deployment needs a retention window
after which delivered events have their payload column nulled while keeping the
event ID for idempotency, so duplicates are still rejected after the data itself
is gone.

---

## What's not here, on purpose

No UI, no auth system, no admin dashboard. Each of those would have added surface
area that is well understood and quick to review, and none of them would have made
the delivery guarantees any stronger — the interesting part of this service is
what happens when things fail, and none of that is visible in a dashboard.

Dead-letter replay is the obvious next step: reset the delivery to `PENDING`,
`attempts = 0`, delete the dead-letter row. Roughly three lines, and it turns the
DLQ from a graveyard into an operational tool.
