import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Agent } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import type { App } from 'supertest/types';

const SECRET = process.env.WEBHOOK_SECRET_STRIPE!;
const CONCURRENCY = 20;

function sign(raw: Buffer) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${t}.`), raw]))
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('idempotency under concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    await app.close();
  }, 30000);

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE dead_letters, deliveries, events, subscribers RESTART IDENTITY CASCADE',
    );
    await prisma.subscriber.createMany({
      data: [
        {
          name: 'a',
          url: 'http://localhost:4001/hook',
          secret: 's1',
          eventTypes: ['payment.succeeded'],
        },
        {
          name: 'b',
          url: 'http://localhost:4002/hook',
          secret: 's2',
          eventTypes: ['payment.succeeded'],
        },
      ],
    });
  }, 30000);

  it('creates one event and one fan-out under concurrent duplicates', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: 'evt_race',
        type: 'payment.succeeded',
        data: { amount: 1 },
      }),
    );
    const signature = sign(raw);

    // A single keep-alive agent for the burst. The property under test is
    // concurrent ingestion, not concurrent TCP setup — on a 2-core CI runner,
    // opening 20 fresh sockets at once was enough to produce ECONNRESET.
    const agent = new Agent({ keepAlive: true, maxSockets: CONCURRENCY });
    const server = app.getHttpServer() as App;

    try {
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          request(server)
            .post('/webhooks/stripe')
            .agent(agent)
            .set('Content-Type', 'application/json')
            .set('X-Webhook-Signature', signature)
            .send(raw.toString('utf8')),
        ),
      );

      // No request leaks a 500. A unique-violation escaping to the caller
      // would make the provider retry an event that was already ingested.
      expect(responses.every((r) => r.status === 200)).toBe(true);

      // Exactly one request performed the insert; the rest saw the duplicate.
      const accepted = responses.filter(
        (r) => (r.body as { status?: string }).status === 'accepted',
      );
      expect(accepted).toHaveLength(1);

      expect(
        await prisma.event.count({ where: { providerEventId: 'evt_race' } }),
      ).toBe(1);

      // Two subscribers, one fan-out — not CONCURRENCY × 2.
      expect(await prisma.delivery.count()).toBe(2);
    } finally {
      agent.destroy();
    }
  }, 30000);
});
