/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

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

  private readonly TH_UP = Number(process.env.TH_UP ?? 0.8);
  private readonly TH_DN = Number(process.env.TH_DN ?? -0.8);
  private readonly TH_CLOSE = Number(process.env.TH_CLOSE ?? 0.15);
  private readonly DEFAULT_NOTIONAL_USDT = Number(
    process.env.DEFAULT_NOTIONAL_USDT ?? 100,
  );

  constructor(
    @InjectModel(Signal.name) private readonly sigModel: Model<SignalDocument>,
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
  ) {}

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

    // —— 统一分数来源（唯一真分）
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

    // —— 决策规则（收紧 CLOSE 条件：仅在已持仓且 |score| <= TH_CLOSE）
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
    } else if (lastPos === 'LONG') {
      if (score <= this.TH_DN && side === 'SHORT') action = 'REVERSE_SHORT';
      else if (Math.abs(score) <= this.TH_CLOSE) action = 'CLOSE';
      else action = 'HOLD';
    } else {
      // lastPos === 'SHORT'
      if (score >= this.TH_UP && side === 'LONG') action = 'REVERSE_LONG';
      else if (Math.abs(score) <= this.TH_CLOSE) action = 'CLOSE';
      else action = 'HOLD';
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
        sideFromSignal: side, // ✅ 只用我们推导的一致值
        thresholds: { up: this.TH_UP, dn: this.TH_DN, close: this.TH_CLOSE },
        raw: {
          taker_imb: sig.taker_imb,
          oi_chg: sig.oi_chg,
          meta: sig.meta, // 仅附带，不参与后续方向判定
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
