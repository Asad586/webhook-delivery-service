import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivePayload } from './dto/receive-payload.dto';

interface IngestRow {
  eventId: string;
  deliveries: number;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(source: string, payload: ReceivePayload) {
    const eventType = payload.type;

    const rows = await this.prisma.$queryRaw<IngestRow[]>`
      WITH new_event AS (
        INSERT INTO events (id, source, provider_event_id, event_type, payload, received_at)
        VALUES (gen_random_uuid(), ${source}, ${payload.id}, ${eventType},
                ${JSON.stringify(payload.data ?? null)}::jsonb, now())
        ON CONFLICT (source, provider_event_id) DO NOTHING
        RETURNING id
      ),
      fanout AS (
        INSERT INTO deliveries
          (id, event_id, subscriber_id, status, attempts, next_attempt_at, created_at, updated_at)
        SELECT gen_random_uuid(), ne.id, s.id, 'PENDING'::"DeliveryStatus",
               0, now(), now(), now()
        FROM new_event ne
        CROSS JOIN subscribers s
        WHERE s.active = true
          AND ${eventType} = ANY(s.event_types)
        RETURNING id
      )
      SELECT ne.id AS "eventId",
             (SELECT count(*)::int FROM fanout) AS "deliveries"
      FROM new_event ne
    `;

    if (rows.length === 0) {
      this.logger.log(`duplicate ${source}/${payload.id}`);
      return { status: 'duplicate' as const };
    }

    const { eventId, deliveries } = rows[0];

    this.logger.log(
      `accepted ${source}/${payload.id} → ${deliveries} deliveries`,
    );

    return { status: 'accepted' as const, eventId, deliveries };
  }
}
