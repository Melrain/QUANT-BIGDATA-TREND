import { Injectable, OnModuleInit } from '@nestjs/common';
import { CollectorFetcher } from '../fetcher/collector.fetcher';

@Injectable()
export class CollectorScheduler implements OnModuleInit {
  constructor(private readonly fetcher: CollectorFetcher) {}

  async onModuleInit() {
    const rows = await this.fetcher.fetchTakerVolume('BTC');
    console.log(`Fetched taker volume data: ${rows.length} rows`);
    console.log(rows.slice(0, 2));
  }
}
