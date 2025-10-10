import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'status', versionKey: false })
export class Status extends Document {
  @Prop({ required: true }) metric: string;
  @Prop({ required: true }) sym: string;
  @Prop({ required: true }) lastTs: Date;
  @Prop() lagSec?: number;
  @Prop({ default: () => new Date() }) updatedAt?: Date;
}

export const StatusSchema = SchemaFactory.createForClass(Status);
StatusSchema.index({ metric: 1, sym: 1 }, { unique: true });
