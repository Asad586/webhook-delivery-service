import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  subscriberId: string;
  attempts: number;
}

@Injectable()
export class DeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically claims up to `limit` due deliveries.
   *
   * SKIP LOCKED lets concurrent workers take disjoint batches instead of
   * queueing behind each other on the same rows.
   *
   * attempts is incremented HERE, at claim time, not on failure — so a worker
   * that is killed mid-flight still burns an attempt and cannot retry forever.
   *
   * This commits immediately. IN_FLIGHT + locked_at is a lease held in
   * committed data, never a row lock held open across an HTTP call.
   */
  async claimBatch(limit: number): Promise<ClaimedDelivery[]> {
    return this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE deliveries d
      SET status = 'IN_FLIGHT',
          attempts = d.attempts + 1,
          locked_at = now(),
          updated_at = now()
      FROM (
        SELECT id
        FROM deliveries
        WHERE status = 'PENDING'
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS claimed
      WHERE d.id = claimed.id
      RETURNING d.id AS "id",
                d.event_id AS "eventId",
                d.subscriber_id AS "subscriberId",
                d.attempts AS "attempts"
    `;
  }

  /** Requeues deliveries whose lease expired — the worker holding them died. */
  async reapExpiredLeases(leaseSeconds: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE deliveries
      SET status = 'PENDING', locked_at = NULL, updated_at = now()
      WHERE status = 'IN_FLIGHT'
        AND locked_at < now() - make_interval(secs => ${leaseSeconds})
      RETURNING id
    `;
    return rows.length;
  }
}
