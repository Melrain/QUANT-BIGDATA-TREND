/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, AnyBulkWriteOperation } from 'mongoose';

import { Signal, SignalDocument } from '@/signal/schemas/signal.schema';
import { Bar, BarDocument } from '@/infra/mongo/schemas/bar.schema';
import {
  SignalEval,
  SignalEvalDocument,
} from '@/infra/mongo/schemas/signal-eval.schema';

const PERIOD_MS = 5 * 60 * 1000;

@Injectable()
export class SignalEvaluatorService {
  private readonly logger = new Logger(SignalEvaluatorService.name);
  private readonly PRICE_METRIC = (
    process.env.EVAL_PRICE_METRIC ?? 'last'
  ).trim();
  private readonly HORIZONS_BARS = (process.env.EVAL_HORIZONS ?? '1,3,12')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  constructor(
    @InjectModel(Signal.name)
    private readonly signalModel: Model<SignalDocument>,
    @InjectModel(Bar.name)
    private readonly barModel: Model<BarDocument>,
    @InjectModel(SignalEval.name)
    private readonly evalModel: Model<SignalEvalDocument>,
  ) {}

  private async getPx(sym: string, ts: number): Promise<number | undefined> {
    const doc = await this.barModel
      .findOne({ sym, metric: this.PRICE_METRIC, ts })
      .lean<{ val: number }>();
    return Number.isFinite(doc?.val) ? Number(doc!.val) : undefined;
  }

  private async evalOne(
    sym: string,
    ts: number,
    side: 'LONG' | 'SHORT' | 'FLAT',
  ): Promise<Record<string, number>> {
    const entry = await this.getPx(sym, ts);
    if (!Number.isFinite(entry)) return {};
    const res: Record<string, number> = {};
    for (const h of this.HORIZONS_BARS) {
      const fut = await this.getPx(sym, ts + h * PERIOD_MS);
      if (!Number.isFinite(fut)) continue;
      const ret =
        side === 'LONG'
          ? (fut! - entry!) / entry!
          : side === 'SHORT'
            ? (entry! - fut!) / entry!
            : 0;
      res[`ret_${h}b`] = ret;
    }
    return res;
  }

  async evaluateRecentForSymbols(syms: string[], limit = 500) {
    const out: Record<string, number> = {};
    for (const s of syms) {
      out[s] = await this.evaluateRecentForSymbol(s, limit);
    }
    return out;
  }

  async evaluateRecentForSymbol(sym: string, limit = 500) {
    const sigs = await this.signalModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(limit)
      .lean<Signal[]>()
      .exec();

    const ops: AnyBulkWriteOperation<SignalEval>[] = [];

    for (const s of sigs) {
      const { ts, side } = s as any;
      if (!ts || !side) continue;
      const returns = await this.evalOne(sym, ts, side);
      if (!Object.keys(returns).length) continue;

      const _id = `${sym}|${ts}|${this.PRICE_METRIC}`;
      ops.push({
        updateOne: {
          filter: { _id },
          update: {
            $set: {
              _id,
              sym,
              ts,
              metric: this.PRICE_METRIC,
              side,
              returns,
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length > 0) await this.evalModel.bulkWrite(ops, { ordered: false });
    this.logger.log(`[Eval] ${sym} evaluated ${ops.length} signals`);
    return ops.length;
  }
}
