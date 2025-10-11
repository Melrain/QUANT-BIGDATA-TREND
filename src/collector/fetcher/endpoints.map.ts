/**
 * OKX Rubik BigData endpoints (with fallback)
 * 约定：
 * - 合约口径（包含 "/contracts/" 或 "-contract"）→ 同时传 { instId, ccy, period }
 * - 普通口径 → 传 { ccy, period }
 */
export const OKX_BIGDATA_ENDPOINTS = {
  // 1) TAKer Volume
  takerVolume: {
    paths: [
      '/api/v5/rubik/stat/taker-volume-contract', // 合约：官方文档要求 instId（我们同时带 ccy）
      '/api/v5/rubik/stat/contracts/taker-volume', // 合约（部分环境）
      '/api/v5/rubik/stat/taker-volume', // 普通口径（fallback）
    ] as const,
    buildParams: (sym: string, path: string) => {
      const [ccy] = sym.split('-'); // 'BTC-USDT-SWAP' -> 'BTC'
      const isContract =
        /\/contracts?\//.test(path) || path.includes('-contract');
      return isContract
        ? { instId: sym, ccy, period: '5m' } // 关键：两者同传，避免 400: ccy empty
        : { ccy, period: '5m' };
    },
    metrics: ['taker_vol_buy', 'taker_vol_sell'],
  },

  // 2) Open Interest & Contracts Volume
  openInterestVolume: {
    paths: [
      '/api/v5/rubik/stat/contracts/open-interest-volume', // 合约优先
      '/api/v5/rubik/stat/open-interest-volume', // 普通 fallback
    ] as const,
    buildParams: (sym: string, path: string) => {
      const [ccy] = sym.split('-');
      const isContract =
        /\/contracts?\//.test(path) || path.includes('-contract');
      return isContract
        ? { instId: sym, ccy, period: '5m' }
        : { ccy, period: '5m' };
    },
    metrics: ['open_interest', 'contracts_volume'],
  },

  // 3) Long/Short Account Ratio (All Users)
  longShortAll: {
    paths: [
      '/api/v5/rubik/stat/contracts/long-short-account-ratio', // 合约
      '/api/v5/rubik/stat/long-short-account-ratio', // 普通
    ] as const,
    buildParams: (sym: string, path: string) => {
      const [ccy] = sym.split('-');
      const isContract =
        /\/contracts?\//.test(path) || path.includes('-contract');
      return isContract
        ? { instId: sym, ccy, period: '5m' }
        : { ccy, period: '5m' };
    },
    metrics: ['longshort_all_acc', 'longshort_all_pos'],
  },

  // 4) Long/Short Ratio (Elite / Top Traders)
  longShortElite: {
    paths: [
      '/api/v5/rubik/stat/contracts/long-short-ratio', // 合约
      '/api/v5/rubik/stat/long-short-ratio', // 普通
    ] as const,
    buildParams: (sym: string, path: string) => {
      const [ccy] = sym.split('-');
      const isContract =
        /\/contracts?\//.test(path) || path.includes('-contract');
      return isContract
        ? { instId: sym, ccy, period: '5m' }
        : { ccy, period: '5m' };
    },
    metrics: ['longshort_elite_acc', 'longshort_elite_pos'],
  },
} as const;
