/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SymbolRegistry } from '../registry/symbol.registry';
import { CollectorFetcher } from '../fetcher/collector.fetcher';
import { CollectorParser } from '../parser/collector.parser';
import { CollectorAligner } from '../aligner/collector.aligner';
import { CollectorWriter } from '../writer/collector.writer';

type TaskLabel =
  | 'TAKER-VOLUME'
  | 'OI/VOL'
  | 'LS-ALL'
  | 'LS-ELITE-ACC'
  | 'LS-ELITE-POS'
  | 'TAKER-VOLUME-SPOT';

@Injectable()
export class CollectorScheduler implements OnModuleInit {
  private readonly logger = new Logger(CollectorScheduler.name);
  private running = false;

  // 是否启用现货 taker 共振（可选）
  private readonly enableSpotTaker =
    (process.env.OKX_ENABLE_SPOT_TAKER ?? '0') === '1';

  constructor(
    private readonly symbols: SymbolRegistry,
    private readonly fetcher: CollectorFetcher,
    private readonly parser: CollectorParser,
    private readonly aligner: CollectorAligner,
    private readonly writer: CollectorWriter, // 同时承担 status 写入
  ) {}

  async onModuleInit() {
    await this.tick(); // 启动即跑一轮，验证链路
  }

  /** 工具：对齐 + 落库 bars + 统计 */
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

  private warnTask(label: TaskLabel, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(`[${label}] ${msg}`);
    return msg;
  }

  /** 单个 symbol 全部任务 */
  private async runTasksForSymbol(sym: string) {
    const startAll = Date.now();

    // 统计容器（用于 status）
    const durations: Record<string, number> = {};
    const errorMap: Record<string, string> = {};
    let writtenTotal = 0;
    let skippedTotal = 0;

    // 小助手：跑一个任务并计时/计错
    const run = async (
      label: TaskLabel,
      eff: () => Promise<{ written: number; skippedDup: number } | void>,
    ) => {
      const t0 = Date.now();
      try {
        const res = (await eff()) || { written: 0, skippedDup: 0 };
        writtenTotal += res.written;
        skippedTotal += res.skippedDup;
      } catch (e) {
        errorMap[label] = this.warnTask(label, e);
      } finally {
        durations[label] = Date.now() - t0;
      }
    };

    // 1) 合约 taker
    await run('TAKER-VOLUME', async () => {
      const raw = await this.fetcher.fetchTakerVolumeContract(sym);
      const parsed = this.parser.parseTakerVolumeContract(raw, sym);
      return this.alignAndPersist(parsed, 'TAKER-VOLUME');
    });

    // 2) OI & Volume（合约）
    await run('OI/VOL', async () => {
      const raw = await this.fetcher.fetchOpenInterestVolumeContracts(sym);
      const parsed = this.parser.parseOpenInterestVolumeContracts(raw, sym);
      return this.alignAndPersist(parsed, 'OI/VOL');
    });

    // 3) 全体账户多空比（合约口径 / 内含 fallback）
    await run('LS-ALL', async () => {
      const raw = await this.fetcher.fetchLongShortAllAccounts(sym);
      const parsed = this.parser.parseLongShortAllAccounts(raw, sym);
      return this.alignAndPersist(parsed, 'LS-ALL');
    });

    // 4) 精英账户数比（Top Trader）
    await run('LS-ELITE-ACC', async () => {
      const raw = await this.fetcher.fetchLongShortEliteAccountTopTrader(sym);
      const parsed = this.parser.parseLongShortEliteAccountTopTrader(raw, sym);
      return this.alignAndPersist(parsed, 'LS-ELITE-ACC');
    });

    // 5) 精英持仓量比（Top Trader）
    await run('LS-ELITE-POS', async () => {
      const raw = await this.fetcher.fetchLongShortElitePositionTopTrader(sym);
      const parsed = this.parser.parseLongShortElitePositionTopTrader(raw, sym);
      return this.alignAndPersist(parsed, 'LS-ELITE-POS');
    });

    // 6) 可选：现货 taker（共振/背离过滤）
    if (this.enableSpotTaker) {
      await run('TAKER-VOLUME-SPOT', async () => {
        const raw = await this.fetcher.fetchTakerVolumeSpot(sym);
        const asset = sym.split('-')[0];
        const parsed = this.parser.parseTakerVolumeSpot(raw, asset);
        return this.alignAndPersist(parsed, 'TAKER-VOLUME-SPOT');
      });
    }

    // —— 写入一条 Status（每个 symbol 一条）
    await this.writer.persistStatus({
      sym,
      ts: Date.now(),
      written: writtenTotal,
      skippedDup: skippedTotal,
      durations,
      errorMap,
      degraded: Object.keys(errorMap).length > 0,
    });

    this.logger.log(
      `Status for ${sym}: written=${writtenTotal}, skipped=${skippedTotal}, tasks=${Object.keys(durations).length}, elapsed=${Date.now() - startAll}ms`,
    );
  }

  /** 主调度：默认每分钟，可用 CRON_COLLECT 覆盖 */
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

      for (const sym of syms) {
        this.logger.log(`↳ Collecting ${sym} ...`);
        await this.runTasksForSymbol(sym); // 顺序跑，友好限速
      }
    } finally {
      this.running = false;
    }
  }
}
