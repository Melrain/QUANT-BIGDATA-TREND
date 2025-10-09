export const OKX_BIGDATA_ENDPOINTS = {
  takerVolume: {
    path: '/api/v5/rubik/stat/contracts/taker-volume',
    params: (ccy: string) => ({
      ccy,
      instType: 'CONTRACTS',
      period: '5m',
    }),
    metrics: ['taker_vol_buy', 'taker_vol_sell'],
  },
};
