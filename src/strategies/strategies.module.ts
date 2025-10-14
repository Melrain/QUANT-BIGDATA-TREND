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
import { TradeRecoScheduler } from './trade-reco.scheduler';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: Signal.name, schema: SignalSchema },
      { name: TradeReco.name, schema: TradeRecoSchema },
    ]),
  ],
  providers: [TradeRecoService, TradeRecoScheduler],
  exports: [TradeRecoService],
})
export class StrategiesModule {}
