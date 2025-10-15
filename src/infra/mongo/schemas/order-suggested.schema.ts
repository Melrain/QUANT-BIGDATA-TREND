// src/infra/mongo/schemas/order-suggested.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ collection: 'orders_suggested', timestamps: true })
export class OrderSuggested {
  @Prop({ type: String, required: true }) _id!: string; // `${sym}|${ts}`
  @Prop({ type: String, index: true, required: true }) sym!: string; // BTC-USDT-SWAP
  @Prop({ type: Number, index: true, required: true }) ts!: number; // 5m bar ts

  // —— 策略/决策来源（可追溯）
  @Prop({ type: SchemaTypes.Mixed }) signal?: any;
  @Prop({ type: SchemaTypes.Mixed }) decision?: any; // trade_reco 文档或摘要
  @Prop({ type: String }) recoId?: string; // 关联 trade_recos _id

  // —— 可直接下单的参数（OKX /trade/order body）
  @Prop({ type: String, required: true }) instId!: string;
  @Prop({ type: String, required: true }) tdMode!: 'cross' | 'isolated';
  @Prop({ type: String, required: true }) ordType!:
    | 'market'
    | 'limit'
    | 'post_only'
    | 'fok'
    | 'ioc';
  @Prop({ type: String, required: true }) side!: 'buy' | 'sell';
  @Prop({ type: String }) posSide?: 'long' | 'short';
  @Prop({ type: String, required: true }) sizeSz!: string; // 已对齐到 lotSz/minSz
  @Prop({ type: String }) limitPx?: string; // 若是限价/被动
  @Prop({ type: Boolean, default: false }) reduceOnly?: boolean;
  @Prop({ type: String, required: true }) clOrdId!: string;
  @Prop({ type: Number }) leverage?: number; // 期望杠杆（执行器 ensure）

  // —— 规模推导
  @Prop({ type: Number, required: true }) notionalUSDT!: number;
  @Prop({ type: Number }) refPrice?: number; // mid/last
  @Prop({ type: SchemaTypes.Mixed }) instSpec?: any; // { ctVal, lotSz, minSz, tickSz }

  // —— 风控与护栏复核结果（执行层再次检查也无妨）
  @Prop({ type: SchemaTypes.Mixed }) risk?: {
    stopPct?: number;
    minHoldMinutes?: number;
    cooldownMinutes?: number;
  };
  @Prop({ type: SchemaTypes.Mixed }) guards?: {
    statusDegraded?: boolean;
    inCooldown?: boolean;
    holdEnough?: boolean;
    underMaxGross?: boolean;
  };

  // ✅ 新增：行情快照 + 参考价
  @Prop({ type: Object })
  price?: {
    refPrice: number; // 我们用于 sizing 的参考价（mid 或 last）
    last?: number;
    bid?: number;
    ask?: number;
    source?: string; // 'market/ticker'
    fetchedAt?: number; // ms
  };

  @Prop({ type: SchemaTypes.Mixed }) explain?: any; // 关键推导说明
}

export type OrderSuggestedDocument = HydratedDocument<OrderSuggested>;
export const OrderSuggestedSchema =
  SchemaFactory.createForClass(OrderSuggested);

// 幂等/查询索引
OrderSuggestedSchema.index({ sym: 1, ts: -1 });
OrderSuggestedSchema.index({ clOrdId: 1 }, { unique: true });
