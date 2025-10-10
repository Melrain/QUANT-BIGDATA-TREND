/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, Logger } from '@nestjs/common';

import { OKX_BIGDATA_ENDPOINTS } from './endpoints.map';
import { HttpClientService } from '@/infra/http/http-client.service';

@Injectable()
export class CollectorFetcher {
  private readonly logger = new Logger(CollectorFetcher.name);

  constructor(private readonly http: HttpClientService) {}

  async fetchTakerVolume(ccy: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.takerVolume;
    const data = await this.http.get<{ data: any[] }>(ep.path, ep.params(ccy));
    this.logger.log(`Fetched ${data.data?.length ?? 0} rows for ${ccy}`);

    return data.data ?? [];
  }

  async fetchOpenInterestVolume(ccy: string) {
    const ep = OKX_BIGDATA_ENDPOINTS.openInterestVolume;
    const data = await this.http.get<{ data: any[] }>(ep.path, ep.params(ccy));
    this.logger.log(`Fetched OI/Vol ${ccy}: ${data.data?.length ?? 0}`);
    return data.data ?? [];
  }

  async fetchLongShortAll(ccy: string) {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortAll;
    const data = await this.http.get<{ data: any[] }>(ep.path, ep.params(ccy));
    this.logger.log(`Fetched LongShort ALL ${ccy}: ${data.data?.length ?? 0}`);
    return data.data ?? [];
  }

  async fetchLongShortElite(ccy: string) {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortElite;
    const data = await this.http.get<{ data: any[] }>(ep.path, ep.params(ccy));
    this.logger.log(
      `Fetched LongShort ELITE ${ccy}: ${data.data?.length ?? 0}`,
    );
    return data.data ?? [];
  }
}
