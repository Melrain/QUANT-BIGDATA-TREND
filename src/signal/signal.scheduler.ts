/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SymbolRegistry } from '@/collector/registry/symbol.registry';
import { SignalsService } from './signal.service';

@Injectable()
export class SignalsScheduler {
  private readonly logger = new Logger(SignalsScheduler.name);
  private running = false;

  constructor(
    private readonly svc: SignalsService,
    private readonly symbols: SymbolRegistry,
  ) {}

  @Cron(process.env.CRON_SIGNALS ?? '45 * * * * *')
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const sym of this.symbols.getAll()) {
        try {
          const res = await this.svc.evaluateOnce(sym);
          this.logger.log(`Signal ${sym}: ${JSON.stringify(res)}`);
        } catch (e: any) {
          this.logger.warn(`Signal ${sym} failed: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
