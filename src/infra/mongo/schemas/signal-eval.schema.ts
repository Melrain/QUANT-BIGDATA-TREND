import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ versionKey: false })
export class SignalEval {
  @Prop({ type: String, required: true })
  _id!: string; // `${sym}|${ts}` 或 `${sym}|${ts}|last`

  @Prop({ type: String, index: true, required: true })
  sym!: string;

  @Prop({ type: Number, index: true, required: true })
  ts!: number;

  @Prop({ type: String, required: true })
  metric!: string; // "last", "close"...

  @Prop({ type: String })
  side!: 'LONG' | 'SHORT' | 'FLAT';

  // horizon 回测结果
  @Prop({ type: Object })
  returns!: Record<string, number>; // { "ret_1b": 0.0012, "ret_3b": -0.0021 }

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export type SignalEvalDocument = HydratedDocument<SignalEval>;
export const SignalEvalSchema = SchemaFactory.createForClass(SignalEval);
SignalEvalSchema.index({ sym: 1, ts: -1 });
