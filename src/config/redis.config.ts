export default () => ({
  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
    ttlDays: Number(process.env.REDIS_TTL_DAYS ?? 14),
    namespace: process.env.REDIS_NAMESPACE ?? 'quant',
  },
});
