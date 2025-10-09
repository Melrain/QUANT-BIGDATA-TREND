export default () => ({
  app: {
    env: process.env.NODE_ENV,
    enableCollector: process.env.ENABLE_COLLECTOR === 'true',
    enableFeatures: process.env.ENABLE_FEATURES === 'true',
    enableModel: process.env.ENABLE_MODEL === 'true',
    enableSignal: process.env.ENABLE_SIGNAL === 'true',

    assets: (process.env.ASSETS ?? 'BTC,ETH')
      .split(',')
      .map((s) => s.trim().toUpperCase()),

    barGranularityMin: Number(process.env.BAR_GRANULARITY_MIN ?? 5),
    fetchLookbackMin: Number(process.env.FETCH_LOOKBACK_MIN ?? 30),

    cronCollect: process.env.CRON_COLLECT ?? '*/1 * * * *',
    cronFeatures: process.env.CRON_FEATURES ?? '*/1 * * * *',
    cronModel: process.env.CRON_MODEL ?? '*/1 * * * *',
    cronSignal: process.env.CRON_SIGNAL ?? '*/1 * * * *',
  },
});
