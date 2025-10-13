/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable no-console */
import axios from 'axios';

const BASES = [
  'https://www.okx.com',
  'https://aws.okx.com',
  'https://okxaws.okx.com',
];

const ENDPOINTS = [
  { name: 'public/time', path: '/api/v5/public/time', params: {} },

  {
    name: 'taker-volume (spot)',
    path: '/api/v5/rubik/stat/taker-volume',
    params: { ccy: 'BTC', period: '5m' },
  },

  {
    name: 'taker-volume-contract',
    path: '/api/v5/rubik/stat/taker-volume-contract',
    params: { instId: 'BTC-USDT-SWAP', ccy: 'BTC', period: '5m' },
  },

  {
    name: 'open-interest-volume',
    path: '/api/v5/rubik/stat/open-interest-volume',
    params: { ccy: 'BTC', period: '5m' },
  },

  {
    name: 'open-interest-volume-contract',
    path: '/api/v5/rubik/stat/contracts/open-interest-volume',
    params: { instId: 'BTC-USDT-SWAP', ccy: 'BTC', period: '5m' },
  },

  {
    name: 'long-short-account-ratio',
    path: '/api/v5/rubik/stat/long-short-account-ratio',
    params: { ccy: 'BTC', period: '5m' },
  },

  {
    name: 'long-short-account-ratio-contract',
    path: '/api/v5/rubik/stat/contracts/long-short-account-ratio',
    params: { instId: 'BTC-USDT-SWAP', ccy: 'BTC', period: '5m' },
  },

  {
    name: 'long-short-ratio (elite)',
    path: '/api/v5/rubik/stat/long-short-ratio',
    params: { ccy: 'BTC', period: '5m' },
  },

  {
    name: 'long-short-ratio-contract (elite)',
    path: '/api/v5/rubik/stat/contracts/long-short-ratio',
    params: { instId: 'BTC-USDT-SWAP', ccy: 'BTC', period: '5m' },
  },
];

async function testEndpoint(base: string, ep: (typeof ENDPOINTS)[number]) {
  const url = `${base}${ep.path}`;
  const t0 = Date.now();
  try {
    const res = await axios.get(url, {
      params: ep.params,
      timeout: ep.name === 'public/time' ? 5000 : 12000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'okx-endpoint-tester/1.0',
        Accept: 'application/json',
      },
    });
    const ms = Date.now() - t0;
    const msg = res.data?.msg || '';
    const code = res.data?.code || res.status;
    console.log(
      `✅ [${base.replace('https://', '')}] ${ep.name.padEnd(34)} → ${code} (${ms}ms) ${msg}`,
    );
  } catch (err: any) {
    const ms = Date.now() - t0;
    console.log(
      `❌ [${base.replace('https://', '')}] ${ep.name.padEnd(34)} → ${err.code ?? 'ERR'} (${ms}ms)`,
    );
  }
}

(async () => {
  for (const base of BASES) {
    console.log(`\n🌐 Testing base: ${base}`);
    for (const ep of ENDPOINTS) {
      await testEndpoint(base, ep);
    }
  }
})();
