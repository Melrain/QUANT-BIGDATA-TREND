import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

// TTL 可配置
const FEAT_TTL_DAYS = Number(process.env.FEATURE_TTL_DAYS ?? 14);
const FEAT_TTL_SECONDS = Math.max(1, Math.floor(FEAT_TTL_DAYS * 24 * 60 * 60));

@Schema({ versionKey: false })
export class Feature {
  @Prop({ type: String, required: true })
  _id!: string; // `${sym}|${ts}`

  @Prop({ type: String, index: true, required: true })
  sym!: string;

  @Prop({ type: Number, index: true, required: true })
  ts!: number; // ms, 对齐 5m 边界

  // ---- 基础特征 ----
  @Prop({ type: Number }) taker_imb?: number; // (buy - sell)/(buy + sell)
  @Prop({ type: Number }) oi_chg?: number; // OI 的环比变化（上一 bar）
  @Prop({ type: Number }) vol_z_24h?: number; // 成交量 24h Z 分数
  @Prop({ type: Number }) ls_all_z_24h?: number; // 全体账户多空比 24h Z
  @Prop({ type: Number }) ls_eacc_z_24h?: number; // 精英账户数比 24h Z
  @Prop({ type: Number }) ls_epos_z_24h?: number; // 精英持仓量比 24h Z

  // 可扩展：统一打分（后续可加）
  @Prop({ type: Number }) score_24h?: number;

  @Prop({ type: Date, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Date, default: () => new Date() })
  updatedAt!: Date;
}

export type FeatureDocument = HydratedDocument<Feature>;
export const FeatureSchema = SchemaFactory.createForClass(Feature);

FeatureSchema.index({ sym: 1, ts: -1 });
FeatureSchema.index({ createdAt: 1 }, { expireAfterSeconds: FEAT_TTL_SECONDS });
