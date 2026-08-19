import {
  CanActivate,
  ExecutionContext,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const TOLERANCE_SECONDS = 300;

@Injectable()
export class SignatureGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<RawBodyRequest<Request<{ source: string }>>>();

    const raw = req.rawBody;
    if (!raw?.length) throw new UnauthorizedException('missing raw body');

    const source = req.params.source;
    const secret = process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`];
    if (!secret) throw new UnauthorizedException('unknown source');

    const header = req.header('x-webhook-signature');
    if (!header) throw new UnauthorizedException('missing signature');

    const parts = new Map(
      header.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
    );
    const timestamp = parts.get('t');
    const provided = parts.get('v1');
    if (!timestamp || !provided)
      throw new UnauthorizedException('malformed signature');

    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(skew) || skew > TOLERANCE_SECONDS) {
      throw new UnauthorizedException('timestamp outside tolerance');
    }

    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}.`, 'utf8'),
      raw,
    ]);
    const expected = createHmac('sha256', secret)
      .update(signedPayload)
      .digest();

    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(provided, 'hex');
    } catch {
      throw new UnauthorizedException('invalid signature encoding');
    }

    if (providedBuf.length !== expected.length)
      throw new UnauthorizedException('bad signature');
    if (!timingSafeEqual(providedBuf, expected))
      throw new UnauthorizedException('bad signature');

    return true;
  }
}
