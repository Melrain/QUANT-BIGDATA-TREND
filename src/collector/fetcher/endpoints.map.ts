// src/collector/fetcher/endpoints.map.ts

/**
 * OKX Rubik BigData endpoints (clean, direct-connect)
 * 约定：
 *  - 合约口径：统一传 { instId: 'BTC-USDT-SWAP', ccy: 'BTC', period: '5m' }
 *  - 现货口径：统一传 { ccy: 'BTC', period: '5m' }
 *  - DEFAULT_PERIOD 可由环境变量 OKX_RUBIK_PERIOD 覆盖
 */

const DEFAULT_PERIOD = process.env.OKX_RUBIK_PERIOD ?? '5m';

type BuildParams = (sym: string, path: string) => Record<string, any>;

export const OKX_BIGDATA_ENDPOINTS = {
  /** 支持列表（可用于动态发现可拉取的币/合约） */
  supportCoins: {
    paths: ['/api/v5/rubik/stat/trading-data/support-coin'] as const,
    buildParams: (() => ({})) as BuildParams,
    metrics: [] as const, // 仅用于注册，不入 bars
  },

  /** 合约 OI 历史（可做初始化/长回测；begin/end 可按需外部补充） */
  openInterestHistory: {
    paths: ['/api/v5/rubik/stat/contracts/open-interest-history'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-'); // 'BTC-USDT-SWAP' → 'BTC'
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['oi_hist'] as const, // 你可在 parser 里拆更细
  },

  /** 现货 Taker（可选做共振/背离过滤） */
  takerVolumeSpot: {
    paths: ['/api/v5/rubik/stat/taker-volume'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['taker_vol_buy_spot', 'taker_vol_sell_spot'] as const,
  },

  /** 合约 Taker（核心） */
  takerVolumeContract: {
    paths: [
      '/api/v5/rubik/stat/taker-volume-contract', // 主口径
      '/api/v5/rubik/stat/contracts/taker-volume', // 兼容口径
    ] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['taker_vol_buy', 'taker_vol_sell'] as const,
  },

  /** 融资融券比（现货情绪，选做） */
  marginLoanRatio: {
    paths: ['/api/v5/rubik/stat/margin/loan-ratio'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['margin_loan_ratio'] as const,
  },

  /** 合约 OI 与成交量（核心） */
  openInterestVolumeContracts: {
    paths: ['/api/v5/rubik/stat/contracts/open-interest-volume'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['open_interest', 'contracts_volume'] as const,
  },

  /** 全体用户 多空账户比（合约口径优先） */
  longShortAllAccounts: {
    paths: [
      '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract',
      '/api/v5/rubik/stat/contracts/long-short-account-ratio',
    ] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['longshort_all_acc'] as const,
  },

  /** 精英（Top Trader）多空 —— 账户数比 */
  longShortEliteAccountTopTrader: {
    paths: [
      '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader',
    ] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['longshort_elite_acc'] as const,
  },

  /** 精英（Top Trader）多空 —— 持仓量比 */
  longShortElitePositionTopTrader: {
    paths: [
      '/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader',
    ] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { instId: sym, ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['longshort_elite_pos'] as const,
  },

  // ======== 期权分组（P2，可按需启用） ========
  optionOpenInterestVolume: {
    paths: ['/api/v5/rubik/stat/option/open-interest-volume'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['opt_oi', 'opt_vol'] as const,
  },
  optionOpenInterestVolumeRatio: {
    paths: ['/api/v5/rubik/stat/option/open-interest-volume-ratio'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['opt_oi_ratio'] as const,
  },
  optionOpenInterestVolumeExpiry: {
    paths: ['/api/v5/rubik/stat/option/open-interest-volume-expiry'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['opt_oi_expiry'] as const,
  },
  optionOpenInterestVolumeStrike: {
    paths: ['/api/v5/rubik/stat/option/open-interest-volume-strike'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['opt_oi_strike'] as const,
  },
  optionTakerBlockVolume: {
    paths: ['/api/v5/rubik/stat/option/taker-block-volume'] as const,
    buildParams: ((sym: string) => {
      const [ccy] = sym.split('-');
      return { ccy, period: DEFAULT_PERIOD };
    }) as BuildParams,
    metrics: ['opt_block_vol_buy', 'opt_block_vol_sell'] as const,
  },
} as const;
