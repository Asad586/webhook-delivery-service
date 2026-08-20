import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivePayload } from './dto/receive-payload.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(source: string, payload: ReceivePayload) {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO events (id, source, provider_event_id, event_type, payload, received_at)
          VALUES (gen_random_uuid(), ${source}, ${payload.id}, ${payload.type},
                  ${JSON.stringify(payload.data ?? null)}::jsonb, now())
          ON CONFLICT (source, provider_event_id) DO NOTHING
          RETURNING id
        `;

        if (rows.length === 0) {
          this.logger.log(`duplicate ${source}/${payload.id}`);
          return { status: 'duplicate' as const };
        }

        const eventId = rows[0].id;

        const subscribers = await tx.subscriber.findMany({
          where: { active: true, eventTypes: { has: payload.type } },
          select: { id: true },
        });

        if (subscribers.length > 0) {
          await tx.delivery.createMany({
            data: subscribers.map((s) => ({ eventId, subscriberId: s.id })),
          });
        }

        this.logger.log(
          `accepted ${source}/${payload.id} → ${subscribers.length} deliveries`,
        );

        return {
          status: 'accepted' as const,
          eventId,
          deliveries: subscribers.length,
        };
      },
      {
        maxWait: 10_000,
        timeout: 20_000,
      },
    );
  }
}
