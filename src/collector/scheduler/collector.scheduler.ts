/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/collector/scheduler/collector.scheduler.ts
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SymbolRegistry } from '../registry/symbol.registry';
import { CollectorFetcher } from '../fetcher/collector.fetcher';
import { CollectorParser } from '../parser/collector.parser';
import { CollectorAligner } from '../aligner/collector.aligner';
import { CollectorWriter } from '../writer/collector.writer';

@Injectable()
export class CollectorScheduler implements OnModuleInit {
  private readonly logger = new Logger(CollectorScheduler.name);
  private running = false;

  // 可选：是否采集现货 taker 做共振过滤
  private readonly enableSpotTaker =
    (process.env.OKX_ENABLE_SPOT_TAKER ?? '0') === '1';

  constructor(
    private readonly symbols: SymbolRegistry,
    private readonly fetcher: CollectorFetcher,
    private readonly parser: CollectorParser,
    private readonly aligner: CollectorAligner,
    private readonly writer: CollectorWriter,
  ) {}

  async onModuleInit() {
    // 首次启动跑一次，确认落库链路正常
    await this.tick();
  }

  /** 工具：对齐 + 落库 + 统计日志 */
  private async alignAndPersist(
    parsed: Array<Record<string, any>>,
    label: string,
  ) {
    if (!parsed?.length) {
      this.logger.log(
        `Mongo ${label} persist: written=0, skippedDup=0 (empty)`,
      );
      return { written: 0, skippedDup: 0 };
    }
    const aligned = this.aligner.alignAndFilter(parsed as any[]);
    const { written, skippedDup } = await this.writer.persist(aligned);
    this.logger.log(
      `Mongo ${label} persist: written=${written}, skippedDup=${skippedDup}`,
    );
    return { written, skippedDup };
  }

  /** 工具：单个合约的一组采集任务 */
  private async runTasksForSymbol(sym: string) {
    const asset = sym.split('-')[0];

    // 1) 合约 Taker
    try {
      const raw = await this.fetcher.fetchTakerVolumeContract(sym);
      const parsed = this.parser.parseTakerVolumeContract(raw, sym);
      await this.alignAndPersist(parsed, 'TAKER-VOLUME');
    } catch (err) {
      this.warnTask('TAKER-VOLUME', err);
    }

    // 2) OI & Volume
    try {
      const raw = await this.fetcher.fetchOpenInterestVolumeContracts(sym);
      const parsed = this.parser.parseOpenInterestVolumeContracts(raw, sym);
      await this.alignAndPersist(parsed, 'OI/VOL');
    } catch (err) {
      this.warnTask('OI/VOL', err);
    }

    // 3) 全体账户多空比（合约口径 / fallback 内部做了）
    try {
      const raw = await this.fetcher.fetchLongShortAllAccounts(sym);
      const parsed = this.parser.parseLongShortAllAccounts(raw, sym);
      await this.alignAndPersist(parsed, 'LS-ALL');
    } catch (err) {
      this.warnTask('LS-ALL', err);
    }

    // 4) 精英（Top Trader）账户数比
    try {
      const raw = await this.fetcher.fetchLongShortEliteAccountTopTrader(sym);
      const parsed = this.parser.parseLongShortEliteAccountTopTrader(raw, sym);
      await this.alignAndPersist(parsed, 'LS-ELITE-ACC');
    } catch (err) {
      this.warnTask('LS-ELITE-ACC', err);
    }

    // 5) 精英（Top Trader）持仓量比
    try {
      const raw = await this.fetcher.fetchLongShortElitePositionTopTrader(sym);
      const parsed = this.parser.parseLongShortElitePositionTopTrader(raw, sym);
      await this.alignAndPersist(parsed, 'LS-ELITE-POS');
    } catch (err) {
      this.warnTask('LS-ELITE-POS', err);
    }

    // 6) （可选）现货 Taker（做共振/背离过滤）
    if (this.enableSpotTaker) {
      try {
        const raw = await this.fetcher.fetchTakerVolumeSpot(sym);
        const parsed = this.parser.parseTakerVolumeSpot(raw, asset);
        await this.alignAndPersist(parsed, 'TAKER-VOLUME-SPOT');
      } catch (err) {
        this.warnTask('TAKER-VOLUME-SPOT', err);
      }
    }
  }

  private warnTask(label: string, err: unknown) {
    if (err instanceof Error) {
      this.logger.warn(`[${label}] ${err.message}`);
    } else {
      this.logger.warn(`[${label}] ${String(err)}`);
    }
  }

  /** 主调度：默认每分钟 */
  @Cron(process.env.CRON_COLLECT ?? '*/1 * * * *')
  async tick() {
    if (this.running) {
      this.logger.warn('Previous tick still running, skip.');
      return;
    }
    this.running = true;

    try {
      const syms = this.symbols.getAll();
      if (!syms?.length) {
        this.logger.warn('SymbolRegistry is empty, skip.');
        return;
      }

      // 顺序执行（OKX 限速友好）。若需要并行，可换成 Promise.allSettled 并加延迟。
      for (const sym of syms) {
        this.logger.log(`↳ Collecting ${sym} ...`);
        await this.runTasksForSymbol(sym);
      }
    } finally {
      this.running = false;
    }
  }
}
