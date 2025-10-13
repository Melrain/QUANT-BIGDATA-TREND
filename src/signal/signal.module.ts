import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MongooseModule } from '@nestjs/mongoose';

import { Signal, SignalSchema } from './schemas/signal.schema';

import { MongoModule } from '@/infra/mongo/mongo.module';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';
import { Feature, FeatureSchema } from '@/infra/mongo/schemas/feature.schema';
import { SignalsScheduler } from './signal.scheduler';
import { SignalsService } from './signal.service';

// 如果你要接 OkxTradeService，解开下面这行并在 providers 里加入
// import { OkxTradeService } from '@/trade/okx-trade.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongoModule,
    MongooseModule.forFeature([
      { name: Signal.name, schema: SignalSchema },
      { name: Feature.name, schema: FeatureSchema },
    ]),
  ],
  providers: [
    SignalsService,
    SignalsScheduler,
    SymbolRegistry,
    // OkxTradeService,
  ],
  exports: [SignalsService],
})
export class SignalsModule {}
