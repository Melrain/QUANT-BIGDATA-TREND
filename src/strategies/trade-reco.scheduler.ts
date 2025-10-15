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

  constructor(
    private readonly svc: TradeRecoService,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  private readonly cronExpr = process.env.CRON_RECO || '45 * * * * *';
  private readonly buildOnBoot =
    (process.env.BUILD_RECO_ON_BOOT || '1') === '1';

  async onModuleInit() {
    this.logger.log(
      `TradeRecoScheduler ready: symbols=${this.symbols.join(', ')} cron="${this.cronExpr}"`,
    );
    if (this.buildOnBoot) {
      for (const sym of this.symbols) {
        try {
          const r = await this.svc.buildOne(sym);
          this.logger.log(
            `(boot) ${sym}: ${r.ok ? 'OK' : `skip(${r.reason})`}`,
          );
        } catch (e: any) {
          this.logger.error(`(boot) ${sym}: ${e?.message || e}`);
        }
      }
    }
  }

  @Cron('* * * * * *')
  async tick() {
    const sec = new Date().getSeconds();
    const targetSec =
      Number((this.cronExpr.split(' ')[0] || '45').replace('*/', '')) || 45;
    const isEveryN = this.cronExpr.startsWith('*/');
    const n = isEveryN
      ? Number(this.cronExpr.slice(2).split(' ')[0]) || 1
      : null;
    const shouldRun = isEveryN ? sec % (n as number) === 0 : sec === targetSec;
    if (!shouldRun) return;

    if (this.running) {
      this.logger.warn('Previous tick still running, skip.');
      return;
    }
    this.running = true;

    const t0 = Date.now();
    let ok = 0,
      skip = 0,
      fail = 0;
    try {
      for (const sym of this.symbols) {
        try {
          const r = await this.svc.buildOne(sym);
          r.ok ? ok++ : skip++;
        } catch (e: any) {
          fail++;
          this.logger.error(`${sym}: ${e?.message || e}`);
        }
      }
    } finally {
      this.running = false;
      this.logger.log(
        `reco tick: ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - t0}ms`,
      );
    }
  }
}
