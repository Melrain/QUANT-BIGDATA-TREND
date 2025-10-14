// src/infra/mongo/schemas/trade-reco.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeAction =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'REVERSE_LONG'
  | 'REVERSE_SHORT'
  | 'CLOSE'
  | 'HOLD'
  | 'SKIP';

@Schema({
  collection: 'trade_recos',
  timestamps: { createdAt: true, updatedAt: true },
})
export class TradeReco {
  @Prop({ type: String, required: true }) _id!: string; // `${sym}|${ts}`
  @Prop({ type: String, index: true, required: true }) sym!: string;
  @Prop({ type: Number, index: true, required: true }) ts!: number;

  @Prop({ type: String, enum: ['BUY', 'SELL', 'FLAT'], required: false })
  side?: 'BUY' | 'SELL' | 'FLAT'; // ← 新增字段

  @Prop({
    type: String,
    enum: [
      'OPEN_LONG',
      'OPEN_SHORT',
      'REVERSE_LONG',
      'REVERSE_SHORT',
      'CLOSE',
      'HOLD',
      'SKIP',
    ],
    required: true,
  })
  action!: TradeAction;

  @Prop({ type: Number }) score?: number; // -1 ~ +1
  @Prop({ type: Number }) notionalUSDT?: number;
  @Prop({ type: Boolean, default: false }) degraded?: boolean;

  @Prop({ type: Object }) reasons?: any; // 解释/原始指标
  @Prop({ type: Object }) risk?: {
    stopPct?: number;
    minHoldMinutes?: number;
    cooldownMinutes?: number;
  };
}

export type TradeRecoDocument = HydratedDocument<TradeReco>;
export const TradeRecoSchema = SchemaFactory.createForClass(TradeReco);

// 常用索引
TradeRecoSchema.index({ sym: 1, ts: -1 });
