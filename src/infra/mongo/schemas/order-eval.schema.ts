import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EvalAction = 'BUY' | 'SELL';
export type EvalDir = 'LONG' | 'SHORT' | 'NONE';

@Schema({ versionKey: false, timestamps: true })
export class OrderEval {
  /** 唯一键：`${sym}|${ts}|${action}|mid` */
  @Prop({ type: String, required: true })
  _id!: string;

  /** 标的，例如 'BTC-USDT-SWAP' */
  @Prop({ type: String, index: true, required: true })
  sym!: string;

  /** 对应 order_suggested.ts 的时间戳（5m 档） */
  @Prop({ type: Number, index: true, required: true })
  ts!: number;

  /** 对应 reco.action：BUY / SELL */
  @Prop({ type: String, required: true, enum: ['BUY', 'SELL'] })
  action!: EvalAction;

  /** 方向：LONG / SHORT / NONE（BUY→LONG, SELL→SHORT, HOLD→NONE） */
  @Prop({ type: String, required: true, enum: ['LONG', 'SHORT', 'NONE'] })
  dir!: EvalDir;

  /** 价格指标（通常为 'mid'） */
  @Prop({ type: String, required: true })
  metric!: string;

  /** 入场价格（refPrice） */
  @Prop({ type: Number })
  entryPx?: number;

  /** 未来 1 / 3 / 6 根的 mid 价格 */
  @Prop({ type: Number })
  px_1b?: number;
  @Prop({ type: Number })
  px_3b?: number;
  @Prop({ type: Number })
  px_6b?: number;

  /** 收益（方向已处理）单位：% */
  @Prop({ type: Number })
  ret_1b?: number;
  @Prop({ type: Number })
  ret_3b?: number;
  @Prop({ type: Number })
  ret_6b?: number;

  /** 区间最大顺势/逆势收益（以 % 表示） */
  @Prop({ type: Number })
  mfe_6b?: number;
  @Prop({ type: Number })
  mae_6b?: number;

  /** 实际完成的 bar 数（1/3/6） */
  @Prop({ type: Number })
  complete_n?: number;

  /** 信号到评估的延迟（ms） */
  @Prop({ type: Number })
  latencyMs?: number;

  /** 创建/更新时间 */
  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;
  @Prop({ type: Date, default: () => new Date() })
  updatedAt!: Date;
}

export type OrderEvalDocument = HydratedDocument<OrderEval>;
export const OrderEvalSchema = SchemaFactory.createForClass(OrderEval);

/** 索引优化查询 */
OrderEvalSchema.index({ sym: 1, ts: 1 });
OrderEvalSchema.index({ ts: -1 });
OrderEvalSchema.index({ action: 1 });
