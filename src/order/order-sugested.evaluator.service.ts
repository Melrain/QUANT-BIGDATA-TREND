// src/orders/order-suggested.evaluator.service.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import {
  OrderSuggested,
  OrderSuggestedDocument,
} from '@/infra/mongo/schemas/order-suggested.schema';
import { Bar, BarDocument } from '@/infra/mongo/schemas/bar.schema';
import {
  OrderEval,
  OrderEvalDocument,
} from '@/infra/mongo/schemas/order-eval.schema';

const PERIOD_MS = 5 * 60 * 1000;
const PRICE_METRIC = process.env.PRICE_METRIC || 'mid';

type Dir = 'LONG' | 'SHORT' | 'CLOSE';

@Injectable()
export class OrderSuggestedEvaluatorService {
  private readonly logger = new Logger(OrderSuggestedEvaluatorService.name);

  constructor(
    @InjectModel(OrderSuggested.name)
    private readonly osModel: Model<OrderSuggestedDocument>,
    @InjectModel(Bar.name)
    private readonly barModel: Model<BarDocument>,
    @InjectModel(OrderEval.name)
    private readonly evalModel: Model<OrderEvalDocument>,
  ) {}

  private dirFromAction(action: OrderSuggested['decision']['action']): Dir {
    if (action === 'OPEN_LONG' || action === 'REVERSE_LONG') return 'LONG';
    if (action === 'OPEN_SHORT' || action === 'REVERSE_SHORT') return 'SHORT';
    return 'CLOSE';
  }

  private async getBars(sym: string, fromTs: number, bars: number) {
    const untilTs = fromTs + bars * PERIOD_MS + 1;
    return this.barModel
      .find({ sym, metric: PRICE_METRIC, ts: { $gte: fromTs, $lte: untilTs } })
      .sort({ ts: 1 })
      .lean<Bar[]>()
      .exec();
  }

  private pickPxAt(
    bars: Bar[],
    fromTs: number,
    kBars: number,
  ): number | undefined {
    const target = fromTs + kBars * PERIOD_MS;
    // 找>=target 的第一根
    const row = bars.find((b) => b.ts >= target);
    return row?.val;
  }

  private computeMfeMae(
    bars: Bar[],
    entryPx: number,
    dir: Dir,
    fromTs: number,
    horizonBars: number,
  ) {
    if (dir === 'CLOSE') return { mfe: undefined, mae: undefined };
    const start = fromTs + PERIOD_MS; // 从下一根开始统计
    const end = fromTs + horizonBars * PERIOD_MS + 1;
    const window = bars
      .filter((b) => b.ts >= start && b.ts <= end)
      .map((b) => b.val);
    if (window.length === 0) return { mfe: undefined, mae: undefined };

    if (dir === 'LONG') {
      const best = Math.max(...window);
      const worst = Math.min(...window);
      return { mfe: best - entryPx, mae: worst - entryPx }; // mae 可能为负
    } else {
      // SHORT：收益 = entry - price
      const best = Math.min(...window);
      const worst = Math.max(...window);
      return { mfe: entryPx - best, mae: entryPx - worst }; // mae 可能为负
    }
  }

  /** 评估一条 OPEN/REVERSE：计算未来 kbars 的方向性收益 */
  private evalDirectional(
    dir: Dir,
    entryPx: number,
    px1b?: number,
    px3b?: number,
    px6b?: number,
  ) {
    if (!Number.isFinite(entryPx))
      return { ret_1b: undefined, ret_3b: undefined, ret_6b: undefined };
    const f = dir === 'LONG' ? +1 : dir === 'SHORT' ? -1 : 0;
    const ret_1b = Number.isFinite(px1b!) ? f * (px1b! - entryPx) : undefined;
    const ret_3b = Number.isFinite(px3b!) ? f * (px3b! - entryPx) : undefined;
    const ret_6b = Number.isFinite(px6b!) ? f * (px6b! - entryPx) : undefined;
    return { ret_1b, ret_3b, ret_6b };
  }

  /** 评估 CLOSE：与“若不平仓继续持有”的 3b/6b 对比 */
  private evalCloseBenefit(
    lastPos: 'LONG' | 'SHORT' | 'FLAT' | undefined,
    entryPx: number | undefined,
    px3b?: number,
    px6b?: number,
  ) {
    if (!entryPx || !lastPos || lastPos === 'FLAT')
      return {
        close_gain_vs_hold_3b: undefined,
        close_gain_vs_hold_6b: undefined,
      };
    const f = lastPos === 'LONG' ? +1 : -1;
    // 若不平继续持有的收益
    const hold3 = Number.isFinite(px3b!) ? f * (px3b! - entryPx) : undefined;
    const hold6 = Number.isFinite(px6b!) ? f * (px6b! - entryPx) : undefined;
    // 平仓“收益”我们近似为 0（锁定 entry 时的盈亏）；对比值= 0 - hold
    const close_gain_vs_hold_3b = Number.isFinite(hold3!)
      ? 0 - hold3!
      : undefined;
    const close_gain_vs_hold_6b = Number.isFinite(hold6!)
      ? 0 - hold6!
      : undefined;
    return { close_gain_vs_hold_3b, close_gain_vs_hold_6b };
  }

  /** 评估最近 N 条建议（默认 500） */
  async evaluateRecentForSymbol(sym: string, limit = 500) {
    const orders = await this.osModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(limit)
      .lean<OrderSuggested[]>()
      .exec();

    const ops: AnyBulkWriteOperation<OrderEval>[] = [];

    for (const o of orders) {
      const { ts, decision, price, sym: s } = o as any;
      const action = decision?.action;
      if (!ts || !action) continue;

      const dir = this.dirFromAction(action);
      const entryPx = Number(price?.refPrice ?? NaN);
      const bars = await this.getBars(s, ts, 6); // 拿到 t..t+6b 的价格

      const px_1b = this.pickPxAt(bars, ts, 1);
      const px_3b = this.pickPxAt(bars, ts, 3);
      const px_6b = this.pickPxAt(bars, ts, 6);

      const { ret_1b, ret_3b, ret_6b } = this.evalDirectional(
        dir,
        entryPx,
        px_1b,
        px_3b,
        px_6b,
      );
      const { mfe: mfe_6b, mae: mae_6b } = this.computeMfeMae(
        bars,
        entryPx,
        dir,
        ts,
        6,
      );

      let close_gain_vs_hold_3b: number | undefined;
      let close_gain_vs_hold_6b: number | undefined;
      if (dir === 'CLOSE') {
        const lastPos = o?.decision?.reasons?.lastPos as
          | 'LONG'
          | 'SHORT'
          | 'FLAT'
          | undefined;
        const r = this.evalCloseBenefit(lastPos, entryPx, px_3b, px_6b);
        close_gain_vs_hold_3b = r.close_gain_vs_hold_3b;
        close_gain_vs_hold_6b = r.close_gain_vs_hold_6b;
      }

      const _id = `${s}|${ts}|${action}|${PRICE_METRIC}`;
      ops.push({
        updateOne: {
          filter: { _id },
          update: {
            $set: {
              _id,
              sym: s,
              ts,
              action,
              metric: PRICE_METRIC,
              dir,
              entryPx: Number.isFinite(entryPx) ? entryPx : undefined,
              px_1b,
              px_3b,
              px_6b,
              ret_1b,
              ret_3b,
              ret_6b,
              mfe_6b,
              mae_6b,
              close_gain_vs_hold_3b,
              close_gain_vs_hold_6b,
              createdAt: new Date(),
            } as Partial<OrderEval>,
          },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      await this.evalModel.bulkWrite(ops, { ordered: false });
      this.logger.log(`[OrderEval] ${sym} upserts=${ops.length}`);
    } else {
      this.logger.log(`[OrderEval] ${sym} none to upsert`);
    }

    return ops.length;
  }
}
