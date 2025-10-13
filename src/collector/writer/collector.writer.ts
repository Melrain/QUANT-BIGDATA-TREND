/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/collector/writer/collector.writer.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { BarLike } from '../aligner/collector.aligner';
import { Bar, BarDocument } from '@/infra/mongo/schemas/bar.schema';
import { Status, StatusDocument } from '@/infra/mongo/schemas/status.schema';

@Injectable()
export class CollectorWriter {
  private readonly logger = new Logger(CollectorWriter.name);

  constructor(
    @InjectModel(Bar.name) private readonly barModel: Model<BarDocument>,
    @InjectModel(Status.name)
    private readonly statusModel: Model<StatusDocument>,
  ) {}

  /**
   * 幂等批量写入 Bar
   * 唯一键: _id = `${sym}|${metric}|${ts}`
   * 若存在则更新 val（覆盖旧值）
   */
  async persist(items: BarLike[]) {
    if (!Array.isArray(items) || items.length === 0) {
      return { written: 0, skippedDup: 0 };
    }

    const ops = items.map((x) => ({
      updateOne: {
        filter: { _id: `${x.sym}|${x.metric}|${x.ts}` },
        update: {
          $set: {
            _id: `${x.sym}|${x.metric}|${x.ts}`,
            sym: x.sym,
            metric: x.metric,
            ts: x.ts,
            val: x.val,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }));

    const res = await this.barModel.bulkWrite(ops as any[], { ordered: false });

    const written =
      (res.upsertedCount ?? 0) +
      Number((res as any).modifiedCount ?? (res as any).nModified ?? 0);
    const skippedDup = items.length - written;

    this.logger.log(`Mongo written=${written}, skippedDup=${skippedDup}`);
    return { written, skippedDup };
  }

  /**
   * 写入一条状态快照，用于监控 Collector 运行状态
   */
  async persistStatus(payload: {
    sym?: string;
    ts?: number;
    written?: number;
    skippedDup?: number;
    durations?: Record<string, number>;
    errorMap?: Record<string, string>;
    degraded?: boolean;
  }) {
    const ts = payload.ts ?? Date.now();
    const _id = payload.sym ? `${payload.sym}|${ts}` : String(ts);
    await this.statusModel.updateOne(
      { _id },
      {
        $set: {
          _id,
          sym: payload.sym,
          ts,
          written: payload.written ?? 0,
          skippedDup: payload.skippedDup ?? 0,
          durations: payload.durations ?? {},
          errorMap: payload.errorMap ?? {},
          degraded: !!payload.degraded,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    this.logger.log(
      `Status persisted: sym=${payload.sym ?? '-'} written=${payload.written ?? 0}`,
    );
  }
}
