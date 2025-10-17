/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SymbolRegistry } from '../registry/symbol.registry';
import { CollectorFetcher } from '../fetcher/collector.fetcher';
import { CollectorParser } from '../parser/collector.parser';
import { CollectorAligner } from '../aligner/collector.aligner';
import { CollectorWriter } from '../writer/collector.writer';
import { EventEmitter2 } from '@nestjs/event-emitter';

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

  // 速率控制（来自 .env）
  // 每个 symbol 之间的停顿（毫秒）
  private readonly SYMBOL_DELAY_MS = Number(process.env.SYMBOL_DELAY_MS ?? 250);
  // 每个 endpoint 之间的停顿（毫秒）
  private readonly ENDPOINT_DELAY_MS = Number(
    process.env.ENDPOINT_DELAY_MS ?? 150,
  );
  // 是否启用现货 taker 共振（可选）
  private readonly enableSpotTaker =
    (process.env.OKX_ENABLE_SPOT_TAKER ?? '0') === '1';

  constructor(
    private readonly symbols: SymbolRegistry,
    private readonly fetcher: CollectorFetcher,
    private readonly parser: CollectorParser,
    private readonly aligner: CollectorAligner,
    private readonly writer: CollectorWriter, // 同时承担 status 写入
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.tick(); // 启动即跑一轮，验证链路
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
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

  /** 单个 symbol：顺序执行每个 endpoint（降低并发/限流风险） */
  private async runTasksForSymbol(sym: string) {
    const startAll = Date.now();

    // 统计容器（用于 status）
    const durations: Record<string, number> = {};
    const errorMap: Record<string, string> = {};
    let writtenTotal = 0;
    let skippedTotal = 0;

    const steps: Array<{ label: TaskLabel; run: () => Promise<void> }> = [
      {
        label: 'TAKER-VOLUME',
        run: async () => {
          const t0 = Date.now();
          try {
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
        run: async () => {
          const t0 = Date.now();
          try {
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
        run: async () => {
          const t0 = Date.now();
          try {
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
        run: async () => {
          const t0 = Date.now();
          try {
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
        run: async () => {
          const t0 = Date.now();
          try {
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

    if (this.enableSpotTaker) {
      steps.push({
        label: 'TAKER-VOLUME-SPOT',
        run: async () => {
          const t0 = Date.now();
          try {
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

    // —— 顺序执行 endpoints，期间加小间隔
    for (const step of steps) {
      await step.run();
      if (this.ENDPOINT_DELAY_MS > 0) {
        await this.sleep(this.ENDPOINT_DELAY_MS);
      }
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
      `Status for ${sym}: written=${writtenTotal}, skipped=${skippedTotal}, tasks=${steps.length}, elapsed=${Date.now() - startAll}ms`,
    );
  }

  /** 主调度：默认每分钟，可用 CRON_COLLECT 覆盖；按 symbol 顺序处理，整体发一次事件 */
  @Cron(process.env.CRON_COLLECT ?? '*/1 * * * *')
  async tick() {
    if (this.running) {
      this.logger.warn('Previous tick still running, skip.');
      return;
    }
    this.running = true;

    const startedAt = Date.now();
    const syms = this.symbols.getAll();
    if (!syms?.length) {
      this.logger.warn('SymbolRegistry is empty, skip.');
      this.running = false;
      return;
    }

    let ok = 0,
      fail = 0;

    try {
      for (let i = 0; i < syms.length; i++) {
        const sym = syms[i];
        this.logger.log(`↳ Collecting ${sym} (${i + 1}/${syms.length}) ...`);
        try {
          await this.runTasksForSymbol(sym);
          ok++;
        } catch (e: any) {
          fail++;
          this.logger.warn(
            `[collector] symbol ${sym} failed: ${e?.message ?? e}`,
          );
        } finally {
          // 每个 symbol 之间小憩，避免“尖峰并发”
          if (this.SYMBOL_DELAY_MS > 0 && i < syms.length - 1) {
            await this.sleep(this.SYMBOL_DELAY_MS);
          }
        }
      }

      const finishedAt = Date.now();
      const elapsedMs = finishedAt - startedAt;
      this.logger.log(
        `[collector] tick done symbols=${syms.length} ok=${ok} fail=${fail} in ${elapsedMs}ms`,
      );

      // —— 批次事件：只发一次
      this.eventEmitter.emit('collector.batchDone', {
        batchSeq: finishedAt, // 简单用时间戳即可，足够单调
        startedAt,
        finishedAt,
        symbols: syms, // 这次实际处理的 symbols 列表
        meta: { elapsedMs, ok, fail },
      });
      this.logger.log(
        `[collector] emitted collector.batchDone event: ${JSON.stringify({
          meta: { elapsedMs, ok, fail },
        })}`,
      );
    } finally {
      this.running = false;
    }
  }
}
