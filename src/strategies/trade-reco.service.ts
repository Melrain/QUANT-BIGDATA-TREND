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

  // —— 全局默认阈值（可被每币种覆盖）
  private readonly TH_UP = Number(process.env.TH_UP ?? 0.8);
  private readonly TH_DN = Number(process.env.TH_DN ?? -0.8);
  private readonly TH_CLOSE = Number(process.env.TH_CLOSE ?? 0.15);

  // —— 超距（Hysteresis）：开仓与反手的附加“溢出”要求（越大越稳）
  private readonly HYST_OPEN = Number(process.env.HYSTERESIS_OPEN ?? 0.0);
  private readonly HYST_REV = Number(process.env.HYSTERESIS_REVERSE ?? 0.1);

  // —— CLOSE 防抖：需要连续 K 根处于中性带；可选最小持仓时长
  private readonly NEUTRAL_BARS = Number(process.env.NEUTRAL_BARS ?? 3);
  private readonly CLOSE_REQUIRE_MIN_HOLD =
    (process.env.CLOSE_REQUIRE_MIN_HOLD ?? '1') === '1';

  // —— 冷静期（以 bar 计）：开仓/反手后 N 根内，不允许 CLOSE/REVERSE
  private readonly COOLDOWN_BARS = Math.max(
    0,
    Number(process.env.COOLDOWN_BARS ?? 2),
  );

  // —— 反手频控：最近 1 小时最多反手次数
  private readonly MAX_REVERSES_PER_HOUR = Math.max(
    1,
    Number(process.env.MAX_REVERSES_PER_HOUR ?? 3),
  );

  // —— 下单名义（只是决策文档里带上，真实下单由 order-builder & 执行器决定）
  private readonly DEFAULT_NOTIONAL_USDT = Number(
    process.env.DEFAULT_NOTIONAL_USDT ?? 100,
  );

  // —— 每币种覆盖（JSON 字符串）
  // 例：{"ETH-USDT-SWAP":{"TH_UP":0.85,"TH_DN":-0.85,"TH_CLOSE":0.12,"HYST_OPEN":0.02,"HYST_REV":0.15}}
  private readonly SYMBOL_OVERRIDES: Record<string, any> = (() => {
    try {
      return JSON.parse(process.env.SYMBOL_THRESHOLDS_JSON ?? '{}');
    } catch {
      return {};
    }
  })();

  constructor(
    @InjectModel(Signal.name) private readonly sigModel: Model<SignalDocument>,
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  /** 币种专属阈值/超距（无则回落到全局） */
  private getThresh(sym: string) {
    const o = this.SYMBOL_OVERRIDES[sym] || {};
    const up = Number.isFinite(o.TH_UP) ? Number(o.TH_UP) : this.TH_UP;
    const dn = Number.isFinite(o.TH_DN) ? Number(o.TH_DN) : this.TH_DN;
    const close = Number.isFinite(o.TH_CLOSE)
      ? Number(o.TH_CLOSE)
      : this.TH_CLOSE;
    const hystOpen = Number.isFinite(o.HYST_OPEN)
      ? Number(o.HYST_OPEN)
      : this.HYST_OPEN;
    const hystRev = Number.isFinite(o.HYST_REV)
      ? Number(o.HYST_REV)
      : this.HYST_REV;
    return { up, dn, close, hystOpen, hystRev };
  }

  /** 从上一条 reco 推断仓位（无真实持仓表时的简化法） */
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

  /** 最近一次“进入持仓”的 reco（OPEN_* / REVERSE_*） */
  private async getLastOpenReco(sym: string) {
    return this.recoModel
      .findOne({
        sym,
        action: {
          $in: ['OPEN_LONG', 'OPEN_SHORT', 'REVERSE_LONG', 'REVERSE_SHORT'],
        },
      })
      .sort({ ts: -1 })
      .lean<{ ts: number; action: string }>()
      .exec();
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
      (s) => Math.abs(Number(s?.score ?? NaN)) <= this.getThresh(sym).close,
    );
  }

  /** 最近 60 分钟内的 REVERSE 次数 */
  private async countReverses1h(sym: string, nowTs: number) {
    const oneHourAgo = nowTs - 60 * 60 * 1000;
    return this.recoModel.countDocuments({
      sym,
      ts: { $gt: oneHourAgo, $lte: nowTs },
      action: { $in: ['REVERSE_LONG', 'REVERSE_SHORT'] },
    });
  }

  /** 冷静期是否未到：上次 OPEN/REVERSE 到当前相隔的 bar 数 < COOLDOWN_BARS */
  private inCooldown(lastOpenTs?: number, nowTs?: number) {
    if (!this.COOLDOWN_BARS || !lastOpenTs || !nowTs) return false;
    const bars = Math.floor((nowTs - lastOpenTs) / (5 * 60 * 1000));
    return bars < this.COOLDOWN_BARS;
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

    // —— 阈值/超距（按币种解析）
    const {
      up: TH_UP,
      dn: TH_DN,
      close: TH_CLOSE,
      hystOpen,
      hystRev,
    } = this.getThresh(sym);

    // —— 用分数推导方向（唯一真侧）
    const expectedSide = deriveSide(score, TH_UP, TH_DN);

    // —— 若上游 sig.side 存在，则必须一致；不一致则降级跳过，避免脏 reco
    if (sig.side && sig.side !== expectedSide) {
      this.logger.warn(
        `[Reco] degrade ${sym}@${sig.ts}: sig.side=${sig.side} != expected=${expectedSide}, score=${score}`,
      );
      return { ok: false, reason: 'signal_inconsistent' };
    }

    const side = expectedSide;
    const lastPos = await this.getLastPos(sym);
    const lastOpen = await this.getLastOpenReco(sym);
    const lastOpenTs = lastOpen?.ts;

    // —— “愿望”判定（加入超距）
    const wantOpenLong = score >= TH_UP + hystOpen;
    const wantOpenShort = score <= TH_DN - hystOpen;
    const wantRevToLong = score >= TH_UP + hystRev;
    const wantRevToShort = score <= TH_DN - hystRev;

    // —— 反手频控
    const reverseCnt1h = await this.countReverses1h(sym, sig.ts);
    const reverseBudgetOk = reverseCnt1h < this.MAX_REVERSES_PER_HOUR;

    // —— 决策
    let action:
      | 'OPEN_LONG'
      | 'OPEN_SHORT'
      | 'REVERSE_LONG'
      | 'REVERSE_SHORT'
      | 'CLOSE'
      | 'HOLD' = 'HOLD';

    if (lastPos === 'FLAT') {
      if (wantOpenLong) action = 'OPEN_LONG';
      else if (wantOpenShort) action = 'OPEN_SHORT';
      else action = 'HOLD';
    } else {
      // 已持仓
      const inCool = this.inCooldown(lastOpenTs, sig.ts);

      // 先考虑反手（但冷静期内或频控超限时禁止反手）
      if (!inCool && reverseBudgetOk) {
        if (lastPos === 'LONG' && wantRevToShort) action = 'REVERSE_SHORT';
        else if (lastPos === 'SHORT' && wantRevToLong) action = 'REVERSE_LONG';
      }

      // 若未触发反手，考虑 CLOSE（更苛刻）
      if (!action) {
        const neutralNow = Math.abs(score) <= TH_CLOSE;
        if (neutralNow) {
          const k = Math.max(1, this.NEUTRAL_BARS);
          const neutralOk = await this.hasConsecutiveNeutral(sym, sig.ts, k);

          let holdOk = true;
          if (this.CLOSE_REQUIRE_MIN_HOLD) {
            const minHoldMs =
              Number(process.env.MIN_HOLD_MINUTES ?? 15) * 60 * 1000;
            holdOk = lastOpenTs ? sig.ts - lastOpenTs >= minHoldMs : true;
          }

          // 冷静期命中则不许 CLOSE
          action = neutralOk && holdOk && !inCool ? 'CLOSE' : 'HOLD';
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
        thresholds: { up: TH_UP, dn: TH_DN, close: TH_CLOSE },
        raw: {
          taker_imb: (sig as any).taker_imb,
          oi_chg: (sig as any).oi_chg,
          meta: {
            ...(sig as any).meta,
            hyst_open: hystOpen,
            hyst_rev: hystRev,
            cooldownBars: this.COOLDOWN_BARS,
            reverseCnt1h,
            reverseBudget: this.MAX_REVERSES_PER_HOUR,
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
