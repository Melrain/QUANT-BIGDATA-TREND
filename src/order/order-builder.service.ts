/* eslint-disable @typescript-eslint/no-unsafe-argument */
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
    private readonly okx: OkxTradeService, // 仅用于行情/规格/换算；不真实下单
  ) {}

  /** 从最新的 trade_reco 生成“order_suggested”落库（仅 BUY/SELL） */
  async buildOne(
    sym: string,
  ): Promise<{ ok: boolean; reason?: string; id?: string }> {
    const reco = await this.recoModel
      .findOne({ sym })
      .sort({ ts: -1 })
      .lean<TradeReco>()
      .exec();
    if (!reco) return { ok: false, reason: 'no_reco' };

    if (!['BUY', 'SELL'].includes(reco.action as any)) {
      return { ok: false, reason: 'noop_action' };
    }

    const instId = sym; // 直接用合约名
    const clOrdId = `SIG|${sym}|${reco.ts}`;

    // —— 方向映射（建议单）
    const dir =
      reco.action === 'BUY'
        ? { side: 'buy' as const, posSide: 'long' as const, reduceOnly: false }
        : {
            side: 'sell' as const,
            posSide: 'short' as const,
            reduceOnly: false,
          };

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

    // —— ticker 快照（展示/对账）
    const snap = await this.okx.getTickerSnapshot(instId);
    if (!snap) {
      this.logger.warn(`[OrderBuilder] skip ${sym}: no ticker snapshot`);
      return { ok: false, reason: 'no_ticker' };
    }
    const bid = Number(snap.bid),
      ask = Number(snap.ask),
      last = Number(snap.last);

    // —— signal 展示层：照抄 reco 结论
    const signalSide =
      (reco.reasons?.sideFromSignal as 'LONG' | 'SHORT' | 'FLAT') ?? 'FLAT';
    const signalMeta = reco.reasons?.raw?.meta;

    const doc: OrderSuggested = {
      _id: `${sym}|${reco.ts}`,
      sym,
      ts: reco.ts,
      signal: { side: signalSide, score: reco.score, meta: signalMeta },
      decision: {
        action: reco.action, // BUY / SELL
        reasons: reco.reasons,
        degraded: !!reco.degraded,
      },
      recoId: reco._id,

      instId,
      tdMode: this.tdMode,
      ordType: 'market',
      side: dir.side,
      posSide: dir.posSide,
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
        notes:
          'BUY/SELL only; size = notional / (refPrice * ctVal), aligned to lotSz/minSz',
      },
    };

    await this.orderModel.updateOne(
      { _id: doc._id },
      { $set: doc },
      { upsert: true },
    );

    this.logger.log(
      `OrderSuggested upserted: ${doc._id} action=${reco.action} side=${doc.side} sz=${doc.sizeSz}`,
    );
    return { ok: true, id: doc._id };
  }
}
