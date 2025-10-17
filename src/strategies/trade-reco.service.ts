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
type TradeAction =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'REVERSE_LONG'
  | 'REVERSE_SHORT'
  | 'ADD_LONG'
  | 'ADD_SHORT'
  | 'CLOSE'
  | 'HOLD'
  | 'SKIP';

// —— 工具：由分数与阈值得到方向
function deriveSide(score: number, thUp: number, thDn: number): PositionState {
  if (score >= thUp) return 'LONG';
  if (score <= thDn) return 'SHORT';
  return 'FLAT';
}

@Injectable()
export class TradeRecoService {
  private readonly logger = new Logger(TradeRecoService.name);

  // ===== 阈值与钳制（防阈值塌陷） =====
  private readonly TH_UP_BASE = Number(process.env.TH_UP ?? 0.8);
  private readonly TH_DN_BASE = Number(process.env.TH_DN ?? -0.8);
  // 钳制下限/上限（最终阈值不会比这更宽松）
  private readonly TH_UP_MIN = Number(process.env.TH_UP_MIN ?? 0.5);
  private readonly TH_DN_MAX = Number(process.env.TH_DN_MAX ?? -0.5);

  // ===== CLOSE 收紧逻辑 =====
  private readonly TH_CLOSE = Number(process.env.TH_CLOSE ?? 0.15);
  private readonly NEUTRAL_BARS = Number(process.env.NEUTRAL_BARS ?? 3);
  private readonly CLOSE_REQUIRE_MIN_HOLD =
    (process.env.CLOSE_REQUIRE_MIN_HOLD ?? '1') === '1';

  // ===== 斜率/动能控制 =====
  private readonly REQUIRE_SLOPE = (process.env.REQUIRE_SLOPE ?? '1') === '1';
  private readonly SLOPE_BARS = Math.max(
    1,
    Number(process.env.SLOPE_BARS ?? 2),
  ); // 斜率回看 bars
  // 斜率最小幅度（太小的斜率当作无动能）
  private readonly MIN_MOMENTUM = Number(process.env.MIN_MOMENTUM ?? 0.0);

  // ===== 信号新鲜度/有效期 =====
  private readonly SIG_MAX_AGE_MS = Number(
    process.env.SIG_MAX_AGE_MS ?? 10 * 60 * 1000, // 10m 内的信号才用
  );
  // reco 有效期（便于执行层过滤过期 reco）
  private readonly RECO_TTL_MS = Number(
    process.env.RECO_TTL_MS ?? 5 * 60 * 1000 + 30 * 1000, // 5m 档 + 30s
  );

  // ===== 其他 =====
  private readonly DEFAULT_NOTIONAL_USDT = Number(
    process.env.DEFAULT_NOTIONAL_USDT ?? 100,
  );

  constructor(
    @InjectModel(Signal.name) private readonly sigModel: Model<SignalDocument>,
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  // —— 从上一条 reco 推断“持仓状态”
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

  // 最近一次“进入持仓”的 reco.ts（OPEN_* / REVERSE_* / ADD_*）
  private async getLastOpenTs(sym: string): Promise<number | undefined> {
    const prevOpen = await this.recoModel
      .findOne({
        sym,
        action: {
          $in: [
            'OPEN_LONG',
            'OPEN_SHORT',
            'REVERSE_LONG',
            'REVERSE_SHORT',
            'ADD_LONG',
            'ADD_SHORT',
          ],
        },
      })
      .sort({ ts: -1 })
      .lean<{ ts: number }>()
      .exec();
    return prevOpen?.ts;
  }

  // 最近 k 根 signal 是否都在中性带
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

  // 取斜率/动能：当前分数与 N 根前的分数差，或最近两档差分
  private async getSlope(
    sym: string,
    currentTs: number,
    bars: number,
  ): Promise<number | null> {
    const k = Math.max(1, bars);
    const sigs = await this.sigModel
      .find({ sym, ts: { $lte: currentTs } })
      .sort({ ts: -1 })
      .limit(k + 1) // 当前 + 回看
      .lean<Signal[]>()
      .exec();
    if (!sigs || sigs.length < 2) return null;
    const score0 = Number(sigs[0]?.score);
    const scoreK = Number(sigs[Math.min(k, sigs.length - 1)]?.score);
    if (!Number.isFinite(score0) || !Number.isFinite(scoreK)) return null;
    return score0 - scoreK; // 趋势动能（正：向上加速，负：向下加速）
  }

  /** 从最新 signal 生成（或跳过）一条 trade_reco（稳健版 v2） */
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const sig = await this.sigModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!sig) return { ok: false, reason: 'no_signal' };

    // 信号新鲜度保护（避免旧信号误用）
    const now = Date.now();
    if (now - Number(sig.ts) > this.SIG_MAX_AGE_MS) {
      this.logger.warn(
        `[Reco] skip stale signal ${sym}@${sig.ts} age=${((now - sig.ts) / 1000).toFixed(1)}s`,
      );
      return { ok: false, reason: 'signal_stale' };
    }

    // 幂等：该 ts 已存在就跳过
    const _id = `${sym}|${sig.ts}`;
    const exists = await this.recoModel.exists({ _id });
    if (exists) return { ok: false, reason: 'reco_exists' };

    // —— 统一分数来源
    const score0 = Number(sig.score);
    const score1 = Number(sig?.meta?.raw?.score1 ?? NaN); // 仅用于日志与参考
    if (!Number.isFinite(score0)) return { ok: false, reason: 'score_nan' };

    // —— 阈值（支持自适应来源，但最终做硬钳制）
    const thUpRaw = Number(sig?.meta?.th_up ?? this.TH_UP_BASE);
    const thDnRaw = Number(sig?.meta?.th_dn ?? this.TH_DN_BASE);
    const thUp = Math.max(thUpRaw, this.TH_UP_MIN);
    const thDn = Math.min(thDnRaw, this.TH_DN_MAX);

    // —— 方向推导（唯一真侧）
    const expectedSide = deriveSide(score0, thUp, thDn);

    // 若上游 sig.side 存在，但与我们一致性检查不通过，则降级跳过
    if (sig.side && sig.side !== expectedSide) {
      this.logger.warn(
        `[Reco] degrade ${sym}@${sig.ts}: sig.side=${sig.side} != expected=${expectedSide}, score=${score0}, thUp=${thUp}, thDn=${thDn}`,
      );
      return { ok: false, reason: 'signal_inconsistent' };
    }

    // —— 斜率/动能过滤：动能必须同向且达到最小幅度（可关）
    if (this.REQUIRE_SLOPE && expectedSide !== 'FLAT') {
      const slope = await this.getSlope(sym, sig.ts, this.SLOPE_BARS);
      if (slope !== null) {
        const momentum = slope / this.SLOPE_BARS;
        const slopeOk =
          (expectedSide === 'LONG' &&
            slope > 0 &&
            momentum >= this.MIN_MOMENTUM) ||
          (expectedSide === 'SHORT' &&
            slope < 0 &&
            -momentum >= this.MIN_MOMENTUM);
        if (!slopeOk) {
          this.logger.warn(
            `[Reco] slope_block ${sym}@${sig.ts}: side=${expectedSide} slope=${slope?.toFixed?.(4)} momentum=${momentum?.toFixed?.(4)} thUp=${thUp} thDn=${thDn} score0=${score0} score1=${score1}`,
          );
          return { ok: false, reason: 'slope_block' };
        }
      }
    }

    const side = expectedSide;
    const lastPos = await this.getLastPos(sym);

    // —— 决策逻辑（含 CLOSE 收紧）
    let action: TradeAction;

    if (lastPos === 'FLAT') {
      if (side === 'LONG') action = 'OPEN_LONG';
      else if (side === 'SHORT') action = 'OPEN_SHORT';
      else action = 'HOLD';
    } else if (lastPos === 'LONG') {
      if (side === 'SHORT') action = 'REVERSE_SHORT';
      else {
        // 是否 CLOSE（中性 + 最小持仓时间）
        const neutralNow = Math.abs(score0) <= this.TH_CLOSE;
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
          // 趋势增强可在此扩展 ADD_LONG（此处保持简洁，先不加仓）
          action = 'HOLD';
        }
      }
    } else {
      // lastPos === 'SHORT'
      if (side === 'LONG') action = 'REVERSE_LONG';
      else {
        const neutralNow = Math.abs(score0) <= this.TH_CLOSE;
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
          // 趋势增强可在此扩展 ADD_SHORT（此处保持简洁，先不加仓）
          action = 'HOLD';
        }
      }
    }

    if (action === 'HOLD') return { ok: false, reason: 'hold' };

    // —— reco 有效期（供执行层过滤）
    const validUntil = sig.ts + this.RECO_TTL_MS;

    const doc: TradeReco = {
      _id,
      sym,
      ts: sig.ts,
      action,
      side:
        action.includes('SHORT') || (action === 'CLOSE' && lastPos === 'LONG')
          ? 'SELL'
          : 'BUY',
      score: score0,
      notionalUSDT: this.DEFAULT_NOTIONAL_USDT,
      degraded: false,
      reasons: {
        lastPos,
        sideFromSignal: side,
        thresholds: { up: thUp, dn: thDn, close: this.TH_CLOSE },
        raw: {
          taker_imb: (sig as any).taker_imb,
          oi_chg: (sig as any).oi_chg,
          meta: {
            ...(sig as any).meta,
            // 记录我们最终采用的阈值/控制参数，便于排障
            th_used_up: thUp,
            th_used_dn: thDn,
            slopeBars: this.SLOPE_BARS,
            requireSlope: this.REQUIRE_SLOPE,
            minMomentum: this.MIN_MOMENTUM,
            neutralBarsRequired: this.NEUTRAL_BARS,
            closeNeedsMinHold: this.CLOSE_REQUIRE_MIN_HOLD,
            validUntil,
          },
        },
      },
      risk: {
        stopPct: Number(process.env.RISK_STOP_PCT ?? 0.01),
        minHoldMinutes: Number(process.env.MIN_HOLD_MINUTES ?? 15),
        cooldownMinutes: Number(process.env.COOLDOWN_MINUTES ?? 10),
      },
      validUntil, // 可选字段（执行层用它来判断过期）
    } as any;

    await this.recoModel.updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true },
    );

    this.logger.log(
      `TradeReco upserted: ${doc._id} action=${doc.action} score=${doc.score} thUp=${thUp} thDn=${thDn}`,
    );
    return { ok: true, id: doc._id };
  }
}
