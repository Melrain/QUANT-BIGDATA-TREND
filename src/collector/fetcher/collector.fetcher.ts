/* eslint-disable @typescript-eslint/no-unsafe-argument */
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

  // —— 轻量节流参数（不够再加大）
  private minIntervalMs = Number(process.env.RUBIK_MIN_INTERVAL_MS ?? 120); // 全局最小请求间隔 ≈ 8~9 QPS
  private lastHit = 0;
  private penaltyUntil = 0;
  private readonly minMsFloor = 60; // 下限
  private readonly minMsCeil = 500; // 上限

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  /** 每次请求前简单“过闸” */
  private async gate() {
    const now = Date.now();
    if (now < this.penaltyUntil) {
      await this.sleep(this.penaltyUntil - now);
    }
    const wait = this.lastHit + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastHit = Date.now();
  }

  /** 命中 50011/429 时，临时加大间隔并设置短惩罚期 */
  private penalize() {
    this.minIntervalMs = Math.min(this.minIntervalMs * 1.25, this.minMsCeil); // 慢一点
    this.penaltyUntil = Date.now() + Math.max(600, this.minIntervalMs); // 短暂停
  }

  /** 请求成功时，缓慢恢复 */
  private reward() {
    this.minIntervalMs = Math.max(
      Math.floor(this.minIntervalMs * 0.95),
      this.minMsFloor,
    );
  }

  // ====== 公共：带回退的抓取器（加强版） ======
  private async fetchWithFallback(
    label: string,
    ep: EpDef,
    symForParams: string,
  ): Promise<any[]> {
    const EMPTY_RETRY = 1; // 空数组时再试 1 次
    const ERROR_RETRY = Number(process.env.RUBIK_ERROR_RETRY ?? 1);
    const JITTER_MS = Number(process.env.RUBIK_JITTER_MS ?? 200);
    const BASE_BACKOFF_MS = Number(process.env.RUBIK_BACKOFF_MS ?? 300);

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const jitter = () => Math.floor(Math.random() * JITTER_MS);
    const qs = (p: Record<string, any>) =>
      new URLSearchParams(
        Object.entries(p).map(([k, v]) => [k, String(v)]),
      ).toString();

    for (const path of ep.paths) {
      const params = ep.buildParams(symForParams, path);
      let emptyLeft = EMPTY_RETRY;
      let errLeft = ERROR_RETRY;

      attempt: do {
        try {
          // 轻微抖动 + 过闸（全局最小间隔）
          if (JITTER_MS > 0) await sleep(jitter());
          await this.gate();

          const res = await this.http.get<{ code?: string; data?: any }>(
            path,
            params,
          );
          const payload: any = res;
          const okxCode = payload?.code ?? payload?.data?.code;

          if (okxCode && okxCode !== '0') {
            const msg = payload?.msg ?? payload?.data?.msg ?? 'unknown';
            this.logger.warn(
              `[OKX] ${label} ! ${path}?${qs(params)} code=${okxCode} msg=${msg}`,
            );

            // 限流：自适应降速 + 少量退避
            if (okxCode === '50011' && errLeft > 0) {
              this.penalize();
              const backoff =
                BASE_BACKOFF_MS * Math.pow(2, ERROR_RETRY - errLeft) + jitter();
              errLeft--;
              await sleep(backoff);
              continue attempt;
            }

            // 明确不可重试：参数/路由问题
            if (['404', '50014', '51000'].includes(String(okxCode)))
              break attempt;

            // 其他业务错：小次数退避
            if (errLeft > 0) {
              const backoff =
                BASE_BACKOFF_MS * Math.pow(2, ERROR_RETRY - errLeft) + jitter();
              errLeft--;
              await sleep(backoff);
              continue attempt;
            }
            break attempt;
          }

          const bodyData = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.data?.data)
              ? payload.data.data
              : undefined;

          const arr = Array.isArray(bodyData)
            ? bodyData
            : Array.isArray(payload)
              ? payload
              : undefined;

          if (arr && arr.length > 0) {
            this.reward();
            this.logger.log(
              `[OKX] ${label} ✓ ${path}?${qs(params)} rows=${arr.length}`,
            );
            return arr;
          }

          // 空数组：轻重试一次
          this.logger.warn(
            `[OKX] ${label} ? ${path}?${qs(params)} empty/unexpected`,
          );
          if (emptyLeft > 0) {
            emptyLeft--;
            await sleep(200 + jitter());
            continue attempt;
          }
          break attempt;
        } catch (err: any) {
          const status = err?.response?.status;
          const bizCode = err?.response?.data?.code
            ? String(err.response.data.code)
            : undefined;
          const code = err?.code;

          const tooMany = status === 429 || bizCode === '50011';
          const retriable =
            tooMany ||
            (status && status >= 500) ||
            [
              'ECONNRESET',
              'ETIMEDOUT',
              'EAI_AGAIN',
              'ERR_BAD_RESPONSE',
            ].includes(code);

          this.logger.warn(
            `[OKX] ${label} ✗ ${path}?${qs(params)} status=${status} biz=${bizCode} code=${code} ${err?.message ?? ''}`,
          );

          if (tooMany) this.penalize();

          if (retriable && errLeft > 0) {
            const backoff =
              BASE_BACKOFF_MS * Math.pow(2, ERROR_RETRY - errLeft) + jitter();
            errLeft--;
            await sleep(backoff);
            continue attempt;
          }
          break attempt;
        }
        // eslint-disable-next-line no-constant-condition
      } while (true);
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
