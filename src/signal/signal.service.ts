/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ProjectionType } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Signal, SignalDocument } from './schemas/signal.schema';
import { Feature, FeatureDocument } from '@/infra/mongo/schemas/feature.schema';

const PERIOD_MS = 5 * 60 * 1000;
const EPS = 1e-6; // 幂等比较时的容忍

@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  // —— 基础阈值
  private readonly TH_UP = Number(process.env.SIGNAL_TH_UP ?? 0.8);
  private readonly TH_DN = Number(process.env.SIGNAL_TH_DN ?? -0.8);

  // —— 去抖&稳定化
  private readonly EMA_BARS = Math.max(
    2,
    Number(process.env.SIGNAL_EMA_BARS ?? 3),
  );
  private readonly DEADBAND = Number(process.env.SIGNAL_DEADBAND ?? 0.1);
  private readonly CONFIRM_BARS = Math.max(
    1,
    Number(process.env.SIGNAL_CONFIRM_BARS ?? 2),
  );

  // —— 可选：斜率确认（防“弱穿越”）
  private readonly REQUIRE_SLOPE = (process.env.REQUIRE_SLOPE ?? '0') === '1';
  private readonly SLOPE_BARS = Math.max(
    2,
    Number(process.env.SLOPE_BARS ?? 3),
  );

  // —— 行为 & 新鲜度
  private readonly DRY_RUN = (process.env.DRY_RUN ?? '1') === '1';
  // 只接受最近 N 档内的信号（防用到过期 feature）
  private readonly MAX_LAG_BARS = Math.max(
    1,
    Number(process.env.SIGNAL_MAX_LAG_BARS ?? 2),
  );

  constructor(
    @InjectModel(Feature.name)
    private readonly featureModel: Model<FeatureDocument>,
    @InjectModel(Signal.name)
    private readonly signalModel: Model<SignalDocument>,
    private readonly events: EventEmitter2,
  ) {}

  private align5m(ts: number) {
    return Math.floor(ts / PERIOD_MS) * PERIOD_MS;
  }

  /** 仅取必要字段，严格按桶对齐，避免拿到非相邻bar */
  private async fetchAligned(
    sym: string,
    needBars: number,
    nowTs?: number,
  ): Promise<{
    arr: (Pick<Feature, 'ts'> & Partial<Feature>)[];
    buckets: number[];
    t0: number;
  }> {
    const t0 = this.align5m(nowTs ?? Date.now());
    const buckets = Array.from(
      { length: needBars },
      (_, i) => t0 - i * PERIOD_MS,
    );

    const proj: ProjectionType<Feature> = {
      _id: 0,
      sym: 1,
      ts: 1,
      score_24h: 1,
      taker_imb: 1,
      oi_chg: 1,
    } as any;

    const feats = await this.featureModel
      .find({ sym, ts: { $in: buckets } }, proj)
      .lean()
      .exec();

    const byTs = new Map<number, Feature>(
      feats.map((f) => [Number(f.ts), f as any]),
    );
    const arr = buckets.map((ts) => byTs.get(ts) as any);

    return { arr, buckets, t0 };
  }

  /** EMA（跳过 NaN；长度不足回退到可用均值/最后值） */
  private emaSafe(values: number[], n: number) {
    const clean = values.filter((v) => Number.isFinite(v));
    if (clean.length === 0) return NaN;
    if (clean.length === 1) return clean[0];
    const m = Math.min(n, clean.length);
    const alpha = 2 / (m + 1);
    let e = clean[0];
    for (let i = 1; i < clean.length; i++)
      e = alpha * clean[i] + (1 - alpha) * e;
    return e;
  }

  /** scores[0] 是当前，1 是上一根... 取前 k 根是否全部满足 */
  private seqOK(
    scores: number[],
    k: number,
    want: 'LONG' | 'SHORT',
    thUp: number,
    thDn: number,
  ) {
    const take = scores.slice(0, k);
    if (take.length < k) return false;
    return want === 'LONG'
      ? take.every((s) => Number.isFinite(s) && s >= thUp)
      : take.every((s) => Number.isFinite(s) && s <= thDn);
  }

  /** 最近 k 根的“斜率”方向（简单差分和） */
  private slopeOK(scores: number[], k: number, want: 'LONG' | 'SHORT') {
    const take = scores.slice(0, k).filter((v) => Number.isFinite(v));
    if (take.length < k) return false;
    // 差分和（当前-上一根 + 上一根-上上一根 ...）
    let sum = 0;
    for (let i = 0; i < k - 1; i++) sum += take[i] - take[i + 1];
    return want === 'LONG' ? sum > 0 : sum < 0;
  }

  /** 生成一个 symbol 的最新信号（幂等） */
  async evaluateOnce(sym: string) {
    // EMA/确认/斜率 需要的最大根数
    const need = Math.max(this.EMA_BARS, this.CONFIRM_BARS, this.SLOPE_BARS, 2);
    const { arr, buckets, t0 } = await this.fetchAligned(sym, need);

    // 缺 data：至少保证 f0/f1 存在
    if (!arr[0] || !arr[1]) {
      this.logger.debug(`[Signal] ${sym} missing f0/f1@${t0}, skip`);
      return { made: 0, side: 'FLAT' as const, reason: 'missing_bars' };
    }

    // 新鲜度：不接受过旧桶
    const nowAligned = this.align5m(Date.now());
    const barsLag = (nowAligned - buckets[0]) / PERIOD_MS;
    if (barsLag > this.MAX_LAG_BARS) {
      return { made: 0, side: 'FLAT' as const, reason: 'stale_bucket' };
    }

    // 取 score_24h
    const scoresRaw = arr.map((f) => Number((f as any)?.score_24h));
    const s0raw = scoresRaw[0],
      s1raw = scoresRaw[1];
    if (!Number.isFinite(s0raw) || !Number.isFinite(s1raw)) {
      return { made: 0, side: 'FLAT' as const, reason: 'score_nan' };
    }

    // EMA 平滑当前分
    const score0 = this.emaSafe(
      scoresRaw.slice(0, this.EMA_BARS),
      this.EMA_BARS,
    );
    const score1 = s1raw;

    // deadband 中性带
    let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
    let trigger: 'none' | 'cross_up' | 'cross_dn' = 'none';

    if (Number.isFinite(score0) && Math.abs(score0) >= this.DEADBAND) {
      // 穿越判定：对“阈值线”做上下穿
      const crossedUp = score1 < this.TH_UP && score0 >= this.TH_UP;
      const crossedDn = score1 > this.TH_DN && score0 <= this.TH_DN;

      // 连续确认
      const confirmOKLong = this.seqOK(
        scoresRaw,
        this.CONFIRM_BARS,
        'LONG',
        this.TH_UP,
        this.TH_DN,
      );
      const confirmOKShort = this.seqOK(
        scoresRaw,
        this.CONFIRM_BARS,
        'SHORT',
        this.TH_UP,
        this.TH_DN,
      );

      // 可选：斜率确认
      const slopeOKLong =
        !this.REQUIRE_SLOPE || this.slopeOK(scoresRaw, this.SLOPE_BARS, 'LONG');
      const slopeOKShort =
        !this.REQUIRE_SLOPE ||
        this.slopeOK(scoresRaw, this.SLOPE_BARS, 'SHORT');

      if (crossedUp && confirmOKLong && slopeOKLong) {
        side = 'LONG';
        trigger = 'cross_up';
      } else if (crossedDn && confirmOKShort && slopeOKShort) {
        side = 'SHORT';
        trigger = 'cross_dn';
      }
    }

    const f0 = arr[0];
    const ts = buckets[0];
    const _id = `${sym}|${ts}`;

    // 幂等：若 side/score 几乎未变则不写库
    const prev = await this.signalModel.findById(_id).lean<Signal>().exec();
    if (
      prev &&
      prev.side === side &&
      Number.isFinite(Number(prev.score)) &&
      Math.abs(Number(prev.score) - Number(score0)) < EPS
    ) {
      this.logger.debug(
        `[Signal] ${sym}@${ts} unchanged side=${side} score≈${score0}`,
      );
      return { made: 0, side, reason: 'unchanged' };
    }

    // upsert
    await this.signalModel.updateOne(
      { _id },
      {
        $set: {
          _id,
          sym,
          ts,
          side,
          score: score0,
          taker_imb: (f0 as any).taker_imb,
          oi_chg: (f0 as any).oi_chg,
          meta: {
            th_up: this.TH_UP,
            th_dn: this.TH_DN,
            deadband: this.DEADBAND,
            emaBars: this.EMA_BARS,
            confirmBars: this.CONFIRM_BARS,
            requireSlope: this.REQUIRE_SLOPE,
            slopeBars: this.SLOPE_BARS,
            raw: { score0, score1, scores: scoresRaw.slice(0, 6) },
            trigger, // 可视化排查
          },
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    // 事件（供 reco/order 订阅）
    const payload = {
      sym,
      ts,
      side,
      score: score0,
      prevSide: prev?.side,
      meta: {
        th_up: this.TH_UP,
        th_dn: this.TH_DN,
        deadband: this.DEADBAND,
        emaBars: this.EMA_BARS,
        confirmBars: this.CONFIRM_BARS,
        requireSlope: this.REQUIRE_SLOPE,
        slopeBars: this.SLOPE_BARS,
        trigger,
      },
    };

    if (this.DRY_RUN) {
      this.logger.log(
        `Signal ${sym} @${ts}: ${side} (score=${score0.toFixed?.(3)}) [DRY_RUN]`,
      );
    } else {
      this.events.emit('signal.new', payload);
    }

    return { made: 1, side, trigger };
  }

  /** 兼容旧调度器 */
  async buildOne(sym: string) {
    return this.evaluateOnce(sym);
  }
}
