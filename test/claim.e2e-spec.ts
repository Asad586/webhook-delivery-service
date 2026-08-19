import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeliveryRepository } from '../src/worker/delivery.repository';

describe('claimBatch concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let repo: DeliveryRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
    repo = app.get(DeliveryRepository);
  });

  afterAll(async () => await app.close());

  it('gives five concurrent workers disjoint batches, without blocking', async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE dead_letters, deliveries, events, subscribers RESTART IDENTITY CASCADE',
    );

    const sub = await prisma.subscriber.create({
      data: {
        name: 'a',
        url: 'http://localhost:4001/hook',
        secret: 's',
        eventTypes: ['t'],
      },
    });

    for (let i = 0; i < 100; i++) {
      const event = await prisma.event.create({
        data: {
          source: 'stripe',
          providerEventId: `e_${i}`,
          eventType: 't',
          payload: {},
        },
      });
      await prisma.delivery.create({
        data: { eventId: event.id, subscriberId: sub.id },
      });
    }

    const started = Date.now();
    const batches = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimBatch(30)),
    );
    const elapsed = Date.now() - started;

    const ids = batches.flat().map((d) => d.id);

    expect(new Set(ids).size).toBe(ids.length); // no row claimed twice
    expect(ids.length).toBe(100); // 5 × 30 capped by supply
    expect(elapsed).toBeLessThan(3000); // skipped, not queued

    const inFlight = await prisma.delivery.count({
      where: { status: 'IN_FLIGHT' },
    });
    expect(inFlight).toBe(100);

    const [row] = await prisma.$queryRaw<{ max: number }[]>`
      SELECT MAX(attempts)::int AS max FROM deliveries`;
    expect(row.max).toBe(1);
  });
});
