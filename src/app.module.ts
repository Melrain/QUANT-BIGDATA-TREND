import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './infra/infra.module';
import { CollectorModule } from './collector/collector.module';
import { ScheduleModule } from '@nestjs/schedule';
import { OkxTradeService } from './okx-trade/okx-trade.service';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot({
      // Schedule options
    }),
    InfraModule,
    CollectorModule,
  ],
  controllers: [AppController],
  providers: [AppService, OkxTradeService],
})
export class AppModule {}
