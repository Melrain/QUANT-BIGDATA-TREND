import { Module } from '@nestjs/common';
import { SymbolRegistry } from './registry/symbol.registry';
import { CollectorFetcher } from './fetcher/collector.fetcher';
import { ProbeController } from './probe.controller';
import { CollectorScheduler } from './scheduler/collector.scheduler';
import { CollectorParser } from './parser/collector.parser';
import { CollectorAligner } from './aligner/collector.aligner';

@Module({
  imports: [],
  controllers: [ProbeController],
  providers: [
    SymbolRegistry,
    CollectorParser,
    CollectorAligner,
    CollectorFetcher,
    CollectorScheduler,
  ],
  exports: [],
})
export class CollectorModule {}
