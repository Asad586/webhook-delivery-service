import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DeliverySender } from './delivery.sender';
import { ClaimedDelivery } from './delivery.repository';
import { nextAttemptDelayMs } from './backoff';

@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger(DeliveryProcessor.name);

  private readonly maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 6);
  private readonly timeoutMs = Number(
    process.env.WORKER_HTTP_TIMEOUT_MS ?? 10000,
  );
  private readonly baseMs = Number(process.env.RETRY_BASE_MS ?? 1000);
  private readonly capMs = Number(process.env.RETRY_CAP_MS ?? 3600000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: DeliverySender,
  ) {}

  async process(claimed: ClaimedDelivery): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: claimed.id },
      include: { event: true, subscriber: true },
    });
    if (!delivery) return;

    const outcome = await this.sender.send({
      url: delivery.subscriber.url,
      secret: delivery.subscriber.secret,
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      attempt: claimed.attempts,
      eventType: delivery.event.eventType,
      payload: delivery.event.payload,
      timeoutMs: this.timeoutMs,
    });

    if (outcome.kind === 'success') {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SUCCEEDED',
          lockedAt: null,
          lastError: null,
          lastStatusCode: outcome.statusCode,
        },
      });
      this.logger.log(`delivered ${delivery.id} attempt=${claimed.attempts}`);
      return;
    }

    const exhausted = claimed.attempts >= this.maxAttempts;

    if (outcome.kind === 'permanent' || exhausted) {
      await this.deadLetter(
        delivery.id,
        delivery.eventId,
        delivery.subscriberId,
        {
          attempts: claimed.attempts,
          lastError: outcome.error,
          lastStatusCode: outcome.statusCode ?? null,
        },
      );
      this.logger.warn(
        `dead-lettered ${delivery.id} attempts=${claimed.attempts} reason=${outcome.kind === 'permanent' ? 'permanent' : 'exhausted'}`,
      );
      return;
    }

    const delayMs =
      outcome.retryAfterMs ??
      nextAttemptDelayMs(claimed.attempts, this.baseMs, this.capMs);

    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PENDING',
        lockedAt: null,
        lastError: outcome.error,
        lastStatusCode: outcome.statusCode ?? null,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });

    this.logger.log(
      `retry ${delivery.id} attempt=${claimed.attempts} in=${Math.round(delayMs / 1000)}s`,
    );
  }

  /**
   * One transaction: the dead-letter record and the status change must land
   * together, or a crash between them leaves a FAILED delivery with no
   * dead-letter row to alert on.
   */
  private async deadLetter(
    deliveryId: string,
    eventId: string,
    subscriberId: string,
    info: {
      attempts: number;
      lastError: string;
      lastStatusCode: number | null;
    },
  ) {
    await this.prisma.$transaction([
      this.prisma.deadLetter.create({
        data: { deliveryId, eventId, subscriberId, ...info },
      }),
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          lockedAt: null,
          lastError: info.lastError,
          lastStatusCode: info.lastStatusCode,
        },
      }),
    ]);
  }
}
