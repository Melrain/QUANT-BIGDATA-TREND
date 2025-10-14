// src/infra/mongo/schemas/signal.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'signals' })
export class Signal {
  @Prop({ type: String, required: true }) _id!: string; // `${sym}|${ts}`
  @Prop({ type: String, index: true, required: true }) sym!: string;
  @Prop({ type: Number, index: true, required: true }) ts!: number;

  // 你现有字段里常见的
  @Prop({ type: Number }) score?: number; // -1 ~ +1
  @Prop({ type: String }) side?: 'LONG' | 'SHORT' | 'FLAT';
  @Prop({ type: Number }) taker_imb?: number; // 可选
  @Prop({ type: Number }) oi_chg?: number; // 可选
  @Prop({ type: Object }) meta?: any; // { th_up, th_dn, raw: {...} }

  @Prop({ type: Date, default: () => new Date() }) createdAt!: Date;
}
export type SignalDocument = HydratedDocument<Signal>;
export const SignalSchema = SchemaFactory.createForClass(Signal);
SignalSchema.index({ sym: 1, ts: -1 });
