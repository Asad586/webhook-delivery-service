import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const SECRET = process.env.WEBHOOK_SECRET_STRIPE!;

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
  });

  afterAll(async () => {
    await app.close();
  });

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
  });

  it('creates one event and one fan-out under 20 concurrent duplicates', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        id: 'evt_race',
        type: 'payment.succeeded',
        data: { amount: 1 },
      }),
    );
    const signature = sign(raw);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app.getHttpServer())
          .post('/webhooks/stripe')
          .set('Content-Type', 'application/json')
          .set('X-Webhook-Signature', signature)
          .send(raw.toString('utf8')),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);

    const accepted = responses.filter((r) => r.body.status === 'accepted');
    expect(accepted).toHaveLength(1);

    expect(
      await prisma.event.count({ where: { providerEventId: 'evt_race' } }),
    ).toBe(1);
    expect(await prisma.delivery.count()).toBe(2);
  });
});
