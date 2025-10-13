// src/collector/fetcher/collector.fetcher.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from '@/infra/http/http-client.service';
import { OKX_BIGDATA_ENDPOINTS } from './endpoints.map';

type EpDef = {
  paths: readonly string[];
  buildParams: (sym: string, path: string) => Record<string, any>;
};

@Injectable()
export class CollectorFetcher {
  private readonly logger = new Logger(CollectorFetcher.name);

  constructor(private readonly http: HttpClientService) {}

  // ====== 公共：带回退的抓取器 ======
  private async fetchWithFallback(
    label: string,
    ep: EpDef,
    symForParams: string, // 现货类也传 sym，内部只取 ccy
  ): Promise<any[]> {
    for (const path of ep.paths) {
      const params = ep.buildParams(symForParams, path);
      try {
        const res = await this.http.get<{ code?: string; data?: any[] }>(
          path,
          params,
        );

        const arr = Array.isArray(res?.data) ? res.data : undefined;
        if (arr && arr.length > 0) {
          this.logger.log(
            `[OKX] ${label} ✓ ${path}?${new URLSearchParams(
              Object.entries(params).map(([k, v]) => [k, String(v)]),
            ).toString()}  rows=${arr.length}`,
          );
          return arr;
        }

        // 空数组或结构异常，继续尝试下一条
        this.logger.warn(
          `[OKX] ${label} ? ${path} empty or unexpected payload`,
        );
      } catch (err: any) {
        const status = err?.response?.status;
        const code = err?.response?.data?.code ?? err?.code;
        const msg =
          err?.response?.data?.msg ??
          err?.message ??
          'request failed (unknown)';
        this.logger.warn(
          `[OKX] ${label} ✗ ${path}?${new URLSearchParams(
            Object.entries(ep.buildParams(symForParams, path)).map(([k, v]) => [
              k,
              String(v),
            ]),
          ).toString()}  status=${status}  code=${code}  ${msg}`,
        );
      }
    }

    this.logger.error(
      `[OKX] ${label} ❌ all paths failed for sym=${symForParams}`,
    );
    return [];
  }

  // ====== 具体资源 ======

  /** 支持币种/合约列表（仅注册使用，不入 bars） */
  async fetchSupportCoins(): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.supportCoins;
    // 这里不需要 sym，传个占位即可
    return this.fetchWithFallback('SupportCoins', ep as any, 'BTC-USDT-SWAP');
  }

  /** 合约 OI 历史（初始化/长回测可用） */
  async fetchOpenInterestHistory(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.openInterestHistory;
    return this.fetchWithFallback('OpenInterestHistory', ep as any, sym);
  }

  /** 现货 taker（可选，用于背离/共振过滤） */
  async fetchTakerVolumeSpot(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.takerVolumeSpot;
    return this.fetchWithFallback('TakerVolumeSpot', ep as any, sym);
  }

  /** 合约 taker（核心） */
  async fetchTakerVolumeContract(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.takerVolumeContract;
    return this.fetchWithFallback('TakerVolume', ep as any, sym);
  }

  /** 融资融券比（现货情绪，可选） */
  async fetchMarginLoanRatio(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.marginLoanRatio;
    return this.fetchWithFallback('MarginLoanRatio', ep as any, sym);
  }

  /** 合约 OI & Volume（核心） */
  async fetchOpenInterestVolumeContracts(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.openInterestVolumeContracts;
    return this.fetchWithFallback('OpenInterestVolume', ep as any, sym);
  }

  /** 全体用户 多空账户比（合约优先） */
  async fetchLongShortAllAccounts(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortAllAccounts;
    return this.fetchWithFallback('LongShortAll', ep as any, sym);
  }

  /** 精英 Top Trader —— 账户数比 */
  async fetchLongShortEliteAccountTopTrader(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortEliteAccountTopTrader;
    return this.fetchWithFallback('LongShortElite(Account)', ep as any, sym);
  }

  /** 精英 Top Trader —— 持仓量比 */
  async fetchLongShortElitePositionTopTrader(sym: string): Promise<any[]> {
    const ep = OKX_BIGDATA_ENDPOINTS.longShortElitePositionTopTrader;
    return this.fetchWithFallback('LongShortElite(Position)', ep as any, sym);
  }
}
