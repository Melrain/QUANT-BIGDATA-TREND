/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import * as crypto from 'crypto';

export type TdMode = 'cross' | 'isolated';
type OrdType = 'market' | 'limit' | 'post_only' | 'fok' | 'ioc';
type Side = 'buy' | 'sell';
type PosSide = 'long' | 'short';

export interface PlaceContractOrderInput {
  instId: string; // 可以是 "btc" / "BTC-USDT" / "btc-usdt-swap"
  lever?: string; // 自动设置杠杆
  tdMode?: TdMode | string;
  side: Side;
  ordType: OrdType;
  sz: string;
  px?: string;
  posSide?: PosSide;
  clOrdId?: string;
  reduceOnly?: boolean;
}

export interface CancelOrderInput {
  instId: string;
  ordId?: string;
  clOrdId?: string;
}

export interface GetOrderInput {
  instId: string;
  ordId?: string;
  clOrdId?: string;
}

export interface SetLeverageInput {
  instId?: string;
  lever: string;
  mgnMode: TdMode;
  posSide?: PosSide;
}

@Injectable()
export class OkxTradeService implements OnModuleInit {
  private readonly logger = new Logger(OkxTradeService.name);

  private readonly baseURL = process.env.OKX_BASE_URL || 'https://www.okx.com';
  private readonly apiKey = process.env.OKX_API_KEY!;
  private readonly apiSecret = process.env.OKX_API_SECRET!;
  private readonly passphrase = process.env.OKX_API_PASSPHRASE!;
  private readonly isDemo = (process.env.OKX_DEMO ?? '0') === '1';

  private readonly defaultTdMode: TdMode = (
    process.env.OKX_TDMODE || 'cross'
  ).toLowerCase() as TdMode;
  private readonly defaultPosMode = process.env.OKX_POSMODE || 'net'; // 'net' | 'long_short'
  private readonly defaultLev = process.env.OKX_DEFAULT_LEVERAGE;
  private readonly timeoutMs = Number(process.env.OKX_TIMEOUT_MS || 15000);
  private readonly retry5xxTimes = Number(process.env.RETRY_5XX_TIMES || 3);

  private http: AxiosInstance;

  private accountCfgCache?: {
    posMode: 'net_mode' | 'long_short_mode';
    ts: number;
  };
  private readonly accountCfgTtlMs = 60_000; // 60s 缓存

  constructor() {
    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
    });
  }

  onModuleInit() {
    if (this.defaultLev) {
      this.setLeverage({
        instId: 'BTC-USDT-SWAP',
        lever: String(this.defaultLev),
        mgnMode: this.defaultTdMode,
        posSide: this.defaultPosMode === 'long_short' ? 'long' : undefined,
      })
        .then(() =>
          this.logger.log(`Leverage preset OK -> ${this.defaultLev}x`),
        )
        .catch((e) =>
          this.logger.warn(
            `Leverage preset failed: ${e?.response?.data?.msg ?? e.message}`,
          ),
        );
    }
  }

  // ======== 核心：合约下单 ========
  async placeOrder(input: PlaceContractOrderInput) {
    const instId = this.normalizeInstId(input.instId);
    this.assertContractInst(instId);

    const tdMode = (input.tdMode ?? this.defaultTdMode)
      .toString()
      .toLowerCase() as TdMode;
    if (tdMode !== 'cross' && tdMode !== 'isolated') {
      throw new Error(
        `Invalid tdMode: ${input.tdMode}. Use "cross" or "isolated".`,
      );
    }
    // ============ 价格/单型逻辑自动判断 ============
    let ordType = input.ordType ?? 'limit';

    // 如果没传价格，自动改为市价单
    if (ordType === 'limit' && !input.px) {
      this.logger.warn(
        'No price (px) provided for limit order — switching to market order automatically.',
      );
      ordType = 'market';
    }

    // 对市价单强制删除 px 避免被 OKX 拒绝
    let px = input.px;
    if (ordType === 'market') px = undefined;
    // 实时获取账户实际持仓模式（带缓存）
    const actualPosMode = await this.fetchAccountPosMode();

    let posSide: PosSide | undefined;
    if (actualPosMode === 'long_short_mode') {
      // ★ 双向持仓必须带 posSide，否则 OKX 51000
      if (!input.posSide) {
        throw new Error(
          'Account is in long_short_mode, so "posSide" is required: "long" | "short".',
        );
      }
      posSide = input.posSide;
    } else {
      // net 模式禁止传 posSide，否则 OKX 51000
      if (input.posSide) {
        this.logger.warn(
          'Account is net_mode; dropping provided posSide to avoid 51000.',
        );
      }
      posSide = undefined;
    }

    // 如果传入 lever，则下单前自动设杠杆
    if (input.lever) {
      this.logger.log(
        `Setting leverage ${input.lever}x for ${instId} before order...`,
      );
      await this.setLeverage({
        instId,
        lever: String(input.lever),
        mgnMode: tdMode,
        // ★ 用实际模式，而不是 this.defaultPosMode：
        posSide:
          actualPosMode === 'long_short_mode' ? (posSide ?? 'long') : undefined,
      });
    }

    const clOrdId = this.sanitizeClOrdId(input.clOrdId);
    const body = {
      instId,
      tdMode,
      side: input.side,
      ordType,
      sz: input.sz,
      px,
      posSide,
      clOrdId,
      ...(input.reduceOnly !== undefined
        ? { reduceOnly: String(input.reduceOnly) }
        : {}),
    };

    const path = '/api/v5/trade/order';
    const headers = this.buildSignedHeaders('POST', path, body);
    return this.doPost(path, body, headers);
  }

  async cancelOrder(input: CancelOrderInput) {
    const instId = this.normalizeInstId(input.instId);
    this.assertContractInst(instId);
    const path = '/api/v5/trade/cancel-order';
    const body = { instId, ordId: input.ordId, clOrdId: input.clOrdId };
    const headers = this.buildSignedHeaders('POST', path, body);
    return this.doPost(path, body, headers);
  }

  async getOrder(input: GetOrderInput) {
    const instId = this.normalizeInstId(input.instId);
    this.assertContractInst(instId);
    const qs = this.buildQuery({
      instId,
      ordId: input.ordId,
      clOrdId: input.clOrdId,
    });
    const pathWithQs = `/api/v5/trade/order${qs}`;
    const headers = this.buildSignedHeaders('GET', pathWithQs);
    return this.doGet(pathWithQs, headers);
  }

  async setLeverage(input: SetLeverageInput) {
    const instId = input.instId
      ? this.normalizeInstId(input.instId)
      : undefined;

    // ★ 先拼最终 body
    const body = { ...input, instId };

    const path = '/api/v5/account/set-leverage';
    // ★ 用最终 body 生成签名
    const headers = this.buildSignedHeaders('POST', path, body);

    // ★ 发送的也是同一个 body
    return this.doPost(path, body, headers);
  }

  async setPositionMode(posMode: 'net_mode' | 'long_short_mode') {
    const path = '/api/v5/account/set-position-mode';
    const headers = this.buildSignedHeaders('POST', path, { posMode });
    return this.doPost(path, { posMode }, headers);
  }

  // ===== 内部工具 =====
  private normalizeInstId(raw: string): string {
    if (!raw) throw new Error('instId is required');
    let inst = raw.trim().toUpperCase();
    // 自动补全
    if (!inst.includes('-')) inst = `${inst}-USDT-SWAP`;
    else if (!inst.endsWith('-SWAP') && !inst.endsWith('-FUTURES'))
      inst = `${inst}-SWAP`;
    this.logger.verbose(`[Normalize instId] ${raw} -> ${inst}`);
    return inst;
  }

  private assertContractInst(instId: string) {
    if (!/-SWAP$/.test(instId) && !/-FUTURES$/.test(instId)) {
      throw new Error(`instId must end with -SWAP or -FUTURES: ${instId}`);
    }
  }

  private buildSignedHeaders(
    method: 'GET' | 'POST' | 'DELETE',
    requestPath: string,
    bodyObj?: unknown,
  ) {
    const timestamp = new Date().toISOString();
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const prehash = `${timestamp}${method}${requestPath}${body}`;
    const sign = crypto
      .createHmac('sha256', this.apiSecret)
      .update(prehash)
      .digest('base64');
    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
    };
    if (this.isDemo) headers['x-simulated-trading'] = '1';
    return headers;
  }

  private buildQuery(obj: Record<string, any>) {
    const entries = Object.entries(obj).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    );
    if (entries.length === 0) return '';
    return (
      '?' +
      entries
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join('&')
    );
  }

  private async doPost<T = any>(
    path: string,
    body: any,
    headers: Record<string, string>,
  ) {
    for (let attempt = 1; attempt <= this.retry5xxTimes; attempt++) {
      try {
        this.logger.verbose(`[REQ] POST ${path}`);
        const { data, status } = await this.http.post<T>(path, body, {
          headers,
        });
        const res: any = data;
        if (res?.code && res.code !== '0') {
          this.logger.error(
            `[POST FAIL] ${path} code=${res.code} msg=${res.msg}`,
          );
          if (res?.data)
            this.logger.debug(`[SERVER DATA] ${JSON.stringify(res.data)}`);
          throw new Error(`OKX ${res.code}: ${res.msg}`);
        }
        if (status !== 200) this.logger.warn(`[POST] non-200 status=${status}`);
        this.logger.log(`[POST OK] ${path}`);
        return data;
      } catch (err: any) {
        const retriable =
          [500, 502, 503].includes(err?.response?.status) ||
          ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_BAD_RESPONSE'].includes(
            err?.code,
          );
        this.logger.error(
          `[POST ERROR] ${path} attempt=${attempt}/${this.retry5xxTimes} err=${err.message}`,
        );
        if (retriable && attempt < this.retry5xxTimes) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        throw err;
      }
    }
  }

  private async doGet<T = any>(path: string, headers: Record<string, string>) {
    const { data } = await this.http.get<T>(path, { headers });
    return data;
  }

  private async fetchAccountPosMode(): Promise<'net_mode' | 'long_short_mode'> {
    const now = Date.now();
    if (
      this.accountCfgCache &&
      now - this.accountCfgCache.ts < this.accountCfgTtlMs
    ) {
      return this.accountCfgCache.posMode;
    }
    const path = '/api/v5/account/config';
    const headers = this.buildSignedHeaders('GET', path);
    const { data } = await this.http.get(path, { headers });
    // 期望结构: { code:'0', data: [ { posMode: 'net_mode' | 'long_short_mode', ... } ] }
    const res: any = data;
    if (res?.code !== '0') {
      this.logger.warn(
        `[GET account/config FAIL] code=${res?.code} msg=${res?.msg}`,
      );
      // 回退：按环境变量
      return this.defaultPosMode === 'long_short'
        ? 'long_short_mode'
        : 'net_mode';
    }
    const posMode =
      res?.data?.[0]?.posMode ??
      (this.defaultPosMode === 'long_short' ? 'long_short_mode' : 'net_mode');
    this.accountCfgCache = { posMode, ts: now };
    this.logger.verbose(`[Account posMode] ${posMode}`);
    return posMode;
  }

  /** 获取账户净值（USDT），用于资金预算 */
  async getEquityUSDT(): Promise<number> {
    const path = '/api/v5/account/balance';
    const headers = this.buildSignedHeaders('GET', path);
    const { data } = await this.http.get(path, { headers });
    const res: any = data;
    if (res?.code !== '0') throw new Error(`OKX ${res.code}: ${res.msg}`);
    // 取 USDT 的 eq；若使用统一折算，可改用总权益 uTimeVal
    const details = res?.data?.[0]?.details || [];
    const usdt = details.find((d: any) => d.ccy === 'USDT');
    return Number(usdt?.eq ?? 0);
  }

  /** 返回账户真实配置（含 posMode）——PositionManager 会依赖它 */
  async getAccountConfig(): Promise<{
    posMode: 'net_mode' | 'long_short_mode';
  }> {
    const path = '/api/v5/account/config';
    const headers = this.buildSignedHeaders('GET', path);
    const { data } = await this.http.get(path, { headers });
    const res: any = data;
    if (res?.code !== '0') throw new Error(`OKX ${res.code}: ${res.msg}`);
    return { posMode: res?.data?.[0]?.posMode ?? 'net_mode' };
  }

  /** 统计已用名义敞口（USD/USDT），供总风险预算使用 */
  async getUsedGrossExposure(): Promise<number> {
    const path = '/api/v5/account/positions';
    const headers = this.buildSignedHeaders('GET', path);
    const { data } = await this.http.get(path, { headers });
    const res: any = data;
    if (res?.code !== '0') throw new Error(`OKX ${res.code}: ${res.msg}`);
    const arr = res?.data || [];
    return arr.reduce(
      (sum: number, p: any) => sum + Math.abs(Number(p?.notionalUsd ?? 0)),
      0,
    );
  }

  /** 取参考价（last 或 mid）；PositionManager/执行器用来估算市价单张数 */
  async getRefPrice(instIdRaw: string): Promise<number | null> {
    const instId = this.normalizeInstId(instIdRaw);
    const path = '/api/v5/market/ticker';
    const qs = `?instId=${encodeURIComponent(instId)}`;
    const headers = this.buildSignedHeaders('GET', path + qs);
    const { data } = await this.http.get(path + qs, { headers });
    const res: any = data;
    if (res?.code !== '0') return null;
    const row = res?.data?.[0];
    const bid = Number(row?.bidPx),
      ask = Number(row?.askPx),
      last = Number(row?.last);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0)
      return (bid + ask) / 2;
    if (Number.isFinite(last) && last > 0) return last;
    return null;
  }

  private instSpecCache = new Map<
    string,
    { ctVal: number; lotSz: number; tickSz: number; minSz: number; ts: number }
  >();
  private readonly instSpecTtlMs = 10 * 60 * 1000;

  /** 获取并缓存合约规格，用于数量/价格对齐 */
  async getInstrumentSpec(instIdRaw: string) {
    const instId = this.normalizeInstId(instIdRaw);
    const now = Date.now();
    const hit = this.instSpecCache.get(instId);
    if (hit && now - hit.ts < this.instSpecTtlMs) return hit;

    const path = '/api/v5/public/instruments';
    const qs = '?instType=SWAP&instId=' + encodeURIComponent(instId);
    const { data } = await this.http.get(path + qs);
    const res: any = data;
    const row = res?.data?.[0];
    if (!row) throw new Error(`instrument not found: ${instId}`);

    const spec = {
      ctVal: Number(row.ctVal ?? row.ctMult ?? 1),
      lotSz: Number(row.lotSz ?? 1),
      tickSz: Number(row.tickSz ?? 0.1),
      minSz: Number(row.minSz ?? row.lotSz ?? 1),
      ts: now,
    };
    this.instSpecCache.set(instId, spec);
    return spec;
  }

  /** 把名义(USDT)按参考价换算成 sz，并对齐 lotSz/minSz。返回字符串以便直接下单 */
  async notionalToSize(
    instIdRaw: string,
    notionalUSDT: number,
    pxRef?: number,
  ): Promise<string> {
    const instId = this.normalizeInstId(instIdRaw);
    const spec = await this.getInstrumentSpec(instId);
    const px = Number(pxRef) || (await this.getRefPrice(instId)) || 0;
    if (!(Number.isFinite(px) && px > 0))
      throw new Error(`no ref price for ${instId}`);

    // 合约张数估算：名义 / (价格 * ctVal)；然后对齐 lotSz，至少 minSz
    let sz = notionalUSDT / (px * spec.ctVal);
    // 对齐到 lotSz 的向下取整
    sz = Math.floor(sz / spec.lotSz) * spec.lotSz;
    if (sz < spec.minSz) sz = spec.minSz;

    // 去除多余小数位（OKX 接受字符串）
    return String(Number(sz.toFixed(12)));
  }

  /** 价格对齐到 tickSz（限价单用） */
  alignPrice(px: number, tickSz: number): number {
    if (!Number.isFinite(px) || !Number.isFinite(tickSz) || tickSz <= 0)
      return px;
    const k = Math.round(px / tickSz);
    return Number((k * tickSz).toFixed(12));
  }

  private levCache = new Map<string, { key: string; ts: number }>(); // key = `${mgnMode}:${lever}:${posSide??''}`

  /** 幂等设置杠杆（减少重复调用 / 429） */
  async ensureLeverage(
    instId: string,
    mgnMode: TdMode,
    lever: string,
    posMode: 'net_mode' | 'long_short_mode',
    posSide?: PosSide,
  ) {
    const cacheKey = `${instId}|${mgnMode}|${lever}|${posMode === 'long_short_mode' ? (posSide ?? 'long') : ''}`;
    const hit = this.levCache.get(instId);
    if (hit?.key === cacheKey && Date.now() - hit.ts < 10 * 60 * 1000) return; // 10 分钟内认为已设置
    await this.setLeverage({
      instId,
      lever,
      mgnMode,
      posSide: posMode === 'long_short_mode' ? (posSide ?? 'long') : undefined,
    });
    this.levCache.set(instId, { key: cacheKey, ts: Date.now() });
  }

  private sanitizeClOrdId(id?: string): string | undefined {
    if (!id) return undefined;
    // 仅保留字母数字
    const clean = id.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    return clean || undefined;
  }
}
