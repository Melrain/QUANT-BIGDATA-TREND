/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from '@/infra/http/http-client.service';
import { OKX_BIGDATA_ENDPOINTS } from './endpoints.map';

@Injectable()
export class CollectorFetcher {
  private readonly logger = new Logger(CollectorFetcher.name);
  constructor(private readonly http: HttpClientService) {}

  /**
   * 通用多路径重试：
   * - 每条 path 单独构造 params（instId + ccy 或仅 ccy）
   * - 打印完整 URL 与响应体片段，便于定位 400/404/502
   */
  private async tryPaths<T>(
    name: string,
    sym: string,
    paths: ReadonlyArray<string>,
    buildParams: (sym: string, path: string) => Record<string, any>,
  ): Promise<T[]> {
    for (const path of paths) {
      const params = buildParams(sym, path);
      const qs = new URLSearchParams(
        params as Record<string, string>,
      ).toString();
      const url = `${path}?${qs}`;
      try {
        const res = await this.http.get<{ data: T[] }>(path, params);
        if (Array.isArray(res?.data)) {
          this.logger.log(`[OKX] ${name} ✓ ${url}  rows=${res.data.length}`);
          return res.data;
        }
        this.logger.warn(`[OKX] ${name} ? ${url}  unexpected payload`);
      } catch (err: any) {
        const code = err?.response?.status;
        const body = err?.response?.data
          ? JSON.stringify(err.response.data)
          : '';
        this.logger.warn(`[OKX] ${name} ✗ ${url}  status=${code}  ${body}`);
      }
    }
    this.logger.error(`[OKX] ${name} ❌ all paths failed for sym=${sym}`);
    return [];
  }

  /** 1) Taker Volume */
  async fetchTakerVolume(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.takerVolume;
    return this.tryPaths('TakerVolume', sym, ep.paths, ep.buildParams);
  }

  /** 2) OI & Contracts Volume */
  async fetchOpenInterestVolume(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.openInterestVolume;
    return this.tryPaths('OpenInterestVolume', sym, ep.paths, ep.buildParams);
  }

  /** 3) Long/Short (All Users) */
  async fetchLongShortAll(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortAll;
    return this.tryPaths('LongShortAll', sym, ep.paths, ep.buildParams);
  }

  /** 4) Long/Short (Elite Traders) */
  async fetchLongShortElite(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortElite;
    return this.tryPaths('LongShortElite', sym, ep.paths, ep.buildParams);
  }
}
