import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { ReceivePayloadSchema } from './dto/receive-payload.dto';
import { SignatureGuard } from './signature.guard';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':source')
  @UseGuards(SignatureGuard)
  @HttpCode(200)
  async receive(@Param('source') source: string, @Body() body: unknown) {
    const payload = ReceivePayloadSchema.parse(body);
    return this.webhooks.ingest(source, payload);
  }
}
