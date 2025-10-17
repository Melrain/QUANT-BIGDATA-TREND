// src/strategies/strategies.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { Signal, SignalSchema } from '@/infra/mongo/schemas/signal.schema';
import {
  TradeReco,
  TradeRecoSchema,
} from '@/infra/mongo/schemas/trade-reco.schema';

import { TradeRecoService } from './trade-reco.service';

import { CollectorModule } from '@/collector/collector.module';
import { TradeRecoListener } from './trade-reco.listener';

@Module({
  imports: [
    CollectorModule,
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: Signal.name, schema: SignalSchema },
      { name: TradeReco.name, schema: TradeRecoSchema },
    ]),
  ],
  providers: [TradeRecoService, TradeRecoListener],
  exports: [TradeRecoService],
})
export class StrategiesModule {}
