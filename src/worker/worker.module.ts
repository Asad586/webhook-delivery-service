import { Module } from '@nestjs/common';
import { DeliveryRepository } from './delivery.repository';

@Module({
  providers: [DeliveryRepository],
  exports: [DeliveryRepository],
})
export class WorkerModule {}
