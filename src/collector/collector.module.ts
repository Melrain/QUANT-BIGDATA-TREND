import { Module } from '@nestjs/common';
import { SymbolRegistry } from './registry/symbol.registry';
import { CollectorFetcher } from './fetcher/collector.fetcher';
import { ProbeController } from './probe.controller';
import { CollectorScheduler } from './scheduler/collector.scheduler';

@Module({
  imports: [],
  controllers: [ProbeController],
  providers: [SymbolRegistry, CollectorFetcher, CollectorScheduler],
  exports: [],
})
export class CollectorModule {}
