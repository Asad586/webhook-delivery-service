import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import pLimit from 'p-limit';
import { DeliveryRepository } from './delivery.repository';
import { DeliveryProcessor } from './delivery.processor';

@Injectable()
export class WorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);

  private readonly enabled = process.env.WORKER_ENABLED === 'true';
  private readonly pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000);
  private readonly batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 20);
  private readonly concurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);
  private readonly leaseSeconds = Number(
    process.env.WORKER_LEASE_SECONDS ?? 300,
  );

  private running = false;
  private loopPromise?: Promise<void>;
  private reaperTimer?: NodeJS.Timeout;

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly processor: DeliveryProcessor,
  ) {}

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('worker disabled');
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
    this.reaperTimer = setInterval(() => {
      void this.repo
        .reapExpiredLeases(this.leaseSeconds)
        .then((n) => n > 0 && this.logger.warn(`reaped ${n} expired leases`))
        .catch((e) => this.logger.error(`reaper failed: ${e}`));
    }, this.leaseSeconds * 1000);
    this.logger.log(
      `worker started poll=${this.pollMs}ms batch=${this.batchSize}`,
    );
  }

  /** Stop claiming, let in-flight attempts finish, then exit. */
  async onApplicationShutdown() {
    this.running = false;
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    await this.loopPromise;
    this.logger.log('worker stopped');
  }

  private async loop(): Promise<void> {
    const limit = pLimit(this.concurrency);

    while (this.running) {
      try {
        const batch = await this.repo.claimBatch(this.batchSize);

        if (batch.length === 0) {
          await this.sleep(this.pollMs);
          continue;
        }

        await Promise.all(
          batch.map((d) => limit(() => this.processor.process(d))),
        );
      } catch (err) {
        this.logger.error(`loop error: ${err}`);
        await this.sleep(this.pollMs);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
