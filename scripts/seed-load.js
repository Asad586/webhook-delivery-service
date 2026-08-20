/**
 * Seeds a realistic delivery queue for query-plan measurement.
 *
 * The distribution is the point: ~98% SUCCEEDED, ~1% FAILED, ~1% PENDING.
 * The queue is a small hot set inside a large cold table, which is the entire
 * argument for a partial index over a compound one.
 *
 * next_attempt_at is spread +/-300s around now, so roughly half the pending
 * rows are due and half are not — otherwise the planner treats the timestamp
 * filter as a no-op.
 *
 * Usage:  node scripts/seed-load.js [rowCount]
 *
 * Stop the dev server first. A running worker will claim rows mid-seed and
 * skew the distribution.
 */

const { Client } = require('pg');
require('dotenv').config({ path: '.env', override: true });

const TOTAL = Number(process.argv[2] || 500000);
const BATCH = 5000;

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(
    `target: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`,
  );

  console.log('clearing existing data...');
  await client.query(
    'TRUNCATE dead_letters, deliveries, events, subscribers RESTART IDENTITY CASCADE',
  );

  console.log(`seeding ${TOTAL} deliveries...`);

  await client.query(`
    INSERT INTO subscribers (id, name, url, secret, event_types, active, created_at)
    VALUES (gen_random_uuid(), 'load-sub', 'http://localhost:4001/hook', 's',
            ARRAY['load.test'], true, now())
  `);

  const {
    rows: [sub],
  } = await client.query(
    `SELECT id FROM subscribers WHERE name = 'load-sub' LIMIT 1`,
  );

  const started = Date.now();

  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    await client.query(
      `
      WITH series AS (
        SELECT i FROM generate_series(0, $2 - 1) AS i
      ),
      new_events AS (
        INSERT INTO events (id, source, provider_event_id, event_type, payload, received_at)
        SELECT gen_random_uuid(), 'loadtest', 'load_' || (s.i + $1), 'load.test',
               '{"n":1}'::jsonb, now() - make_interval(secs => s.i)
        FROM series s
        RETURNING id, provider_event_id
      )
      INSERT INTO deliveries
        (id, event_id, subscriber_id, status, attempts, next_attempt_at, created_at, updated_at)
      SELECT gen_random_uuid(), ne.id, $3::uuid,
             CASE
               WHEN n % 100 = 0 THEN 'PENDING'::"DeliveryStatus"
               WHEN n % 100 = 1 THEN 'FAILED'::"DeliveryStatus"
               ELSE 'SUCCEEDED'::"DeliveryStatus"
             END,
             0,
             now() + make_interval(secs => (n % 600) - 300),
             now(), now()
      FROM (
        SELECT id, split_part(provider_event_id, '_', 2)::bigint AS n
        FROM new_events
      ) ne
      `,
      [offset, BATCH, sub.id],
    );

    if ((offset / BATCH) % 10 === 0) {
      process.stdout.write(`  ${offset + BATCH}/${TOTAL}\r`);
    }
  }

  console.log(`\nseeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Without fresh statistics the planner is guessing and the "before"
  // numbers are noise.
  console.log('analyzing...');
  await client.query('ANALYZE deliveries');
  await client.query('ANALYZE events');

  const { rows } = await client.query(`
    SELECT status, count(*)::int AS n
    FROM deliveries
    GROUP BY status
    ORDER BY status
  `);
  console.table(rows);

  const {
    rows: [due],
  } = await client.query(`
    SELECT count(*)::int AS n
    FROM deliveries
    WHERE status = 'PENDING' AND next_attempt_at <= now()
  `);
  console.log(`due now: ${due.n}`);

  const {
    rows: [size],
  } = await client.query(`
    SELECT pg_size_pretty(pg_total_relation_size('deliveries')) AS total,
           pg_size_pretty(pg_relation_size('deliveries')) AS heap,
           pg_size_pretty(pg_indexes_size('deliveries')) AS indexes
  `);
  console.log(
    `deliveries: total ${size.total} (heap ${size.heap}, indexes ${size.indexes})`,
  );

  await client.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
