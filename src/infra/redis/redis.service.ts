/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleDestroy, OnModuleInit {
  private client: Redis;
  private readonly logger = new Logger(RedisService.name);
  private prefix: string;
  private ttlSeconds: number;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('redis.url')!;
    const ttlDays = this.config.get<number>('redis.ttlDays', 7);
    this.prefix = this.config.get<string>('redis.namespace') ?? 'quant';
    this.ttlSeconds = ttlDays * 86400;

    const options: RedisOptions = {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 5000,
    };
    this.client = new Redis(url, options);
    this.logger.log(
      `✅ Redis client ready: ${this.prefix} (ttl=${ttlDays} days)`,
    );
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  /** 统一加上命名空间前缀 */
  private k(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  // ========== 常用操作封装 ==========

  async hset(ns: string, field: string, value: any) {
    const key = this.k(ns);
    await this.client.hset(
      key,
      field,
      typeof value === 'object' ? JSON.stringify(value) : value,
    );
  }

  async hget(ns: string, field: string): Promise<string | null> {
    const key = this.k(ns);
    return this.client.hget(key, field);
  }

  async hgetall(ns: string): Promise<Record<string, string>> {
    const key = this.k(ns);
    return this.client.hgetall(key);
  }

  async zadd(ns: string, score: number, member: string): Promise<number> {
    const key = this.k(ns);
    return this.client.zadd(key, score.toString(), member);
  }

  async zrange(ns: string, start: number, end: number, withScores = false) {
    const key = this.k(ns);
    return withScores
      ? this.client.zrange(key, start, end, 'WITHSCORES')
      : this.client.zrange(key, start, end);
  }

  async set(ns: string, value: string, ttlSeconds?: number) {
    const key = this.k(ns);
    await this.client.set(key, value, 'EX', ttlSeconds ?? this.ttlSeconds);
  }

  async get(ns: string): Promise<string | null> {
    const key = this.k(ns);
    return this.client.get(key);
  }

  async del(ns: string) {
    const key = this.k(ns);
    await this.client.del(key);
  }

  async exists(ns: string): Promise<boolean> {
    const key = this.k(ns);
    return (await this.client.exists(key)) === 1;
  }

  /** 批量删除某个前缀的所有key */
  async flushPrefix(prefix: string) {
    const pattern = this.k(`${prefix}*`);
    const stream = this.client.scanStream({ match: pattern });
    for await (const keys of stream) {
      if (keys.length) await this.client.del(...keys);
    }
  }
}
