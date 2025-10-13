/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Status } from './schemas/status.schema';
import { Bar } from './schemas/bar.schema';

@Injectable()
export class MongoService {
  private readonly logger = new Logger(MongoService.name);

  constructor(
    @InjectModel(Bar.name) private readonly barModel: Model<Bar>,
    @InjectModel(Status.name) private readonly statusModel: Model<Status>,
  ) {}

  /** 批量 upsert bars（去重） */
  async bulkUpsertBars(
    rows: { metric: string; sym: string; ts: number; val: number; raw?: any }[],
  ) {
    if (!rows.length) return { written: 0, skipped: 0 };

    const ops = rows.map((r) => ({
      updateOne: {
        filter: { _id: `${r.metric}:${r.sym}:${r.ts}` },
        update: {
          $set: {
            metric: r.metric,
            sym: r.sym,
            ts: new Date(r.ts),
            val: r.val,
            raw: r.raw ?? undefined,
          },
        },
        upsert: true,
      },
    }));

    const res = await this.barModel.bulkWrite(ops, { ordered: false });
    const written = res.upsertedCount + res.modifiedCount;
    return { written, skipped: rows.length - written };
  }

  /** 更新 lastTs 状态 */
  async updateStatus(metric: string, sym: string, lastTs: number) {
    const doc = await this.statusModel.findOneAndUpdate(
      { metric, sym },
      { lastTs: new Date(lastTs), updatedAt: new Date() },
      { upsert: true, new: true },
    );
    return doc;
  }

  async getStatus() {
    return this.statusModel.find().lean();
  }
}
