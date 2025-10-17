/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
import { OkxTradeService } from '@/okx-trade/okx-trade.service';

const PERIOD_MS = 5 * 60 * 1000;
const PRICE_METRIC = process.env.PRICE_METRIC || 'mid';
const LOOKAHEAD_BARS = [1, 3, 6];

type Dir = 'LONG' | 'SHORT' | 'NONE';

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
    private readonly okxMarket: OkxTradeService, // 用于拉K线
  ) {}

  /** 根据 reco.action => LONG / SHORT / NONE */
  private dirFromAction(action: string): Dir {
    if (action === 'BUY') return 'LONG';
    if (action === 'SELL') return 'SHORT';
    return 'NONE';
  }

  /** 确保未来bars存在，否则从 OKX 拉取补齐 */
  private async ensureBars(sym: string, fromTs: number) {
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
      `[EvalBackfill] ${sym} missing ${missingTs.length} bars ${new Date(
        from,
      ).toISOString()}~${new Date(to).toISOString()}`,
    );

    try {
      const klines = await this.okxMarket.fetchCandles5m(sym, from, to);
      if (!klines.length) return;

      const ops = klines.map((k) => ({
        updateOne: {
          filter: { _id: `${sym}|${PRICE_METRIC}|${k.ts}` },
          update: {
            $set: {
              sym,
              metric: PRICE_METRIC,
              ts: k.ts,
              val: (k.high + k.low) / 2,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      }));

      await this.barModel.bulkWrite(ops, { ordered: false });
      this.logger.log(
        `[EvalBackfill] ${sym} inserted/updated ${ops.length} bars.`,
      );
    } catch (e: any) {
      this.logger.warn(
        `[EvalBackfill] ${sym} fetchCandles error: ${e?.message || e}`,
      );
    }
  }

  /** 取指定时间后的bars */
  private async getBars(sym: string, fromTs: number, bars: number) {
    const untilTs = fromTs + bars * PERIOD_MS + PERIOD_MS;
    return this.barModel
      .find({ sym, metric: PRICE_METRIC, ts: { $gte: fromTs, $lte: untilTs } })
      .sort({ ts: 1 })
      .lean<Bar[]>()
      .exec();
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
    if (dir === 'NONE') return { mfe: undefined, mae: undefined };
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

  /** 评估单条 OrderSuggested */
  private async evaluateOne(o: OrderSuggested) {
    const { ts, decision, price, sym } = o as any;
    const action = decision?.action;
    if (!ts || !action) return;

    const dir = this.dirFromAction(action);
    if (dir === 'NONE') return; // HOLD 不评估

    const entryPx = Number(price?.refPrice ?? NaN);
    if (!Number.isFinite(entryPx)) return;

    await this.ensureBars(sym, ts);
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
    const complete_n = ret_6b ? 6 : ret_3b ? 3 : 1;
    const latencyMs = Date.now() - ts;

    const doc: Partial<OrderEval> = {
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
      latencyMs,
    };

    await this.evalModel.updateOne({ _id }, { $set: doc }, { upsert: true });
    this.logger.debug(
      `[Eval] ${sym}@${ts} dir=${dir} ret_1b=${ret_1b?.toFixed?.(2)} ret_6b=${ret_6b?.toFixed?.(2)}`,
    );
  }

  /** 批量评估全部 ordersuggested（自动回溯+补数据） */
  async evaluateAll() {
    const orders = await this.osModel
      .find()
      .sort({ ts: 1 })
      .lean<OrderSuggested[]>()
      .exec();
    let ok = 0,
      skip = 0;
    const ops: AnyBulkWriteOperation<OrderEval>[] = [];

    for (const o of orders) {
      const { sym, ts, decision, price } = o as any;
      const action = decision?.action;
      if (!sym || !ts || !action) continue;

      const dir = this.dirFromAction(action);
      if (dir === 'NONE') {
        skip++;
        continue;
      }

      const entryPx = Number(price?.refPrice ?? NaN);
      if (!Number.isFinite(entryPx)) {
        skip++;
        continue;
      }

      await this.ensureBars(sym, ts);
      const bars = await this.getBars(sym, ts, 6);
      if (!bars.length) {
        skip++;
        continue;
      }

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
      const complete_n = ret_6b ? 6 : ret_3b ? 3 : 1;
      const latencyMs = Date.now() - ts;

      const _id = `${sym}|${ts}|${action}|${PRICE_METRIC}`;
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
              latencyMs,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      });
      ok++;
    }

    if (ops.length) await this.evalModel.bulkWrite(ops, { ordered: false });
    this.logger.log(
      `[OrderEval] evaluated=${ok}, skip=${skip}, upserts=${ops.length}`,
    );
  }

  /** 评估单个 symbol 最近 N 条 */
  async evaluateRecentForSymbol(sym: string, limit = 200) {
    const orders = await this.osModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(limit)
      .lean<OrderSuggested[]>()
      .exec();

    for (const o of orders.reverse()) {
      await this.evaluateOne(o);
    }
    this.logger.log(`[OrderEval] ${sym} recent=${orders.length} evaluated`);
  }
}
