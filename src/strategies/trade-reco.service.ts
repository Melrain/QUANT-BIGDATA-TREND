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

function deriveSide(score: number, thUp: number, thDn: number): PositionState {
  if (score >= thUp) return 'LONG';
  if (score <= thDn) return 'SHORT';
  return 'FLAT';
}

@Injectable()
export class TradeRecoService {
  private readonly logger = new Logger(TradeRecoService.name);

  // —— 阈值（来自 .env）
  private readonly TH_UP = Number(process.env.TH_UP ?? 0.8);
  private readonly TH_DN = Number(process.env.TH_DN ?? -0.8);
  private readonly TH_CLOSE = Number(process.env.TH_CLOSE ?? 0.15);
  private readonly DEFAULT_NOTIONAL_USDT = Number(
    process.env.DEFAULT_NOTIONAL_USDT ?? 100,
  );

  // —— 收紧 CLOSE 用的开关（来自 .env）
  // 需要连续多少根 |score| <= TH_CLOSE 才允许 CLOSE
  private readonly NEUTRAL_BARS = Number(process.env.NEUTRAL_BARS ?? 3);
  // 是否要求满足最小持仓时间（risk.minHoldMinutes）
  private readonly CLOSE_REQUIRE_MIN_HOLD =
    (process.env.CLOSE_REQUIRE_MIN_HOLD ?? '1') === '1';

  constructor(
    @InjectModel(Signal.name) private readonly sigModel: Model<SignalDocument>,
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  /** 读取上一次已生效的持仓状态（从上一条 reco 推断） */
  private async getLastPos(sym: string): Promise<PositionState> {
    const prev = await this.recoModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!prev) return 'FLAT';
    switch (prev.action) {
      case 'OPEN_LONG':
      case 'REVERSE_LONG':
        return 'LONG';
      case 'OPEN_SHORT':
      case 'REVERSE_SHORT':
        return 'SHORT';
      case 'CLOSE':
        return 'FLAT';
      default:
        return (prev as any).posState ?? 'FLAT';
    }
  }

  /** 最近一次“进入持仓”的 reco.ts（OPEN_* 或 REVERSE_*），没有则 undefined */
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

  /** 从最新 signal 生成（或跳过）一条 trade_reco */
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const sig = await this.sigModel.findOne({ sym }).sort({ ts: -1 }).lean();
    if (!sig) return { ok: false, reason: 'no_signal' };

    // 幂等：该 ts 已存在就跳过
    const _id = `${sym}|${sig.ts}`;
    const exists = await this.recoModel.exists({ _id });
    if (exists) return { ok: false, reason: 'reco_exists' };

    // —— 统一分数来源
    const score = Number(sig.score);
    if (!Number.isFinite(score)) return { ok: false, reason: 'score_nan' };

    // —— 用分数推导方向（唯一真侧）
    const expectedSide = deriveSide(score, this.TH_UP, this.TH_DN);

    // —— 若上游 sig.side 存在，则必须一致；不一致则降级跳过，避免脏 reco
    if (sig.side && sig.side !== expectedSide) {
      this.logger.warn(
        `[Reco] degrade ${sym}@${sig.ts}: sig.side=${sig.side} != expected=${expectedSide}, score=${score}`,
      );
      return { ok: false, reason: 'signal_inconsistent' };
    }

    const side = expectedSide;
    const lastPos = await this.getLastPos(sym);

    // —— 决策规则（收紧 CLOSE：必须 连续K根中性 + 满足最小持仓时间（可选））
    let action:
      | 'OPEN_LONG'
      | 'OPEN_SHORT'
      | 'REVERSE_LONG'
      | 'REVERSE_SHORT'
      | 'CLOSE'
      | 'HOLD'
      | 'SKIP';

    if (lastPos === 'FLAT') {
      if (score >= this.TH_UP && side === 'LONG') action = 'OPEN_LONG';
      else if (score <= this.TH_DN && side === 'SHORT') action = 'OPEN_SHORT';
      else action = 'HOLD';
    } else {
      // 已持仓（LONG 或 SHORT）
      const wantReverseToLong = score >= this.TH_UP && side === 'LONG';
      const wantReverseToShort = score <= this.TH_DN && side === 'SHORT';

      if (lastPos === 'LONG' && wantReverseToShort) {
        action = 'REVERSE_SHORT';
      } else if (lastPos === 'SHORT' && wantReverseToLong) {
        action = 'REVERSE_LONG';
      } else {
        // 进入“是否 CLOSE”的更苛刻判断
        const neutralNow = Math.abs(score) <= this.TH_CLOSE;
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
          action = 'HOLD';
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
      score,
      notionalUSDT: this.DEFAULT_NOTIONAL_USDT,
      degraded: false,
      reasons: {
        lastPos,
        sideFromSignal: side,
        thresholds: { up: this.TH_UP, dn: this.TH_DN, close: this.TH_CLOSE },
        raw: {
          taker_imb: (sig as any).taker_imb,
          oi_chg: (sig as any).oi_chg,
          meta: {
            ...(sig as any).meta,
            neutralBarsRequired: this.NEUTRAL_BARS,
            closeNeedsMinHold: this.CLOSE_REQUIRE_MIN_HOLD,
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
