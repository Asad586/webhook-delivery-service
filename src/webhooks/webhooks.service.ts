import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceivePayload } from './dto/receive-payload.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(source: string, payload: ReceivePayload) {
    const existing = await this.prisma.event.findUnique({
      where: {
        source_providerEventId: { source, providerEventId: payload.id },
      },
    });

    if (existing) {
      this.logger.log(`duplicate ${source}/${payload.id}`);
      return { status: 'duplicate' as const, eventId: existing.id };
    }

    const event = await this.prisma.event.create({
      data: {
        source,
        providerEventId: payload.id,
        eventType: payload.type,
        payload: payload.data as object,
      },
    });

    return { status: 'accepted' as const, eventId: event.id };
  }
}
