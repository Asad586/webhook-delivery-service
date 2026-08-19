const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('dotenv/config');

const source = process.argv[2] || 'stripe';
const file = process.argv[3] || 'payload.json';

const raw = readFileSync(file);
const secret = process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`];
if (!secret) throw new Error(`no secret for ${source}`);

const t = Math.floor(Date.now() / 1000);
const sig = createHmac('sha256', secret)
  .update(Buffer.concat([Buffer.from(`${t}.`), raw]))
  .digest('hex');

console.log(
  `curl -X POST localhost:3000/webhooks/${source} ` +
    `-H "Content-Type: application/json" ` +
    `-H "X-Webhook-Signature: t=${t},v1=${sig}" ` +
    `-d @${file}`,
);
