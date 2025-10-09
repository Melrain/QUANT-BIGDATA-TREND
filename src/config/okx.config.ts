export default () => ({
  okx: {
    baseUrl: process.env.OKX_BASE ?? 'https://www.okx.com',
    timeoutMs: Number(process.env.OKX_TIMEOUT_MS ?? 5000),
    retry: Number(process.env.OKX_RETRY ?? 3),
    retryBackoffMs: Number(process.env.OKX_RETRY_BACKOFF_MS ?? 500),
  },
});
