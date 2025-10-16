/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  TradeReco,
  TradeRecoDocument,
} from '@/infra/mongo/schemas/trade-reco.schema';
import {
  OrderSuggested,
  OrderSuggestedDocument,
} from '@/infra/mongo/schemas/order-suggested.schema';
import { OkxTradeService } from '@/okx-trade/okx-trade.service';

type TdMode = 'cross' | 'isolated';
type PosSide = 'long' | 'short';
type LastPos = 'LONG' | 'SHORT' | 'FLAT';

@Injectable()
export class OrderBuilderService {
  private readonly logger = new Logger(OrderBuilderService.name);

  private readonly tdMode: TdMode = (
    process.env.OKX_TDMODE || 'cross'
  ).toLowerCase() as TdMode;
  private readonly leverage = Number(process.env.DEFAULT_LEVERAGE || 5);

  constructor(
    @InjectModel(TradeReco.name)
    private readonly recoModel: Model<TradeRecoDocument>,
    @InjectModel(OrderSuggested.name)
    private readonly orderModel: Model<OrderSuggestedDocument>,
    private readonly okx: OkxTradeService,
  ) {}

  /** 根据 lastPos 返回 CLOSE 所需的 side 与 posSide */
  private closeDir(lastPos: LastPos): {
    side: 'buy' | 'sell';
    posSide?: PosSide;
  } {
    // 平多：卖；平空：买；若无历史，默认卖（保守，不建议触发）
    if (lastPos === 'LONG') return { side: 'sell', posSide: 'long' };
    if (lastPos === 'SHORT') return { side: 'buy', posSide: 'short' };
    return { side: 'sell', posSide: undefined };
  }

  /** 从最新的 trade_recos 生成“可直接下单”的建议文档 */
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; reason?: string; id?: string }> {
    const reco = await this.recoModel
      .findOne({ sym })
      .sort({ ts: -1 })
      .lean<TradeReco>()
      .exec();

    if (!reco) return { ok: false, reason: 'no_reco' };

    // 只在需要动作时生成
    if (
      ![
        'OPEN_LONG',
        'OPEN_SHORT',
        'REVERSE_LONG',
        'REVERSE_SHORT',
        'CLOSE',
      ].includes(reco.action)
    ) {
      return { ok: false, reason: 'noop_action' };
    }

    // 用 sym 直接作为 instId；OkxTradeService 内部会 normalize
    const instId = sym;

    // 更稳的 client 订单号：带上毫秒时间戳，提升幂等可溯性
    const clOrdId = `SIG|${sym}|${reco.ts}|${Date.now()}`;

    // —— 方向映射（含 long_short 模式可用的 posSide）
    const lastPos = (reco?.reasons?.lastPos as LastPos) ?? 'FLAT';
    const dir = (() => {
      if (reco.action === 'OPEN_LONG' || reco.action === 'REVERSE_LONG') {
        return {
          side: 'buy' as const,
          posSide: 'long' as const,
          reduceOnly: false,
        };
      }
      if (reco.action === 'OPEN_SHORT' || reco.action === 'REVERSE_SHORT') {
        return {
          side: 'sell' as const,
          posSide: 'short' as const,
          reduceOnly: false,
        };
      }
      if (reco.action === 'CLOSE') {
        const { side, posSide } = this.closeDir(lastPos);
        return { side, posSide, reduceOnly: true } as const;
      }
      // fallback（理论到不了这里）
      return { side: 'buy' as const, posSide: undefined, reduceOnly: false };
    })();

    // —— 价格与规格（名义→张数）
    const refPrice = await this.okx.getRefPrice(instId);
    if (!refPrice || !(refPrice > 0))
      return { ok: false, reason: 'no_ref_price' };

    const instSpec = await this.okx.getInstrumentSpec(instId);
    const sizeSz = await this.okx.notionalToSize(
      instId,
      Number(reco.notionalUSDT),
      refPrice,
    );

    // —— ticker 快照（用于展示与回测对账）
    const snap = await this.okx.getTickerSnapshot(instId);
    if (!snap) {
      this.logger.warn(`[OrderBuilder] skip ${sym}: no ticker snapshot`);
      return { ok: false, reason: 'no_ticker' };
    }
    const bid = Number(snap.bid),
      ask = Number(snap.ask),
      last = Number(snap.last);

    // —— signal 展示层：**只照抄 reco 的结论**
    const signalSide =
      (reco.reasons?.sideFromSignal as 'LONG' | 'SHORT' | 'FLAT') ?? 'FLAT';
    const signalMeta = reco.reasons?.raw?.meta;

    const doc: OrderSuggested = {
      _id: `${sym}|${reco.ts}`,
      sym,
      ts: reco.ts,
      signal: { side: signalSide, score: reco.score, meta: signalMeta },
      decision: {
        action: reco.action,
        reasons: reco.reasons,
        degraded: !!reco.degraded,
      },
      recoId: reco._id,

      instId,
      tdMode: this.tdMode,
      ordType: 'market',
      side: dir.side,
      posSide: dir.posSide, // ✅ long_short_mode 下 executor 可直接使用
      leverage: this.leverage,
      sizeSz,
      reduceOnly: dir.reduceOnly,
      clOrdId,

      price: {
        refPrice,
        last: Number.isFinite(last) ? last : undefined,
        bid: Number.isFinite(bid) ? bid : undefined,
        ask: Number.isFinite(ask) ? ask : undefined,
        source: 'market/ticker',
        fetchedAt: snap.ts ?? Date.now(),
      },
      notionalUSDT: Number(reco.notionalUSDT),
      refPrice,
      instSpec,

      risk: reco.risk,
      guards: {
        statusDegraded: !!reco.degraded,
        inCooldown: reco?.reasons?.inCooldown === true,
        holdEnough: reco?.reasons?.holdEnough !== false,
        underMaxGross: reco?.reasons?.underMaxGross !== false,
      },
      explain: {
        map: 'reco→order',
        notes: 'size = notional / (refPrice * ctVal), aligned to lotSz/minSz',
      },
    };

    await this.orderModel.updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true },
    );

    this.logger.log(
      `OrderSuggested upserted: ${doc._id} action=${reco.action} lastPos=${lastPos} side=${doc.side} posSide=${doc.posSide ?? '-'} sz=${doc.sizeSz}`,
    );
    return { ok: true, id: doc._id };
  }
}
