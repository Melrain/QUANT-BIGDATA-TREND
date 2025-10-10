/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';

import { MongoService } from '@/infra/mongo/mongo.service';
import { AlignedMetric } from '../aligner/collector.aligner';

@Injectable()
export class CollectorWriter {
  private readonly logger = new Logger(CollectorWriter.name);

  constructor(private readonly mongo: MongoService) {}

  async persist(rows: AlignedMetric[]) {
    if (!rows.length) return { written: 0, skippedDup: 0 };

    // 写 bars
    const { written, skipped } = await this.mongo.bulkUpsertBars(rows);

    // 更新 lastTs 状态
    const latestByKey = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.metric}:${r.sym}`;
      if (!latestByKey.has(key) || r.ts > latestByKey.get(key)!)
        latestByKey.set(key, r.ts);
    }
    for (const [key, ts] of latestByKey) {
      const [metric, sym] = key.split(':');
      await this.mongo.updateStatus(metric, sym, ts);
    }

    this.logger.log(`Mongo written=${written}, skippedDup=${skipped}`);
    return { written, skippedDup: skipped };
  }
}
