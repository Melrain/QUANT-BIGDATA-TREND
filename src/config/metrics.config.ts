export default () => ({
  metrics: {
    port: Number(process.env.METRICS_PORT ?? 9100),
    prefix: process.env.METRICS_PREFIX ?? 'quant_',
  },
});
