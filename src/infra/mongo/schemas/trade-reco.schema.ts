// src/infra/mongo/schemas/trade-reco.schema.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeAction =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'REVERSE_LONG'
  | 'REVERSE_SHORT'
  | 'CLOSE'
  | 'ADD_LONG'
  | 'ADD_SHORT';

export type TradeSide = 'BUY' | 'SELL';

@Schema({ timestamps: true })
export class TradeReco {
  // 你目前使用 `${sym}|${ts}` 自定义 _id，如已改为 ObjectId，也兼容
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: String, index: true, required: true })
  sym!: string; // e.g. 'BTC-USDT-SWAP'

  @Prop({ type: Number, index: true, required: true })
  ts!: number; // 对齐到 5m 档的时间戳

  @Prop({
    type: String,
    required: true,
    enum: [
      'OPEN_LONG',
      'OPEN_SHORT',
      'REVERSE_LONG',
      'REVERSE_SHORT',
      'CLOSE',
      'ADD_LONG',
      'ADD_SHORT',
    ],
  })
  action!: TradeAction;

  @Prop({ type: String, required: true, enum: ['BUY', 'SELL'] })
  side!: TradeSide;

  @Prop({ type: Number, required: true })
  score!: number;

  @Prop({ type: Number, required: true })
  notionalUSDT!: number;

  @Prop({ type: Boolean, default: false })
  degraded!: boolean;

  // 存储一些解释/调试用信息（保持宽松类型以避免频繁改动）
  @Prop({ type: Object })
  reasons?: Record<string, any>;

  // 风控参数（供下游参考）
  @Prop({ type: Object })
  risk?: {
    stopPct?: number;
    minHoldMinutes?: number;
    cooldownMinutes?: number;
  };
}

export type TradeRecoDocument = HydratedDocument<TradeReco>;
export const TradeRecoSchema = SchemaFactory.createForClass(TradeReco);

// 索引（按需保留）
TradeRecoSchema.index({ sym: 1, ts: -1 });
