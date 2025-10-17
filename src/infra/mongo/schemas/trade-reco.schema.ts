/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeAction = 'BUY' | 'SELL' | 'HOLD';
export type TradeSide = 'BUY' | 'SELL';

@Schema({ timestamps: true })
export class TradeReco {
  /** 唯一键：`${sym}|${ts}` */
  @Prop({ type: String })
  _id!: string;

  /** 交易标的，例如 'BTC-USDT-SWAP' */
  @Prop({ type: String, index: true, required: true })
  sym!: string;

  /** 对齐到5m档的时间戳（毫秒） */
  @Prop({ type: Number, index: true, required: true })
  ts!: number;

  /** 建议动作：BUY / SELL / HOLD */
  @Prop({ type: String, required: true, enum: ['BUY', 'SELL', 'HOLD'] })
  action!: TradeAction;

  /** 方向映射（BUY→多，SELL→空，仅为展示一致性） */
  @Prop({ type: String, required: true, enum: ['BUY', 'SELL'] })
  side!: TradeSide;

  /** 当前信号分数 */
  @Prop({ type: Number, required: true })
  score!: number;

  /** 名义USDT下单额 */
  @Prop({ type: Number, required: true })
  notionalUSDT!: number;

  /** 是否退化或异常 */
  @Prop({ type: Boolean, default: false })
  degraded!: boolean;

  /** 调试/解释字段，含 lastPos、thresholds、meta 等 */
  @Prop({ type: Object })
  reasons?: Record<string, any>;

  /** 风控参数：stopPct / minHoldMinutes / cooldownMinutes */
  @Prop({ type: Object })
  risk?: {
    stopPct?: number;
    minHoldMinutes?: number;
    cooldownMinutes?: number;
  };

  /** reco 有效截止时间戳（供执行层过滤过期 reco） */
  @Prop({ type: Number })
  validUntil?: number;
}

export type TradeRecoDocument = HydratedDocument<TradeReco>;
export const TradeRecoSchema = SchemaFactory.createForClass(TradeReco);

/** 索引（常规查询） */
TradeRecoSchema.index({ sym: 1, ts: -1 });
