import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export type SendOutcome =
  | { kind: 'success'; statusCode: number }
  | {
      kind: 'retryable';
      statusCode?: number;
      error: string;
      retryAfterMs?: number;
    }
  | { kind: 'permanent'; statusCode?: number; error: string };

@Injectable()
export class DeliverySender {
  private readonly logger = new Logger(DeliverySender.name);

  async send(args: {
    url: string;
    secret: string;
    deliveryId: string;
    eventId: string;
    attempt: number;
    eventType: string;
    payload: unknown;
    timeoutMs: number;
  }): Promise<SendOutcome> {
    const body = JSON.stringify({ type: args.eventType, data: args.payload });
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', args.secret)
      .update(`${t}.${body}`)
      .digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);

    try {
      const res = await fetch(args.url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': args.deliveryId,
          'X-Webhook-Event-Id': args.eventId,
          'X-Webhook-Attempt': String(args.attempt),
          'X-Webhook-Timestamp': String(t),
          'X-Webhook-Signature': `t=${t},v1=${signature}`,
        },
        body,
      });

      if (res.status >= 200 && res.status < 300) {
        return { kind: 'success', statusCode: res.status };
      }

      if (res.status === 429) {
        const header = res.headers.get('retry-after');
        const seconds = header ? Number(header) : NaN;
        return {
          kind: 'retryable',
          statusCode: res.status,
          error: 'rate limited',
          retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : undefined,
        };
      }

      if (res.status === 408 || res.status >= 500) {
        return {
          kind: 'retryable',
          statusCode: res.status,
          error: `upstream ${res.status}`,
        };
      }

      // Other 4xx: the payload will not improve on retry.
      return {
        kind: 'permanent',
        statusCode: res.status,
        error: `rejected ${res.status}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'retryable', error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
