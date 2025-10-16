/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unused-expressions */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeRecoService } from './trade-reco.service';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';

@Injectable()
export class TradeRecoScheduler implements OnModuleInit {
  private readonly logger = new Logger(TradeRecoScheduler.name);
  private running = false;

  private readonly cronExpr = process.env.CRON_RECO || '45 * * * * *';
  private readonly buildOnBoot =
    (process.env.BUILD_RECO_ON_BOOT || '1') === '1';
  private readonly concurrency = Math.max(
    1,
    Number(process.env.RECO_CONCURRENCY || 2),
  );

  constructor(
    private readonly svc: TradeRecoService,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  async onModuleInit() {
    this.logger.log(
      `TradeRecoScheduler ready: symbols=${this.symbols.join(', ')} cron="${this.cronExpr}" concurrency=${this.concurrency}`,
    );

    if (!this.buildOnBoot || this.symbols.length === 0) return;

    const t0 = Date.now();
    const { ok, skip, fail } = await this.runBatch(this.symbols);
    this.logger.log(
      `(boot) reco: ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - t0}ms`,
    );
  }

  // ✅ 直接使用环境里的 Cron 表达式；不再手动解析秒数
  @Cron(process.env.CRON_RECO || '45 * * * * *')
  async tick() {
    if (this.running) {
      this.logger.warn('Previous tick still running, skip.');
      return;
    }
    const syms = this.symbols;
    if (!syms?.length) {
      this.logger.warn('No symbols from SymbolRegistry, skip.');
      return;
    }

    this.running = true;
    const t0 = Date.now();
    try {
      const { ok, skip, fail } = await this.runBatch(syms);
      this.logger.log(
        `reco tick: ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - t0}ms`,
      );
    } finally {
      this.running = false;
    }
  }

  /** 轻量并发池：限制并行度，避免把下游/DB/网络打爆 */
  private async runBatch(syms: string[]) {
    let ok = 0,
      skip = 0,
      fail = 0;

    // 简单 async pool（无第三方依赖）
    const poolSize = Math.min(this.concurrency, syms.length || 1);
    let idx = 0;

    const worker = async () => {
      while (idx < syms.length) {
        const my = idx++;
        const sym = syms[my];
        try {
          const r = await this.svc.buildOne(sym);
          r.ok ? ok++ : skip++;
        } catch (e: any) {
          fail++;
          this.logger.error(`${sym}: ${e?.message || e}`);
        }
      }
    };

    const workers = Array.from({ length: poolSize }, () => worker());
    await Promise.allSettled(workers);
    return { ok, skip, fail };
  }
}
