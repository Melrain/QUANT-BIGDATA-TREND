export const OKX_BIGDATA_ENDPOINTS = {
  takerVolume: {
    path: '/api/v5/rubik/stat/taker-volume',
    params: (ccy: string) => ({
      ccy,
      instType: 'CONTRACTS',
      period: '5m',
    }),
    metrics: ['taker_vol_buy', 'taker_vol_sell'],
  },
  openInterestVolume: {
    path: '/api/v5/rubik/stat/open-interest-volume',
    params: (ccy: string) => ({
      ccy,
      instType: 'CONTRACTS',
      period: '5m',
    }),
    metrics: ['open_interest', 'contracts_volume'],
  },
  longShortAll: {
    path: '/api/v5/rubik/stat/contracts/long-short-account-ratio',
    params: (ccy: string) => ({
      ccy,
      instType: 'CONTRACTS',
      period: '5m',
    }),
    metrics: ['longshort_all_acc', 'longshort_all_pos'],
  },
  longShortElite: {
    path: '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader',
    params: (ccy: string) => ({
      ccy,
      instType: 'CONTRACTS',
      period: '5m',
    }),
    metrics: ['longshort_elite_acc', 'longshort_elite_pos'],
  },
};
