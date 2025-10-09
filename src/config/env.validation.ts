import { z } from 'zod';

/** 定义所有环境变量的 Zod Schema */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  ENABLE_COLLECTOR: z.string().default('true'),
  ENABLE_FEATURES: z.string().default('true'),
  ENABLE_MODEL: z.string().default('true'),
  ENABLE_SIGNAL: z.string().default('false'),

  ASSETS: z.string().default('BTC,ETH'),

  BAR_GRANULARITY_MIN: z.coerce.number().int().positive().default(5),
  FETCH_LOOKBACK_MIN: z.coerce.number().int().positive().default(30),

  CRON_COLLECT: z.string().default('*/1 * * * *'),
  CRON_FEATURES: z.string().default('*/1 * * * *'),
  CRON_MODEL: z.string().default('*/1 * * * *'),
  CRON_SIGNAL: z.string().default('*/1 * * * *'),

  OKX_BASE: z.string().url().default('https://www.okx.com'),
  OKX_TIMEOUT_MS: z.coerce.number().positive().default(5000),
  OKX_RETRY: z.coerce.number().int().min(0).max(5).default(3),
  OKX_RETRY_BACKOFF_MS: z.coerce.number().positive().default(500),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
  REDIS_TTL_DAYS: z.coerce.number().positive().default(14),
  REDIS_NAMESPACE: z.string().default('quant'),

  METRICS_PORT: z.coerce.number().int().positive().default(9100),
  METRICS_PREFIX: z.string().default('quant_'),
});

/** 校验函数，供 ConfigModule.forRoot 调用 */
export function validateEnv(config: Record<string, any>) {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:\n', parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}
