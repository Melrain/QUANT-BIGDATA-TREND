import { Module } from '@nestjs/common';
import { SymbolRegistry } from './registry/symbol.registry';
import { CollectorFetcher } from './fetcher/collector.fetcher';
import { ProbeController } from './probe.controller';
import { CollectorScheduler } from './scheduler/collector.scheduler';
import { CollectorParser } from './parser/collector.parser';
import { CollectorAligner } from './aligner/collector.aligner';
import { CollectorWriter } from './writer/collector.writer';
import { MongoModule } from '@/infra/mongo/mongo.module';

@Module({
  imports: [MongoModule],
  controllers: [ProbeController],
  providers: [
    CollectorWriter,
    SymbolRegistry,
    CollectorParser,
    CollectorAligner,
    CollectorFetcher,
    CollectorScheduler,
  ],
  exports: [
    CollectorWriter,
    CollectorFetcher,
    CollectorAligner,
    CollectorParser,
    CollectorScheduler,
    SymbolRegistry,
  ],
})
export class CollectorModule {}
