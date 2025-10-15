/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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

  // 受控并发（来自 .env）
  private readonly CONCURRENCY_SYMBOLS = Number(
    process.env.CONCURRENCY_SYMBOLS ?? 3,
  );
  private readonly CONCURRENCY_ENDPOINTS = Number(
    process.env.CONCURRENCY_ENDPOINTS ?? 3,
  );
  private readonly JITTER_MS = Number(process.env.JITTER_MS ?? 200);

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

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  /** 轻量并发执行器：把一组 async 函数以固定并发跑完 */
  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
  ): Promise<(T | undefined)[]> {
    const results: (T | undefined)[] = new Array(tasks.length);
    let cursor = 0;

    const workers = new Array(Math.min(limit, tasks.length))
      .fill(0)
      .map(async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= tasks.length) break;
          try {
            results[idx] = await tasks[idx]();
          } catch (err) {
            this.logger.warn(
              `[collector] task#${idx} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            results[idx] = undefined;
          }
        }
      });

    await Promise.all(workers);
    return results;
  }

  /** 单个 symbol 全部任务 —— 受控并发版本 */
  private async runTasksForSymbol(sym: string) {
    const startAll = Date.now();

    // 统计容器（用于 status）
    const durations: Record<string, number> = {};
    const errorMap: Record<string, string> = {};
    let writtenTotal = 0;
    let skippedTotal = 0;

    // 把每个 endpoint 封成一个“可执行任务”
    const endpointTasks: Array<{ label: TaskLabel; fn: () => Promise<void> }> =
      [
        {
          label: 'TAKER-VOLUME',
          fn: async () => {
            const t0 = Date.now();
            try {
              await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
              const raw = await this.fetcher.fetchTakerVolumeContract(sym);
              const parsed = this.parser.parseTakerVolumeContract(raw, sym);
              const res = await this.alignAndPersist(parsed, 'TAKER-VOLUME');
              writtenTotal += res.written;
              skippedTotal += res.skippedDup;
            } catch (e) {
              errorMap['TAKER-VOLUME'] = this.warnTask('TAKER-VOLUME', e);
            } finally {
              durations['TAKER-VOLUME'] = Date.now() - t0;
            }
          },
        },
        {
          label: 'OI/VOL',
          fn: async () => {
            const t0 = Date.now();
            try {
              await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
              const raw =
                await this.fetcher.fetchOpenInterestVolumeContracts(sym);
              const parsed = this.parser.parseOpenInterestVolumeContracts(
                raw,
                sym,
              );
              const res = await this.alignAndPersist(parsed, 'OI/VOL');
              writtenTotal += res.written;
              skippedTotal += res.skippedDup;
            } catch (e) {
              errorMap['OI/VOL'] = this.warnTask('OI/VOL', e);
            } finally {
              durations['OI/VOL'] = Date.now() - t0;
            }
          },
        },
        {
          label: 'LS-ALL',
          fn: async () => {
            const t0 = Date.now();
            try {
              await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
              const raw = await this.fetcher.fetchLongShortAllAccounts(sym);
              const parsed = this.parser.parseLongShortAllAccounts(raw, sym);
              const res = await this.alignAndPersist(parsed, 'LS-ALL');
              writtenTotal += res.written;
              skippedTotal += res.skippedDup;
            } catch (e) {
              errorMap['LS-ALL'] = this.warnTask('LS-ALL', e);
            } finally {
              durations['LS-ALL'] = Date.now() - t0;
            }
          },
        },
        {
          label: 'LS-ELITE-ACC',
          fn: async () => {
            const t0 = Date.now();
            try {
              await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
              const raw =
                await this.fetcher.fetchLongShortEliteAccountTopTrader(sym);
              const parsed = this.parser.parseLongShortEliteAccountTopTrader(
                raw,
                sym,
              );
              const res = await this.alignAndPersist(parsed, 'LS-ELITE-ACC');
              writtenTotal += res.written;
              skippedTotal += res.skippedDup;
            } catch (e) {
              errorMap['LS-ELITE-ACC'] = this.warnTask('LS-ELITE-ACC', e);
            } finally {
              durations['LS-ELITE-ACC'] = Date.now() - t0;
            }
          },
        },
        {
          label: 'LS-ELITE-POS',
          fn: async () => {
            const t0 = Date.now();
            try {
              await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
              const raw =
                await this.fetcher.fetchLongShortElitePositionTopTrader(sym);
              const parsed = this.parser.parseLongShortElitePositionTopTrader(
                raw,
                sym,
              );
              const res = await this.alignAndPersist(parsed, 'LS-ELITE-POS');
              writtenTotal += res.written;
              skippedTotal += res.skippedDup;
            } catch (e) {
              errorMap['LS-ELITE-POS'] = this.warnTask('LS-ELITE-POS', e);
            } finally {
              durations['LS-ELITE-POS'] = Date.now() - t0;
            }
          },
        },
      ];

    // 可选：现货 taker
    if (this.enableSpotTaker) {
      endpointTasks.push({
        label: 'TAKER-VOLUME-SPOT',
        fn: async () => {
          const t0 = Date.now();
          try {
            await this.sleep(Math.floor(Math.random() * this.JITTER_MS));
            const raw = await this.fetcher.fetchTakerVolumeSpot(sym);
            const asset = sym.split('-')[0];
            const parsed = this.parser.parseTakerVolumeSpot(raw, asset);
            const res = await this.alignAndPersist(parsed, 'TAKER-VOLUME-SPOT');
            writtenTotal += res.written;
            skippedTotal += res.skippedDup;
          } catch (e) {
            errorMap['TAKER-VOLUME-SPOT'] = this.warnTask(
              'TAKER-VOLUME-SPOT',
              e,
            );
          } finally {
            durations['TAKER-VOLUME-SPOT'] = Date.now() - t0;
          }
        },
      });
    }

    // 同一 symbol 内：受控并发跑 endpoints
    const endpointFns = endpointTasks.map((t) => t.fn);
    await this.runWithConcurrency(endpointFns, this.CONCURRENCY_ENDPOINTS);

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

  /** 主调度：默认每分钟，可用 CRON_COLLECT 覆盖；不同 symbol 之间也并发 */
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

      const t0 = Date.now();
      // 每个 symbol 是一个任务：内部再并发 endpoints
      const symbolTasks = syms.map((sym) => async () => {
        this.logger.log(`↳ Collecting ${sym} ...`);
        await this.runTasksForSymbol(sym);
      });

      await this.runWithConcurrency(symbolTasks, this.CONCURRENCY_SYMBOLS);

      this.logger.log(
        `[collector] tick done symbols=${syms.length} in ${Date.now() - t0}ms`,
      );
    } finally {
      this.running = false;
    }
  }
}
