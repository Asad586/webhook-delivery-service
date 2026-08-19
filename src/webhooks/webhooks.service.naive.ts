import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivePayload } from './dto/receive-payload.dto';

/**
 * DELIBERATELY INCORRECT — kept as evidence, not used in production.
 *
 * Check-then-insert has a race window between the SELECT and the INSERT.
 * Two concurrent deliveries of the same event both find nothing, both insert,
 * and one loses: either a unique-violation 500, or a duplicate fan-out.
 *
 * See src/webhooks/webhooks.service.ts for the correct version and
 * test/idempotency.e2e-spec.ts for the test that distinguishes them.
 */
@Injectable()
export class WebhooksServiceNaive {
  private readonly logger = new Logger(WebhooksServiceNaive.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(source: string, payload: ReceivePayload) {
    // --- race window opens here ---
    const existing = await this.prisma.event.findFirst({
      where: { source, providerEventId: payload.id },
    });

    if (existing) {
      this.logger.log(`duplicate ${source}/${payload.id}`);
      return {
        status: 'duplicate' as const,
        eventId: existing.id,
        deliveries: 0,
      };
    }
    // --- and closes here ---

    const event = await this.prisma.event.create({
      data: {
        source,
        providerEventId: payload.id,
        eventType: payload.type,
        payload: payload.data as object,
      },
    });

    const subscribers = await this.prisma.subscriber.findMany({
      where: { active: true, eventTypes: { has: payload.type } },
      select: { id: true },
    });

    if (subscribers.length > 0) {
      await this.prisma.delivery.createMany({
        data: subscribers.map((s) => ({
          eventId: event.id,
          subscriberId: s.id,
        })),
      });
    }

    return {
      status: 'accepted' as const,
      eventId: event.id,
      deliveries: subscribers.length,
    };
  }
}
