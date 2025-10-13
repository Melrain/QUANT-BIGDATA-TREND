/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Feature, FeatureDocument } from '@/infra/mongo/schemas/feature.schema';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class FeaturesWriter {
  private readonly logger = new Logger(FeaturesWriter.name);

  constructor(
    @InjectModel(Feature.name)
    private readonly featureModel: Model<FeatureDocument>,
  ) {}

  async upsertMany(
    rows: Array<Omit<Feature, '_id' | 'createdAt' | 'updatedAt'>>,
  ) {
    if (!rows?.length) return { written: 0, skipped: 0 };

    const ops = rows.map((r) => ({
      updateOne: {
        filter: { _id: `${r.sym}|${r.ts}` },
        update: {
          $set: { ...r, _id: `${r.sym}|${r.ts}`, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }));

    const res = await this.featureModel.bulkWrite(ops as any[], {
      ordered: false,
    });
    const written =
      (res.upsertedCount ?? 0) +
      Number((res as any).modifiedCount ?? (res as any).nModified ?? 0);
    const skipped = rows.length - written;

    this.logger.log(`Features upsert: written=${written}, skipped=${skipped}`);
    return { written, skipped };
  }
}
