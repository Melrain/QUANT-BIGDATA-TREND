import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AggregatorService } from './aggregator.service';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';

@Injectable()
export class AggregatorScheduler {
  private readonly logger = new Logger(AggregatorScheduler.name);
  private running = false;

  constructor(
    private readonly svc: AggregatorService,
    private readonly symbols: SymbolRegistry,
  ) {}

  // 默认每分钟第 40 秒执行，可用 CRON_FEATURES 覆盖
  @Cron(process.env.CRON_FEATURES ?? '40 * * * * *')
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const syms = this.symbols.getAll();
      for (const sym of syms) {
        try {
          const { written, skipped } = await this.svc.aggregateRecent(sym, {
            lastK: Number(process.env.FEATURE_LAST_K ?? 4), // 最近 4 个 5m 档
            allowCarryMs: Number(
              process.env.FEATURE_CARRY_MS ?? 10 * 60 * 1000,
            ), // 允许 10 分钟内前向填充
          });
          this.logger.log(
            `Features ${sym}: written=${written}, skipped=${skipped}`,
          );
        } catch (e: any) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          this.logger.warn(`Features ${sym} failed: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
