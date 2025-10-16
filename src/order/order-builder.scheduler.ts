/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderBuilderService } from './order-builder.service';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';

@Injectable()
export class OrderBuilderScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrderBuilderScheduler.name);
  private running = false;

  // 默认在每分钟第 50 秒执行（在 reco 之后、exec 之前）
  private readonly cronExpr = process.env.CRON_RECO_TO_ORDER || '50 * * * * *';
  private readonly buildOnBoot =
    (process.env.BUILD_ORDER_ON_BOOT || '1') === '1';
  private readonly concurrency = Math.max(
    1,
    Number(process.env.ORDER_SUGGEST_CONCURRENCY || 2),
  );

  constructor(
    private readonly orderBuilder: OrderBuilderService,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  async onModuleInit() {
    this.logger.log(
      `OrdersScheduler ready: symbols=${this.symbols.join(', ')} cron="${this.cronExpr}" concurrency=${this.concurrency}`,
    );

    if (!this.buildOnBoot || this.symbols.length === 0) return;

    const t0 = Date.now();
    const { ok, skip, fail } = await this.runBatch(this.symbols);
    this.logger.log(
      `(boot) OrderSuggested: ok=${ok} skip=${skip} fail=${fail} in ${Date.now() - t0}ms`,
    );
  }

  // 直接用表达式定时；不再手算秒位
  @Cron(process.env.CRON_RECO_TO_ORDER || '50 * * * * *')
  async tick() {
    if (this.running) {
      this.logger.warn('Previous tick still running, skip this schedule.');
      return;
    }
    const syms = this.symbols;
    if (!syms?.length) {
      this.logger.warn('No symbols from SymbolRegistry, skip.');
      return;
    }

    this.running = true;
    const started = Date.now();
    try {
      const { ok, skip, fail } = await this.runBatch(syms);
      this.logger.log(
        `OrderSuggested tick: ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - started}ms`,
      );
    } finally {
      this.running = false;
    }
  }

  /** 轻量并发池：限制并发度，避免把下游/DB/网络打爆 */
  private async runBatch(syms: string[]) {
    let ok = 0,
      skip = 0,
      fail = 0;

    const poolSize = Math.min(this.concurrency, syms.length || 1);
    let idx = 0;

    const worker = async () => {
      while (idx < syms.length) {
        const my = idx++;
        const sym = syms[my];
        try {
          const r = await this.orderBuilder.buildOne(sym);
          r.ok ? ok++ : skip++;
        } catch (e: any) {
          fail++;
          this.logger.error(`OrderSuggested ✗ ${sym}: ${e?.message || e}`);
        }
      }
    };

    const workers = Array.from({ length: poolSize }, () => worker());
    await Promise.allSettled(workers);
    return { ok, skip, fail };
  }
}
