import { Global, Module } from '@nestjs/common';
import { HttpClientService } from './http/http-client.service';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';

@Global()
@Module({
  imports: [RedisModule, MetricsModule],
  providers: [HttpClientService],
  exports: [HttpClientService, RedisModule, MetricsModule],
})
export class InfraModule {}
