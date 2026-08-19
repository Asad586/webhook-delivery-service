import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { ReceivePayloadSchema } from './dto/receive-payload.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':source')
  @HttpCode(200)
  async receive(@Param('source') source: string, @Body() body: unknown) {
    const payload = ReceivePayloadSchema.parse(body);
    return this.webhooks.ingest(source, payload);
  }
}
