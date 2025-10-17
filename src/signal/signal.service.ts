/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Signal, SignalDocument } from './schemas/signal.schema';
import { Feature, FeatureDocument } from '@/infra/mongo/schemas/feature.schema';

const PERIOD_MS = 5 * 60 * 1000;

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

  // —— 行为
  private readonly DRY_RUN = (process.env.DRY_RUN ?? '1') === '1';

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

  /** 拉取严格对齐的 f0/f1/...，避免拿到非相邻bar */
  private async fetchAligned(sym: string, needBars: number, nowTs?: number) {
    const t0 = this.align5m(nowTs ?? Date.now());
    const buckets = Array.from(
      { length: needBars },
      (_, i) => t0 - i * PERIOD_MS,
    );
    const feats = await this.featureModel
      .find({ sym, ts: { $in: buckets } })
      .lean()
      .exec();
    const byTs = new Map<number, Feature>(
      feats.map((f) => [Number(f.ts), f as any]),
    );
    const arr = buckets.map((ts) => byTs.get(ts));
    return { arr, buckets, t0 };
  }

  /** 简单 EMA 平滑 */
  private ema(values: number[], n: number) {
    const alpha = 2 / (n + 1);
    let e = values[0];
    for (let i = 1; i < n; i++) {
      e = alpha * values[i] + (1 - alpha) * e;
    }
    return e;
  }

  /** 最近 k 根是否都满足某侧阈值（确认用） */
  private seqOK(
    scores: number[],
    k: number,
    want: 'LONG' | 'SHORT',
    thUp: number,
    thDn: number,
  ) {
    const take = scores.slice(0, k); // 注意：scores[0] 是当前，1 是上一根...
    return want === 'LONG'
      ? take.every((s) => Number.isFinite(s) && s >= thUp)
      : take.every((s) => Number.isFinite(s) && s <= thDn);
  }

  /** 生成一个 symbol 的最新信号（幂等） */
  async evaluateOnce(sym: string) {
    // 为了 EMA+确认，需要 max(EMA_BARS, CONFIRM_BARS) 根
    const need = Math.max(this.EMA_BARS, this.CONFIRM_BARS, 2);
    const { arr, buckets, t0 } = await this.fetchAligned(sym, need);

    // 缺 data：至少要保证前两根存在
    if (!arr[0] || !arr[1]) {
      this.logger.debug(`[Signal] ${sym} missing f0/f1@${t0}, skip`);
      return { made: 0, side: 'FLAT' as const, reason: 'missing_bars' };
    }

    // 取 score_24h 作为信号源
    const scoresRaw = arr.map((f) => Number((f as any)?.score_24h));
    if (scoresRaw.some((s, i) => i < 2 && !Number.isFinite(s))) {
      return { made: 0, side: 'FLAT' as const, reason: 'score_nan' };
    }

    // EMA 平滑当前分
    const score0 = this.ema(scoresRaw.slice(0, this.EMA_BARS), this.EMA_BARS);
    const score1 = scoresRaw[1];

    // deadband 中性带
    let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
    if (Math.abs(score0) < this.DEADBAND) {
      side = 'FLAT';
    } else {
      // 穿越 + 连续确认
      const crossedUp = score1 < this.TH_UP && score0 >= this.TH_UP;
      const crossedDn = score1 > this.TH_DN && score0 <= this.TH_DN;

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

      if (crossedUp && confirmOKLong) side = 'LONG';
      else if (crossedDn && confirmOKShort) side = 'SHORT';
      else side = 'FLAT';
    }

    const f0 = arr[0];
    const ts = buckets[0];
    const _id = `${sym}|${ts}`;

    // 幂等：若 side/score 均未变则不写库
    const prev = await this.signalModel.findById(_id).lean<Signal>().exec();
    if (prev && prev.side === side && Number(prev.score) === Number(score0)) {
      this.logger.debug(
        `[Signal] ${sym}@${ts} unchanged side=${side} score=${score0}`,
      );
      return { made: 0, side, reason: 'unchanged' };
    }

    // upsert：创建只写 createdAt；timestamps 交给 Schema 更稳（有就别手写 createdAt）
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
            raw: { score0, score1 },
          },
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    if (this.DRY_RUN) {
      this.logger.log(
        `Signal ${sym} @${ts}: ${side} (score=${score0.toFixed?.(3)}) [DRY_RUN]`,
      );
    } else {
      // 触发全局事件（供 reco/order 层订阅）
      this.events.emit('signal.new', { sym, ts, side, score: score0 });
    }

    return { made: 1, side };
  }

  /** 别名：兼容调度器调用 */
  async buildOne(sym: string) {
    return this.evaluateOnce(sym);
  }
}
