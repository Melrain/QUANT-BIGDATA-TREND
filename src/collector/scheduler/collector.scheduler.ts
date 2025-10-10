/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CollectorFetcher } from '../fetcher/collector.fetcher';
import { CollectorAligner } from '../aligner/collector.aligner';
import { CollectorParser } from '../parser/collector.parser';
import { SymbolRegistry } from '../registry/symbol.registry';
import { CollectorWriter } from '../writer/collector.writer';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class CollectorScheduler implements OnModuleInit {
  private readonly logger = new Logger(CollectorScheduler.name);
  private running = false; // 运行锁

  constructor(
    private readonly symbols: SymbolRegistry,
    private readonly fetcher: CollectorFetcher,
    private readonly parser: CollectorParser,
    private readonly aligner: CollectorAligner,
    private readonly writer: CollectorWriter,
  ) {}

  async onModuleInit() {
    // ...existing code...
  }

  // 将对齐 + 写入封装成一个小函数
  private async alignAndPersist<T>(parsed: T[], label: string) {
    const aligned = this.aligner.alignAndFilter(parsed as unknown as any[]);
    const { written, skippedDup } = await this.writer.persist(aligned);
    this.logger.log(
      `Mongo ${label} persist: written=${written}, skippedDup=${skippedDup}`,
    );
    return { written, skippedDup };
  }

  private logTaskError(task: string, err: unknown) {
    if (err instanceof Error) {
      this.logger.error(`[${task}] ${err.message}`, err.stack);
    } else {
      this.logger.error(`[${task}] ${String(err)}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  @Cron(process.env.CRON_COLLECT ?? '*/1 * * * *')
  async tick() {
    if (this.running) {
      this.logger.warn('Previous tick still running, skip this schedule.');
      return;
    }
    this.running = true;

    try {
      const sym = this.symbols.getAll()[0];
      const asset = sym.split('-')[0];

      // 1) taker-volume
      try {
        const raw = await this.fetcher.fetchTakerVolume(asset);
        const parsed = this.parser.parseTakerVolume(raw, sym);
        await this.alignAndPersist(parsed, 'TAKER-VOLUME');
      } catch (err) {
        this.logTaskError('TAKER-VOLUME', err);
      }

      // 2) OI & Vol
      try {
        const raw = await this.fetcher.fetchOpenInterestVolume(asset);
        const parsed = this.parser.parseOpenInterestVolume(raw, sym);
        await this.alignAndPersist(parsed, 'OI/VOL');
      } catch (err) {
        this.logTaskError('OI/VOL', err);
      }

      // 3) LongShort ALL
      try {
        const raw = await this.fetcher.fetchLongShortAll(asset);
        const parsed = this.parser.parseLongShortAll(raw, sym);
        await this.alignAndPersist(parsed, 'LS-ALL');
      } catch (err) {
        this.logTaskError('LS-ALL', err);
      }

      // 4) LongShort ELITE
      try {
        const raw = await this.fetcher.fetchLongShortElite(asset);
        const parsed = this.parser.parseLongShortElite(raw, sym);
        await this.alignAndPersist(parsed, 'LS-ELITE');
      } catch (err) {
        this.logTaskError('LS-ELITE', err);
      }
    } finally {
      this.running = false;
    }
  }
}
