import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import appConfig from './app.config';
import okxConfig from './okx.config';
import redisConfig from './redis.config';
import metricsConfig from './metrics.config';
import { validateEnv } from './env.validation';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true, // 全局可注入
      load: [appConfig, okxConfig, redisConfig, metricsConfig],
      envFilePath: ['.env', '.env.local', `.env.${process.env.NODE_ENV}`],
      validate: validateEnv, // 使用 Zod 校验
      cache: true,
      expandVariables: true,
    }),
  ],
})
export class ConfigModule {}
