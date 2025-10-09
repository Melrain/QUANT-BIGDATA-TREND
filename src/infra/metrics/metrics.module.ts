import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Module({
  imports: [],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
