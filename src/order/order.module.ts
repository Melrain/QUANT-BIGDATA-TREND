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

@Module({
  imports: [
    CollectorModule,
    MongooseModule.forFeature([
      { name: OrderSuggested.name, schema: OrderSuggestedSchema },
      { name: TradeReco.name, schema: TradeRecoSchema },
    ]),
    OkxTradeModule,
  ],
  providers: [OrderBuilderService, OrderBuilderScheduler],
  exports: [OrderBuilderService],
})
export class OrdersModule {}
