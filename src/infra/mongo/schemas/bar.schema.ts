import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

const TTL_DAYS = Number(process.env.BAR_TTL_DAYS ?? 14);
const TTL_SECONDS = Math.max(1, Math.floor(TTL_DAYS * 24 * 60 * 60));

@Schema({ versionKey: false })
export class Bar {
  // 注意：这里不“重写”Document 的 _id，而是定义字段并由 SchemaFactory 处理
  @Prop({ type: String, required: true })
  _id!: string; // `${sym}|${metric}|${ts}`

  @Prop({ type: String, index: true, required: true })
  sym!: string; // 'BTC-USDT-SWAP'

  @Prop({ type: String, index: true, required: true })
  metric!: string; // 'open_interest' / 'taker_vol_buy' ...

  @Prop({ type: Number, index: true, required: true })
  ts!: number; // ms

  @Prop({ type: Number, required: true })
  val!: number;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Date, default: () => new Date() })
  updatedAt!: Date;
}

export type BarDocument = HydratedDocument<Bar>;
export const BarSchema = SchemaFactory.createForClass(Bar);

// 索引
BarSchema.index({ sym: 1, metric: 1, ts: 1 });

// TTL（按 createdAt）
BarSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
