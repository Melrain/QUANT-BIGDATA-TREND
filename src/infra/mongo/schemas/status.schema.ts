import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

const STATUS_TTL_DAYS = Number(process.env.STATUS_TTL_DAYS ?? 7);
const STATUS_TTL_SECONDS = Math.max(
  1,
  Math.floor(STATUS_TTL_DAYS * 24 * 60 * 60),
);

@Schema({ versionKey: false })
export class Status {
  @Prop({ type: String, required: true })
  _id!: string; // `${sym}|${ts}` 或 `${ts}`（看你怎么写）

  @Prop({ type: String, index: true })
  sym?: string; // 可选：针对某个合约的状态

  @Prop({ type: Number, required: true })
  ts!: number; // 本轮结束时的 server 时间戳（ms）

  @Prop({ type: Number, default: 0 })
  written!: number;

  @Prop({ type: Number, default: 0 })
  skippedDup!: number;

  @Prop({ type: Object, default: {} })
  durations?: Record<string, number>; // 各任务耗时 ms，如 { taker: 120, oi: 180, ... }

  @Prop({ type: Object, default: {} })
  errorMap?: Record<string, string>; // { 'OI/VOL': '50014', ... }

  @Prop({ type: Boolean, default: false })
  degraded?: boolean; // 本轮是否降级运行（例如大量空返回）

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
}

export type StatusDocument = HydratedDocument<Status>;
export const StatusSchema = SchemaFactory.createForClass(Status);

// TTL（按 createdAt）
StatusSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: STATUS_TTL_SECONDS },
);

// 常用查询索引
StatusSchema.index({ sym: 1, ts: 1 });
