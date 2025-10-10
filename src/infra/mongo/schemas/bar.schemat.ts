import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ collection: 'bars', versionKey: false })
export class Bar extends Document {
  @Prop({ required: true }) declare _id: string; // `${metric}:${sym}:${ts}`
  @Prop({ required: true }) ts: Date;
  @Prop({ required: true }) sym: string;
  @Prop({ required: true }) metric: string;
  @Prop({ required: true }) val: number;
  @Prop({ type: MongooseSchema.Types.Mixed }) // 关键：显式声明类型
  raw?: Record<string, any>;
}

export const BarSchema = SchemaFactory.createForClass(Bar);
BarSchema.index({ sym: 1, metric: 1, ts: 1 }, { expireAfterSeconds: 1209600 });
BarSchema.index({ ts: 1 }); // 方便 time-range 查询
