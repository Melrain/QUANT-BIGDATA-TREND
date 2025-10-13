/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/collector/writer/collector.writer.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
   * 幂等批量写入
   * - 唯一键：_id = `${sym}|${metric}|${ts}`
   * - 若存在则更新 val（与时间戳），保证回补/重跑可覆盖
   */
  async persist(items: BarLike[]) {
    if (!Array.isArray(items) || items.length === 0) {
      return { written: 0, skippedDup: 0 };
    }

    // 组装 bulk ops
    const ops = items.map((x) => {
      const id = `${x.sym}|${x.metric}|${x.ts}`;
      return {
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              _id: id,
              sym: x.sym,
              metric: x.metric,
              ts: x.ts,
              val: x.val,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    });

    const res = await this.barModel.bulkWrite(ops as any[], {
      ordered: false,
    });

    // 统计：新增 + 修改算 written；未变更算 skipped
    const written =
      (res.upsertedCount ?? 0) +
      // 注意：modifiedCount 在 Mongoose 7 中位于 res.result 兼容层，做多写法兼容
      Number((res as any).modifiedCount ?? (res as any).nModified ?? 0);

    const skippedDup = items.length - written;

    this.logger.log(`Mongo written=${written}, skippedDup=${skippedDup}`);
    return { written, skippedDup };
  }

  /**
   * （可选）写入一条状态快照，便于监控
   */
  // async persistStatus(payload: Record<string, any>) {
  //   await this.statusModel.create({
  //     ...payload,
  //     ts: Date.now(),
  //     createdAt: new Date(),
  //   });
  // }
}
