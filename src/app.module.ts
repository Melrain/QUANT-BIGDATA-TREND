import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './infra/infra.module';
import { CollectorModule } from './collector/collector.module';
import { ScheduleModule } from '@nestjs/schedule';
import { OkxTradeService } from './okx-trade/okx-trade.service';
import { FeaturesModule } from './features/features.module';
import { SignalsModule } from './signal/signal.module';
import { OrdersModule } from './order/order.module';
import { StrategiesModule } from './strategies/strategies.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // 本地开发可读 .env；Railway 生产环境建议只用 Variables
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      // 如果你本地习惯把 .env 放在项目根目录：
      envFilePath: ['.env', '.env.local'].filter(Boolean),
      validate: validateEnv, // ← 把 zod 校验接上
    }),
    ScheduleModule.forRoot({
      // Schedule options
    }),
    InfraModule,
    CollectorModule,
    FeaturesModule,
    SignalsModule,
    OrdersModule,
    StrategiesModule,
  ],
  controllers: [AppController],
  providers: [AppService, OkxTradeService],
})
export class AppModule {}
