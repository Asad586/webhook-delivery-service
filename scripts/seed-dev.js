const { Client } = require('pg');
require('dotenv').config({ path: '.env', override: true });

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(
    `target: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`,
  );

  await client.query(
    'TRUNCATE dead_letters, deliveries, events, subscribers RESTART IDENTITY CASCADE',
  );

  await client.query(`
    INSERT INTO subscribers (id, name, url, secret, event_types, active, created_at) VALUES
      (gen_random_uuid(), 'sub-alpha',  'http://localhost:4001/hook', 'whsec_alpha',  ARRAY['payment.succeeded'], true, now()),
      (gen_random_uuid(), 'sub-beta',   'http://localhost:4002/hook', 'whsec_beta',   ARRAY['payment.succeeded','payment.failed'], true, now()),
      (gen_random_uuid(), 'sub-broken', 'http://localhost:4003/hook', 'whsec_broken', ARRAY['payment.failed'], true, now())
  `);

  const { rows } = await client.query(
    'SELECT name, url, event_types FROM subscribers ORDER BY name',
  );
  console.table(rows);
  await client.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
