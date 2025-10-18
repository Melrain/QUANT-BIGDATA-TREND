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
type RecoAction = 'BUY' | 'SELL' | 'HOLD';

// —— 由分数与阈值得到方向
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
  private readonly TH_UP_MIN = Number(process.env.TH_UP_MIN ?? 0.5);
  private readonly TH_DN_MAX = Number(process.env.TH_DN_MAX ?? -0.5);

  // ===== 斜率/动能控制（可选） =====
  private readonly REQUIRE_SLOPE = (process.env.REQUIRE_SLOPE ?? '1') === '1';
  private readonly SLOPE_BARS = Math.max(
    1,
    Number(process.env.SLOPE_BARS ?? 2),
  );
  private readonly MIN_MOMENTUM = Number(process.env.MIN_MOMENTUM ?? 0.0);

  // ===== 信号新鲜度/有效期 =====
  private readonly SIG_MAX_AGE_MS = Number(
    process.env.SIG_MAX_AGE_MS ?? 10 * 60 * 1000, // 10m 内的信号才用
  );
  private readonly RECO_TTL_MS = Number(
    process.env.RECO_TTL_MS ?? 5 * 60 * 1000 + 30 * 1000, // 5m 档 + 30s
  );

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

  /** 读取“上一条 reco 的持仓状态”；优先用 posAfter，没有则根据上一动作推断 */
  private async getLastPos(sym: string): Promise<PositionState> {
    const prev = await this.recoModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!prev) return 'FLAT';

    const posAfter = (prev as any)?.posAfter as PositionState | undefined;
    if (posAfter) return posAfter;

    // 兼容历史：若之前是老动作枚举，则做一次合理推断
    const a = (prev as any)?.action as string | undefined;
    if (a === 'BUY') return 'LONG';
    if (a === 'SELL') return 'SHORT';

    // 老版本 OPEN_*/REVERSE_* 兼容
    if (a?.includes?.('LONG')) return 'LONG';
    if (a?.includes?.('SHORT')) return 'SHORT';
    return 'FLAT';
  }

  /** 简单动能：score0 - scoreK，用于方向一致性过滤 */
  private async getSlope(
    sym: string,
    currentTs: number,
    bars: number,
  ): Promise<number | null> {
    const k = Math.max(1, bars);
    const sigs = await this.sigModel
      .find({ sym, ts: { $lte: currentTs } })
      .sort({ ts: -1 })
      .limit(k + 1)
      .lean<Signal[]>()
      .exec();
    if (!sigs || sigs.length < 2) return null;
    const score0 = Number(sigs[0]?.score);
    const scoreK = Number(sigs[Math.min(k, sigs.length - 1)]?.score);
    if (!Number.isFinite(score0) || !Number.isFinite(scoreK)) return null;
    return score0 - scoreK;
  }

  /** 主逻辑：只产出 BUY / SELL / HOLD */
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const sig = await this.sigModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!sig) return { ok: false, reason: 'no_signal' };

    // 新鲜度
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

    // 分数 & 阈值
    const score0 = Number(sig.score);
    const score1 = Number(sig?.meta?.raw?.score1 ?? NaN);
    if (!Number.isFinite(score0)) return { ok: false, reason: 'score_nan' };

    const thUpRaw = Number(sig?.meta?.th_up ?? this.TH_UP_BASE);
    const thDnRaw = Number(sig?.meta?.th_dn ?? this.TH_DN_BASE);
    const thUp = Math.max(thUpRaw, this.TH_UP_MIN);
    const thDn = Math.min(thDnRaw, this.TH_DN_MAX);

    const targetPos = deriveSide(score0, thUp, thDn); // 我们想要去的方向
    const lastPos = await this.getLastPos(sym);

    // 若上游 sig.side 存在，则必须一致；不一致则跳过，避免脏 reco
    // —— 与上游信号的一致性：仅“明确相反”才阻断；FLAT 允许按电平继续
    const sideIsBlocking =
      sig.side && sig.side !== 'FLAT' && sig.side !== targetPos;

    // 记录一个“弱降级”标记：signal 是 FLAT，但我们按电平要动
    const degraded =
      !sideIsBlocking && sig.side === 'FLAT' && targetPos !== 'FLAT';

    if (sideIsBlocking) {
      this.logger.warn(
        `[Reco] conflict ${sym}@${sig.ts}: sig.side=${sig.side} vs target=${targetPos}, score=${score0} (thUp=${thUp}, thDn=${thDn})`,
      );
      return { ok: false, reason: 'signal_inconsistent' };
    }

    // 斜率/动能过滤（可关）
    if (this.REQUIRE_SLOPE && targetPos !== 'FLAT') {
      const slope = await this.getSlope(sym, sig.ts, this.SLOPE_BARS);
      if (slope !== null) {
        const momentum = slope / this.SLOPE_BARS;
        const slopeOk =
          (targetPos === 'LONG' &&
            slope > 0 &&
            momentum >= this.MIN_MOMENTUM) ||
          (targetPos === 'SHORT' &&
            slope < 0 &&
            -momentum >= this.MIN_MOMENTUM);
        if (!slopeOk) {
          this.logger.warn(
            `[Reco] slope_block ${sym}@${sig.ts}: want=${targetPos} slope=${slope?.toFixed?.(4)} momentum=${momentum?.toFixed?.(4)} score0=${score0} score1=${score1}`,
          );
          return { ok: false, reason: 'slope_block' };
        }
      }
    }

    // —— 决策（只有 BUY / SELL / HOLD）
    let action: RecoAction = 'HOLD';
    let posAfter: PositionState = lastPos;

    if (targetPos === 'LONG' && lastPos !== 'LONG') {
      action = 'BUY';
      posAfter = 'LONG';
    } else if (targetPos === 'SHORT' && lastPos !== 'SHORT') {
      action = 'SELL';
      posAfter = 'SHORT';
    } else {
      // targetPos 为 FLAT 或者 与 lastPos 相同：不动
      action = 'HOLD';
      posAfter = lastPos;
    }

    if (action === 'HOLD') return { ok: false, reason: 'hold' };

    const validUntil = Number(sig.ts) + this.RECO_TTL_MS;

    const doc: TradeReco = {
      _id,
      sym,
      ts: Number(sig.ts),
      action, // 'BUY' | 'SELL'
      side: action === 'BUY' ? 'BUY' : 'SELL',
      score: score0,
      notionalUSDT: this.DEFAULT_NOTIONAL_USDT,

      degraded, // ← 这里改为上面的变量
      reasons: {
        lastPos,
        targetPos,
        thresholds: { up: thUp, dn: thDn },
        raw: {
          taker_imb: (sig as any).taker_imb,
          oi_chg: (sig as any).oi_chg,
          meta: {
            ...(sig as any).meta,
            th_used_up: thUp,
            th_used_dn: thDn,
            slopeBars: this.SLOPE_BARS,
            requireSlope: this.REQUIRE_SLOPE,
            minMomentum: this.MIN_MOMENTUM,
            validUntil,
            degradedBecauseFlat: degraded, // ← 额外放个旗子，便于离线分析
          },
        },
      },
      risk: {
        stopPct: Number(process.env.RISK_STOP_PCT ?? 0.01),
        minHoldMinutes: Number(process.env.MIN_HOLD_MINUTES ?? 15),
        cooldownMinutes: Number(process.env.COOLDOWN_MINUTES ?? 10),
      },
      ...({ posAfter } as any),
      validUntil,
    };

    await this.recoModel.updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true },
    );

    this.logger.log(
      `TradeReco upserted: ${doc._id} action=${doc.action} target=${targetPos} lastPos=${lastPos} score=${score0}`,
    );
    return { ok: true, id: doc._id };
  }
}
