import { OrderSuggestedEvaluatorService } from './order-sugested.evaluator.service';
// src/orders/orders.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  OrderSuggested,
  OrderSuggestedSchema,
} from '@/infra/mongo/schemas/order-suggested.schema';
import {
  TradeReco,
  TradeRecoSchema,
} from '@/infra/mongo/schemas/trade-reco.schema';
import { OkxTradeModule } from '@/okx-trade/okx-trade.module';
import { OrderBuilderScheduler } from './order-builder.scheduler';
import { OrderBuilderService } from './order-builder.service';
import { CollectorModule } from '@/collector/collector.module';
import { OrderSuggestedEvaluatorScheduler } from './order-suggested.evaluator.scheduler';
import {
  OrderEval,
  OrderEvalSchema,
} from '@/infra/mongo/schemas/order-eval.schema';
import { Bar, BarSchema } from '@/infra/mongo/schemas/bar.schema';

@Module({
  imports: [
    CollectorModule,
    MongooseModule.forFeature([
      { name: OrderSuggested.name, schema: OrderSuggestedSchema },
      { name: TradeReco.name, schema: TradeRecoSchema },
      {
        name: OrderEval.name,
        schema: OrderEvalSchema,
      },
      { name: Bar.name, schema: BarSchema }, // 新增
    ]),
    OkxTradeModule,
  ],
  providers: [
    OrderBuilderService,
    OrderBuilderScheduler,
    OrderSuggestedEvaluatorScheduler,
    OrderSuggestedEvaluatorService,
  ],
  exports: [OrderBuilderService],
})
export class OrdersModule {}
