import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ versionKey: false, timestamps: true })
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
}

export type SignalEvalDocument = HydratedDocument<SignalEval>;
export const SignalEvalSchema = SchemaFactory.createForClass(SignalEval);
SignalEvalSchema.index({ sym: 1, ts: -1 });
