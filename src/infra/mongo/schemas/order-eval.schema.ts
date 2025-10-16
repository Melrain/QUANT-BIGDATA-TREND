// src/infra/mongo/schemas/order-eval.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ versionKey: false })
export class OrderEval {
  @Prop({ type: String, required: true }) _id!: string; // `${sym}|${ts}|${action}|mid`
  @Prop({ type: String, index: true, required: true }) sym!: string;
  @Prop({ type: Number, index: true, required: true }) ts!: number; // 对应 order_suggested.ts
  @Prop({ type: String, required: true }) action!:
    | 'OPEN_LONG'
    | 'OPEN_SHORT'
    | 'REVERSE_LONG'
    | 'REVERSE_SHORT'
    | 'CLOSE';
  @Prop({ type: String, required: true }) metric!: string; // 'mid'
  @Prop({ type: String, required: true }) dir!: 'LONG' | 'SHORT' | 'CLOSE';

  // 入场参考
  @Prop({ type: Number }) entryPx?: number; // order_suggested.price.refPrice

  // 未来价格快照（bar 后的 mid）
  @Prop({ type: Number }) px_1b?: number;
  @Prop({ type: Number }) px_3b?: number;
  @Prop({ type: Number }) px_6b?: number;

  // 收益（方向已处理：多为正向 px_t+k - entry，空为 entry - px_t+k）
  @Prop({ type: Number }) ret_1b?: number;
  @Prop({ type: Number }) ret_3b?: number;
  @Prop({ type: Number }) ret_6b?: number;

  // 区间内最优/最差（以 bar 为单位）
  @Prop({ type: Number }) mfe_6b?: number; // 最大顺势收益
  @Prop({ type: Number }) mae_6b?: number; // 最大逆势回撤（负值或用正值表示幅度均可）

  // CLOSE 专属：与“不平仓继续持有 3b/6b”对比（正数=平仓更优）
  @Prop({ type: Number }) close_gain_vs_hold_3b?: number;
  @Prop({ type: Number }) close_gain_vs_hold_6b?: number;

  @Prop({ type: Date, default: () => new Date() }) createdAt!: Date;
}
export type OrderEvalDocument = HydratedDocument<OrderEval>;
export const OrderEvalSchema = SchemaFactory.createForClass(OrderEval);
OrderEvalSchema.index({ sym: 1, ts: 1 });
