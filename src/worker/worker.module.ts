import { Module } from '@nestjs/common';
import { DeliveryRepository } from './delivery.repository';
import { DeliverySender } from './delivery.sender';
import { DeliveryProcessor } from './delivery.processor';
import { WorkerService } from './worker.service';

@Module({
  providers: [
    DeliveryRepository,
    DeliverySender,
    DeliveryProcessor,
    WorkerService,
  ],
  exports: [DeliveryRepository, DeliverySender, DeliveryProcessor],
})
export class WorkerModule {}
