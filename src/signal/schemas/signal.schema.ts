import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

const SIGNAL_TTL_DAYS = Number(process.env.SIGNAL_TTL_DAYS ?? 14);
const SIGNAL_TTL_SECONDS = Math.max(
  1,
  Math.floor(SIGNAL_TTL_DAYS * 24 * 60 * 60),
);

@Schema({ versionKey: false })
export class Signal {
  @Prop({ type: String, required: true })
  _id!: string; // `${sym}|${ts}`

  @Prop({ type: String, index: true })
  sym!: string;

  @Prop({ type: Number, index: true })
  ts!: number; // 对齐 5m

  @Prop({ type: String }) side!: 'LONG' | 'SHORT' | 'FLAT';

  @Prop({ type: Number }) score?: number;
  @Prop({ type: Number }) taker_imb?: number;
  @Prop({ type: Number }) oi_chg?: number;

  @Prop({ type: Object, default: {} })
  meta?: Record<string, any>;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export type SignalDocument = HydratedDocument<Signal>;
export const SignalSchema = SchemaFactory.createForClass(Signal);
SignalSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: SIGNAL_TTL_SECONDS },
);
SignalSchema.index({ sym: 1, ts: -1 });
