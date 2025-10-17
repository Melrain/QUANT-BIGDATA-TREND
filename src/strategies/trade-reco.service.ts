/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';
import { Signal, SignalDocument } from '@/infra/mongo/schemas/signal.schema';
import {
  TradeReco,
  TradeRecoDocument,
} from '@/infra/mongo/schemas/trade-reco.schema';

type PositionState = 'LONG' | 'SHORT' | 'FLAT';
type Action =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'REVERSE_LONG'
  | 'REVERSE_SHORT'
  | 'CLOSE'
  | 'ADD_LONG'
  | 'ADD_SHORT'
  | 'HOLD'
  | 'SKIP';

// ============ 小工具 ============
function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}
function linearSlope(xs: number[]): number {
  if (xs.length <= 1) return 0;
  return (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
}
function deriveSide(score: number, thUp: number, thDn: number): PositionState {
  if (score >= thUp) return 'LONG';
  if (score <= thDn) return 'SHORT';
  return 'FLAT';
}

@Injectable()
export class TradeRecoService {
  private readonly logger = new Logger(TradeRecoService.name);

  // —— 固定阈值（兜底）
  private readonly TH_UP_BASE = Number(process.env.TH_UP ?? 0.8);
  private readonly TH_DN_BASE = Number(process.env.TH_DN ?? -0.8);
  private readonly TH_CLOSE = Number(process.env.TH_CLOSE ?? 0.15);
  private readonly DEFAULT_NOTIONAL_USDT = Number(
    process.env.DEFAULT_NOTIONAL_USDT ?? 100,
  );

  // —— 自适应阈值
  private readonly ADAPTIVE_ON = (process.env.TH_ADAPTIVE_ON ?? '1') === '1';
  private readonly ADAPT_WINDOW = Number(process.env.TH_ADAPT_WINDOW ?? 288); // 24h@5m
  private readonly ADAPT_Z = Number(process.env.TH_ADAPT_Z ?? 1.0);
  private readonly PERC_UP = Number(process.env.TH_PERC_UP ?? 0);
  private readonly PERC_DN = Number(process.env.TH_PERC_DN ?? 0);

  // —— 持续&斜率确认
  private readonly CONFIRM_BARS = Number(process.env.CONFIRM_BARS ?? 2);
  private readonly SLOPE_BARS = Number(process.env.SLOPE_BARS ?? 3);
  private readonly REQUIRE_SLOPE = (process.env.REQUIRE_SLOPE ?? '1') === '1';

  // —— 动作冷却（分钟）
  private readonly ACTION_COOLDOWN_MIN = Number(
    process.env.ACTION_COOLDOWN_MIN ?? 5,
  );

  // —— 收紧 CLOSE
  private readonly NEUTRAL_BARS = Number(process.env.NEUTRAL_BARS ?? 3);
  private readonly CLOSE_REQUIRE_MIN_HOLD =
    (process.env.CLOSE_REQUIRE_MIN_HOLD ?? '1') === '1';

  // —— 趋势加强（加仓）参数
  private readonly BOOST_ON = (process.env.BOOST_ON ?? '1') === '1';
  // 进入强势区时的附加边距（比分数阈值更高一点才考虑加仓）
  private readonly BOOST_MARGIN = Number(process.env.BOOST_MARGIN ?? 0.2);
  // 自最近一次“进入持仓”以来，分数新高/新低需要超过的最小幅度
  private readonly BOOST_GAP_SCORE = Number(process.env.BOOST_GAP_SCORE ?? 0.1);
  // 相邻两次加仓的最小冷却（分钟）
  private readonly BOOST_COOLDOWN_MIN = Number(
    process.env.BOOST_COOLDOWN_MIN ?? 10,
  );
  // 单次交易生命周期内最多允许加仓次数
  private readonly BOOST_MAX_PER_TRADE = Number(
    process.env.BOOST_MAX_PER_TRADE ?? 2,
  );

  constructor(
    @InjectModel(Signal.name) private readonly sigModel: Model<SignalDocument>,
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolsFromRegistry();
  }
  private symbolsFromRegistry(): string[] {
    return this.symbolRegistry.getAll();
  }

  // === 最近 N 根 score（旧→新）
  private async getRecentScores(sym: string, n: number): Promise<number[]> {
    const rows = await this.sigModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(n)
      .lean<{ score: number }[]>()
      .exec();
    const arr = rows.map((r) => Number(r?.score)).filter(Number.isFinite);
    return arr.reverse();
  }

  // === 自适应阈值 ===
  private percentile(xs: number[], p: number): number {
    if (!xs.length) return 0;
    if (p <= 0) return xs[0];
    if (p >= 1) return xs[xs.length - 1];
    const ys = [...xs].sort((a, b) => a - b);
    const idx = Math.floor(p * (ys.length - 1));
    return ys[idx];
  }
  private async getThresholds(
    sym: string,
  ): Promise<{ thUp: number; thDn: number; meta: any }> {
    if (!this.ADAPTIVE_ON) {
      return {
        thUp: this.TH_UP_BASE,
        thDn: this.TH_DN_BASE,
        meta: { mode: 'fixed' },
      };
    }
    const scores = await this.getRecentScores(sym, this.ADAPT_WINDOW);
    if (scores.length < Math.max(30, this.ADAPT_WINDOW / 4)) {
      return {
        thUp: this.TH_UP_BASE,
        thDn: this.TH_DN_BASE,
        meta: { mode: 'fixed_fallback' },
      };
    }
    let thUp: number,
      thDn: number,
      mode = 'zscore';
    if (this.PERC_UP > 0 && this.PERC_DN > 0) {
      thUp = this.percentile(scores, this.PERC_UP);
      thDn = this.percentile(scores, this.PERC_DN);
      mode = 'percentile';
    } else {
      const m = mean(scores);
      const s = std(scores) || 1e-6;
      thUp = m + this.ADAPT_Z * s;
      thDn = m - this.ADAPT_Z * s;
    }
    return { thUp, thDn, meta: { mode, window: this.ADAPT_WINDOW } };
  }

  /** 最近 k 根是否全部 ≥ th（LONG）或 ≤ th（SHORT） */
  private async sustained(
    sym: string,
    th: number,
    k: number,
    dir: 'LONG' | 'SHORT',
  ): Promise<boolean> {
    if (k <= 1) return true;
    const rec = await this.sigModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(k)
      .lean<{ score: number }[]>()
      .exec();
    if (rec.length < k) return false;
    if (dir === 'LONG') return rec.every((r) => Number(r.score) >= th);
    return rec.every((r) => Number(r.score) <= th);
  }

  /** 最近 n 根的斜率（LONG: >0，SHORT: <0） */
  private async slopeOk(
    sym: string,
    n: number,
    dir: 'LONG' | 'SHORT',
  ): Promise<boolean> {
    if (n <= 1) return true;
    const xs = await this.getRecentScores(sym, n);
    if (xs.length < n) return false;
    const s = linearSlope(xs);
    return dir === 'LONG' ? s > 0 : s < 0;
  }

  /** 上一次 reco 的 ts（动作发生时间，用于冷却） */
  private async getLastActionTs(sym: string): Promise<number | undefined> {
    const prev = await this.recoModel
      .findOne({ sym })
      .sort({ ts: -1 })
      .lean<{ ts: number }>()
      .exec();
    return prev?.ts;
  }

  /** 从上一条 reco 推断已持仓状态 */
  private async getLastPos(sym: string): Promise<PositionState> {
    const prev = await this.recoModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!prev) return 'FLAT';
    switch (prev.action) {
      case 'OPEN_LONG':
      case 'REVERSE_LONG':
      case 'ADD_LONG':
        return 'LONG';
      case 'OPEN_SHORT':
      case 'REVERSE_SHORT':
      case 'ADD_SHORT':
        return 'SHORT';
      case 'CLOSE':
        return 'FLAT';
      default:
        return (prev as any).posState ?? 'FLAT';
    }
  }

  /** 最近一次“进入持仓（含反转）”的 ts */
  private async getLastOpenTs(sym: string): Promise<number | undefined> {
    const prevOpen = await this.recoModel
      .findOne({
        sym,
        action: {
          $in: ['OPEN_LONG', 'OPEN_SHORT', 'REVERSE_LONG', 'REVERSE_SHORT'],
        },
      })
      .sort({ ts: -1 })
      .lean<{ ts: number }>()
      .exec();
    return prevOpen?.ts;
  }

  /** 最近一次“同向（含 ADD_*）动作”的 ts，用于加仓冷却 */
  private async getLastSameSideActionTs(
    sym: string,
    dir: 'LONG' | 'SHORT',
  ): Promise<number | undefined> {
    const acts =
      dir === 'LONG'
        ? ['OPEN_LONG', 'REVERSE_LONG', 'ADD_LONG']
        : ['OPEN_SHORT', 'REVERSE_SHORT', 'ADD_SHORT'];
    const prev = await this.recoModel
      .findOne({ sym, action: { $in: acts } })
      .sort({ ts: -1 })
      .lean<{ ts: number }>()
      .exec();
    return prev?.ts;
  }

  /** 当前这笔交易生命周期内，已经加仓的次数 */
  private async getBoostCountInThisTrade(
    sym: string,
    lastOpenTs?: number,
  ): Promise<number> {
    if (!lastOpenTs) return 0;
    const cnt = await this.recoModel.countDocuments({
      sym,
      ts: { $gte: lastOpenTs },
      action: { $in: ['ADD_LONG', 'ADD_SHORT'] },
    });
    return cnt;
  }

  /** 自最近一次进场起，分数最高/最低（用于“新高/新低”判断） */
  private async getScoreExtremaSince(
    sym: string,
    sinceTs: number,
  ): Promise<{ max?: number; min?: number }> {
    const rows = await this.sigModel
      .find({ sym, ts: { $gte: sinceTs } })
      .sort({ ts: 1 })
      .select({ score: 1 })
      .lean<{ score: number }[]>()
      .exec();
    if (!rows?.length) return {};
    const arr = rows.map((r) => Number(r?.score)).filter(Number.isFinite);
    return { max: Math.max(...arr), min: Math.min(...arr) };
  }

  /** 最近 k 根 signal 是否都在中性带（|score| <= TH_CLOSE） */
  private async hasConsecutiveNeutral(
    sym: string,
    untilTs: number,
    k: number,
  ): Promise<boolean> {
    if (k <= 1) return true;
    const sigs = await this.sigModel
      .find({ sym, ts: { $lte: untilTs } })
      .sort({ ts: -1 })
      .limit(k)
      .lean<{ score: number }[]>()
      .exec();
    if (!sigs || sigs.length < k) return false;
    return sigs.every(
      (s) => Math.abs(Number(s?.score ?? NaN)) <= this.TH_CLOSE,
    );
  }

  // ============ 核心：从最新 signal 生成（或跳过）一条 trade_reco ============
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const sig = await this.sigModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!sig) return { ok: false, reason: 'no_signal' };

    const { thUp, thDn, meta: thMeta } = await this.getThresholds(sym);

    const _id = `${sym}|${sig.ts}`;
    const exists = await this.recoModel.exists({ _id });
    if (exists) return { ok: false, reason: 'reco_exists' };

    const score0 = Number(sig.score);
    if (!Number.isFinite(score0)) return { ok: false, reason: 'score_nan' };

    // 取上一档分数，判断是否“穿越”
    const prevSig = await this.sigModel
      .findOne({ sym, ts: { $lt: sig.ts } })
      .sort({ ts: -1 })
      .lean();
    const score1 = Number(prevSig?.score ?? NaN);

    const crossedUp =
      Number.isFinite(score1) && score1 < thUp && score0 >= thUp;
    const crossedDown =
      Number.isFinite(score1) && score1 > thDn && score0 <= thDn;

    // 持续确认
    const sustainedUp = await this.sustained(
      sym,
      thUp,
      this.CONFIRM_BARS,
      'LONG',
    );
    const sustainedDown = await this.sustained(
      sym,
      thDn,
      this.CONFIRM_BARS,
      'SHORT',
    );

    // 斜率确认
    const slopeOkLong = this.REQUIRE_SLOPE
      ? await this.slopeOk(sym, this.SLOPE_BARS, 'LONG')
      : true;
    const slopeOkShort = this.REQUIRE_SLOPE
      ? await this.slopeOk(sym, this.SLOPE_BARS, 'SHORT')
      : true;

    const lastPos = await this.getLastPos(sym);

    // 全局冷却（任意动作之间）
    const lastActionTs = await this.getLastActionTs(sym);
    const cooldownOk = lastActionTs
      ? sig.ts - lastActionTs >= this.ACTION_COOLDOWN_MIN * 60 * 1000
      : true;
    if (!cooldownOk) return { ok: false, reason: 'cooldown' };

    // 目标“期望侧”（用于解释）
    const expectedSide = deriveSide(score0, thUp, thDn);

    // ====== 决策（含趋势加强） ======
    let action: Action;

    if (lastPos === 'FLAT') {
      if ((crossedUp || sustainedUp) && slopeOkLong) action = 'OPEN_LONG';
      else if ((crossedDown || sustainedDown) && slopeOkShort)
        action = 'OPEN_SHORT';
      else action = 'HOLD';
    } else {
      // 先看是否需要反转
      const wantReverseToLong = (crossedUp || sustainedUp) && slopeOkLong;
      const wantReverseToShort = (crossedDown || sustainedDown) && slopeOkShort;

      if (lastPos === 'LONG' && wantReverseToShort) {
        action = 'REVERSE_SHORT';
      } else if (lastPos === 'SHORT' && wantReverseToLong) {
        action = 'REVERSE_LONG';
      } else {
        // 已持仓、同向：考虑 CLOSE 或 ADD
        const neutralNow = Math.abs(score0) <= this.TH_CLOSE;

        // 1) CLOSE（更苛刻）
        if (neutralNow) {
          const k = Math.max(1, this.NEUTRAL_BARS);
          const neutralOk = await this.hasConsecutiveNeutral(sym, sig.ts, k);

          let holdOk = true;
          if (this.CLOSE_REQUIRE_MIN_HOLD) {
            const lastOpenTs = await this.getLastOpenTs(sym);
            const minHoldMs =
              Number(process.env.MIN_HOLD_MINUTES ?? 15) * 60 * 1000;
            holdOk = lastOpenTs ? sig.ts - lastOpenTs >= minHoldMs : true;
          }
          action = neutralOk && holdOk ? 'CLOSE' : 'HOLD';
        } else {
          // 2) 趋势加强（加仓）
          if (this.BOOST_ON) {
            const lastOpenTs = await this.getLastOpenTs(sym);
            if (lastOpenTs) {
              const boostCount = await this.getBoostCountInThisTrade(
                sym,
                lastOpenTs,
              );
              if (boostCount < this.BOOST_MAX_PER_TRADE) {
                const lastSameSideTs = await this.getLastSameSideActionTs(
                  sym,
                  lastPos,
                );
                const boostCooldownOk = lastSameSideTs
                  ? sig.ts - lastSameSideTs >=
                    this.BOOST_COOLDOWN_MIN * 60 * 1000
                  : true;

                const extrema = await this.getScoreExtremaSince(
                  sym,
                  lastOpenTs,
                );
                const maxSince = extrema.max ?? score0;
                const minSince = extrema.min ?? score0;

                if (lastPos === 'LONG') {
                  const deepInLongZone = score0 >= thUp + this.BOOST_MARGIN;
                  const newHighEnough =
                    score0 >= maxSince + this.BOOST_GAP_SCORE;
                  if (
                    deepInLongZone &&
                    newHighEnough &&
                    slopeOkLong &&
                    boostCooldownOk
                  ) {
                    action = 'ADD_LONG';
                  } else {
                    action = 'HOLD';
                  }
                } else {
                  // lastPos === 'SHORT'
                  const deepInShortZone = score0 <= thDn - this.BOOST_MARGIN;
                  const newLowEnough =
                    score0 <= minSince - this.BOOST_GAP_SCORE;
                  if (
                    deepInShortZone &&
                    newLowEnough &&
                    slopeOkShort &&
                    boostCooldownOk
                  ) {
                    action = 'ADD_SHORT';
                  } else {
                    action = 'HOLD';
                  }
                }
              } else {
                action = 'HOLD';
              }
            } else {
              action = 'HOLD';
            }
          } else {
            action = 'HOLD';
          }
        }
      }
    }

    if (action === 'HOLD') return { ok: false, reason: 'hold' };

    const doc: TradeReco = {
      _id,
      sym,
      ts: sig.ts,
      action,
      side: action.includes('SHORT')
        ? 'SELL'
        : action === 'CLOSE' && lastPos === 'LONG'
          ? 'SELL'
          : 'BUY',
      score: score0,
      notionalUSDT: this.DEFAULT_NOTIONAL_USDT,
      degraded: false,
      reasons: {
        lastPos,
        sideFromSignal: expectedSide,
        thresholds: { up: thUp, dn: thDn, close: this.TH_CLOSE },
        raw: {
          taker_imb: (sig as any).taker_imb,
          oi_chg: (sig as any).oi_chg,
          meta: {
            ...(sig as any).meta,
            adaptive: {
              on: this.ADAPTIVE_ON,
              method:
                this.PERC_UP > 0 && this.PERC_DN > 0 ? 'percentile' : 'zscore',
              window: this.ADAPT_WINDOW,
              z: this.ADAPT_Z,
              percUp: this.PERC_UP,
              percDn: this.PERC_DN,
              thMeta,
            },
            confirmBars: this.CONFIRM_BARS,
            slopeBars: this.SLOPE_BARS,
            requireSlope: this.REQUIRE_SLOPE,
            cooldownMin: this.ACTION_COOLDOWN_MIN,
            boost: {
              on: this.BOOST_ON,
              margin: this.BOOST_MARGIN,
              gapScore: this.BOOST_GAP_SCORE,
              cooldownMin: this.BOOST_COOLDOWN_MIN,
              maxPerTrade: this.BOOST_MAX_PER_TRADE,
            },
          },
        },
      },
      risk: {
        stopPct: Number(process.env.RISK_STOP_PCT ?? 0.01),
        minHoldMinutes: Number(process.env.MIN_HOLD_MINUTES ?? 15),
        cooldownMinutes: Number(process.env.COOLDOWN_MINUTES ?? 10),
      },
    };

    await this.recoModel.updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true },
    );

    this.logger.log(
      `TradeReco upserted: ${doc._id} action=${doc.action} score=${doc.score}`,
    );
    return { ok: true, id: doc._id };
  }
}
