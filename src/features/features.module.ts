import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MongooseModule } from '@nestjs/mongoose';

import { FeaturesWriter } from './writer/features.writer';

// 需要用到 bars/status 的集合，所以这里不重复注册，直接依赖你已有的 MongoModule 即可
import { MongoModule } from '@/infra/mongo/mongo.module';

// 读取 symbols & bars
import { SymbolRegistry } from '@/collector/registry/symbol.registry';
import { Bar, BarSchema } from '@/infra/mongo/schemas/bar.schema';
import { Feature, FeatureSchema } from '@/infra/mongo/schemas/feature.schema';
import { AggregatorScheduler } from './aggregator/aggregator.scheduler';
import { AggregatorService } from './aggregator/aggregator.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongoModule,
    MongooseModule.forFeature([
      { name: Feature.name, schema: FeatureSchema },
      { name: Bar.name, schema: BarSchema }, // 读 bars
    ]),
  ],
  providers: [
    FeaturesWriter,
    AggregatorService,
    AggregatorScheduler,
    SymbolRegistry, // 若已在别处提供，可以移除
  ],
  exports: [AggregatorService],
})
export class FeaturesModule {}
