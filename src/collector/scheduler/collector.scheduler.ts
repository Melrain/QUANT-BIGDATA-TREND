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
  constructor(
    private readonly symbols: SymbolRegistry,
    private readonly fetcher: CollectorFetcher,
    private readonly parser: CollectorParser,
    private readonly aligner: CollectorAligner,
    private readonly writer: CollectorWriter,
  ) {}

  async onModuleInit() {
    // const rows = await this.fetcher.fetchTakerVolume('BTC');
    // console.log(`Fetched taker volume data: ${rows.length} rows`);
    // console.log(rows.slice(0, 2));
    // const sym = this.symbols.getAll()[0];
    // const asset = sym.split('-')[0]; // e.g. BTC
    // // 抓取 + 解析 + 对齐 + 过滤
    // const raw = await this.fetcher.fetchTakerVolume(asset);
    // this.logger.log(`Fetched taker-volume for ${sym}: ${raw.length} rows`);
    // const parsed = this.parser.parseTakerVolume(raw, sym);
    // const aligned = this.aligner.alignAndFilter(parsed);
    // this.logger.log(`Aligned + filtered bars: ${aligned.length}`);
    // console.log(aligned.slice(0, 4));
    // 写入mongo
    // const { written, skippedDup } = await this.writer.persist(aligned);
    // this.logger.log(
    //   `Mongo persist: written=${written}, skippedDup=${skippedDup}`,
    // );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  @Cron(process.env.CRON_COLLECT ?? '*/1 * * * *')
  async tick() {
    const sym = this.symbols.getAll()[0];
    const asset = sym.split('-')[0];

    const raw = await this.fetcher.fetchTakerVolume(asset);
    const parsed = this.parser.parseTakerVolume(raw, sym);
    const aligned = this.aligner.alignAndFilter(parsed);

    const { written, skippedDup } = await this.writer.persist(aligned);
    this.logger.log(
      `Mongo persist: written=${written}, skippedDup=${skippedDup}`,
    );
  }
}
