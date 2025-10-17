/* eslint-disable @typescript-eslint/no-unused-vars */
import { OkxTradeService } from '@/okx-trade/okx-trade.service';
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, AnyBulkWriteOperation } from 'mongoose';
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
const LOOKAHEAD_BARS = [1, 3, 6];

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
    private readonly okxMarket: OkxTradeService, // 用于即时拉K线
  ) {}

  private dirFromAction(action: string): Dir {
    if (action === 'OPEN_LONG' || action === 'REVERSE_LONG') return 'LONG';
    if (action === 'OPEN_SHORT' || action === 'REVERSE_SHORT') return 'SHORT';
    return 'CLOSE';
  }

  /** 按需确保 5m bars 存在 */
  private async ensureBars(sym: string, fromTs: number, bars: number) {
    const needTs = LOOKAHEAD_BARS.map((n) => fromTs + n * PERIOD_MS);
    const existing = await this.barModel
      .find({ sym, metric: PRICE_METRIC, ts: { $in: needTs } })
      .lean()
      .exec();
    const existingTs = new Set(existing.map((b) => b.ts));

    const missingTs = needTs.filter((t) => !existingTs.has(t));
    if (missingTs.length === 0) return;

    const from = Math.min(...missingTs);
    const to = Math.max(...missingTs) + PERIOD_MS;
    this.logger.debug(
      `[Backfill] ${sym} missing ${missingTs.length} bars (${new Date(
        from,
      ).toISOString()}~${new Date(to).toISOString()})`,
    );

    try {
      const klines = await this.okxMarket.fetchCandles5m(sym, from, to);
      if (klines.length === 0) return;

      const docs: Bar[] = klines.map((k) => ({
        _id: `${sym}|${PRICE_METRIC}|${k.ts}`,
        sym,
        metric: PRICE_METRIC,
        ts: k.ts,
        val: (k.high + k.low) / 2, // mid价
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      if (docs.length)
        await this.barModel.bulkWrite(
          docs.map((d) => ({
            updateOne: {
              filter: { _id: d._id },
              update: { $set: d },
              upsert: true,
            },
          })),
          { ordered: false },
        );

      this.logger.log(
        `[Backfill] ${sym} inserted/updated ${docs.length} bars for eval`,
      );
    } catch (e: any) {
      this.logger.warn(
        `[Backfill] ${sym} fetchCandles error: ${e?.message || e}`,
      );
    }
  }

  private async getBars(sym: string, fromTs: number, bars: number) {
    const untilTs = fromTs + bars * PERIOD_MS + PERIOD_MS;
    return this.barModel
      .find({ sym, metric: PRICE_METRIC, ts: { $gte: fromTs, $lte: untilTs } })
      .sort({ ts: 1 })
      .lean<Bar[]>()
      .exec();
  }

  private async evaluateOne(o: OrderSuggested) {
    const { ts, decision, price, sym } = o as any;
    const action = decision?.action;
    if (!ts || !action) return;

    const dir = this.dirFromAction(action);
    const entryPx = Number(price?.refPrice ?? NaN);
    if (!Number.isFinite(entryPx)) return;

    const bars = await this.getBars(sym, ts, 6);
    if (!bars.length) return;

    const px_1b = this.pickPxAt(bars, ts, 1);
    const px_3b = this.pickPxAt(bars, ts, 3);
    const px_6b = this.pickPxAt(bars, ts, 6);

    const f = dir === 'LONG' ? +1 : dir === 'SHORT' ? -1 : 0;
    const ret_1b = Number.isFinite(px_1b)
      ? f * ((px_1b! - entryPx) / entryPx) * 100
      : undefined;
    const ret_3b = Number.isFinite(px_3b)
      ? f * ((px_3b! - entryPx) / entryPx) * 100
      : undefined;
    const ret_6b = Number.isFinite(px_6b)
      ? f * ((px_6b! - entryPx) / entryPx) * 100
      : undefined;

    const { mfe, mae } = this.computeMfeMae(bars, entryPx, dir, ts, 6);

    const _id = `${sym}|${ts}|${action}|${PRICE_METRIC}`;
    const complete_n = ret_6b !== undefined ? 6 : ret_3b !== undefined ? 3 : 1;

    await this.evalModel.updateOne(
      { _id },
      {
        $set: {
          _id,
          sym,
          ts,
          action,
          metric: PRICE_METRIC,
          dir,
          entryPx,
          px_1b,
          px_3b,
          px_6b,
          ret_1b,
          ret_3b,
          ret_6b,
          mfe_6b: mfe,
          mae_6b: mae,
          complete_n,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  private pickPxAt(bars: Bar[], fromTs: number, kBars: number) {
    const target = fromTs + kBars * PERIOD_MS;
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
    const end = fromTs + horizonBars * PERIOD_MS + 1;
    const window = bars
      .filter((b) => b.ts > fromTs && b.ts <= end)
      .map((b) => b.val);
    if (window.length === 0) return { mfe: undefined, mae: undefined };

    const returns = window.map((px) =>
      dir === 'LONG'
        ? ((px - entryPx) / entryPx) * 100
        : ((entryPx - px) / entryPx) * 100,
    );
    return {
      mfe: Math.max(...returns),
      mae: Math.min(...returns),
    };
  }

  /** 主逻辑：评估所有 ordersuggested */
  async evaluateAll() {
    const orders = await this.osModel
      .find()
      .sort({ ts: 1 })
      .lean<OrderSuggested[]>()
      .exec();

    const ops: AnyBulkWriteOperation<OrderEval>[] = [];
    let ok = 0,
      skip = 0;

    for (const o of orders) {
      const { ts, decision, price, sym } = o as any;
      const action = decision?.action;
      if (!ts || !action) continue;

      const dir = this.dirFromAction(action);
      const entryPx = Number(price?.refPrice ?? NaN);
      if (!Number.isFinite(entryPx)) continue;

      // 确保未来bars存在
      await this.ensureBars(sym, ts, 6);
      const bars = await this.getBars(sym, ts, 6);
      if (bars.length === 0) {
        skip++;
        continue;
      }

      // 计算未来价格
      const px_1b = this.pickPxAt(bars, ts, 1);
      const px_3b = this.pickPxAt(bars, ts, 3);
      const px_6b = this.pickPxAt(bars, ts, 6);

      if (!px_1b && !px_3b && !px_6b) {
        skip++;
        continue;
      }

      const f = dir === 'LONG' ? +1 : dir === 'SHORT' ? -1 : 0;
      const ret_1b = Number.isFinite(px_1b)
        ? f * ((px_1b! - entryPx) / entryPx) * 100
        : undefined;
      const ret_3b = Number.isFinite(px_3b)
        ? f * ((px_3b! - entryPx) / entryPx) * 100
        : undefined;
      const ret_6b = Number.isFinite(px_6b)
        ? f * ((px_6b! - entryPx) / entryPx) * 100
        : undefined;

      const { mfe, mae } = this.computeMfeMae(bars, entryPx, dir, ts, 6);

      const _id = `${sym}|${ts}|${action}|${PRICE_METRIC}`;
      const complete_n =
        ret_6b !== undefined ? 6 : ret_3b !== undefined ? 3 : 1;

      ops.push({
        updateOne: {
          filter: { _id },
          update: {
            $set: {
              _id,
              sym,
              ts,
              action,
              metric: PRICE_METRIC,
              dir,
              entryPx,
              px_1b,
              px_3b,
              px_6b,
              ret_1b,
              ret_3b,
              ret_6b,
              mfe_6b: mfe,
              mae_6b: mae,
              complete_n,
              updatedAt: new Date(),
            } as Partial<OrderEval>,
          },
          upsert: true,
        },
      });
      ok++;
    }

    if (ops.length) await this.evalModel.bulkWrite(ops, { ordered: false });

    this.logger.log(
      `[OrderEval] upserts=${ops.length}, ok=${ok}, skip=${skip}`,
    );
  }

  /** 保留旧接口：评估某个 symbol 最近 limit 条 */
  async evaluateRecentForSymbol(sym: string, limit = 500) {
    const orders = await this.osModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(limit)
      .lean<OrderSuggested[]>()
      .exec();

    for (const o of orders) {
      const { ts } = o as any;
      if (!ts) continue;
      await this.ensureBars(sym, ts, 6);
      await this.evaluateOne(o);
    }
  }
}
