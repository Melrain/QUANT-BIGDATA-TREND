/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { AggregatorService } from '../aggregator/aggregator.service';
import { FeaturesWriter } from '../writer/features.writer';

// 事件负载类型（与 collector 发出的保持一致）
type CollectorBatchDonePayload = {
  batchSeq: number; // 当批次唯一序号（建议用时间戳或自增）
  startedAt: number; // 批次开始时间
  finishedAt: number; // 批次结束时间
  symbols: string[]; // 本批处理的所有标的
  meta?: Record<string, any>;
};

@Injectable()
export class FeaturesListener {
  private readonly logger = new Logger(FeaturesListener.name);

  // 简易去重缓存（防止重复处理同一批次事件）
  private readonly handled = new Map<number, number>(); // batchSeq -> ts
  private readonly handledTtlMs = 10 * 60 * 1000; // 10min

  constructor(
    private readonly aggregator: AggregatorService,
    private readonly writer: FeaturesWriter,
    private readonly events: EventEmitter2,
  ) {}

  // —— 监听 collector 批次完成
  @OnEvent('collector.batchDone', { async: true })
  async onCollectorBatchDone(payload: CollectorBatchDonePayload) {
    this.logger.log('collector.batchDone event received');
    const { batchSeq, symbols } = payload || {};
    if (!Array.isArray(symbols) || symbols.length === 0) {
      this.logger.warn('[features] empty symbols in collector.batchDone, skip');
      return;
    }

    // 去重：同一 batchSeq 只处理一次
    if (this.handled.has(batchSeq)) {
      this.logger.warn(`[features] batchSeq=${batchSeq} already handled, skip`);
      return;
    }
    this.gcHandled();
    this.handled.set(batchSeq, Date.now());

    this.logger.log(
      `[features] collector.batchDone received: seq=${batchSeq} symbols=${symbols.length}`,
    );

    let totalWritten = 0;
    let totalSkipped = 0;
    const perSymbol: Record<
      string,
      { written: number; skipped: number; err?: string }
    > = {};

    // 顺序处理（更稳、更易追踪；如需更快可改并发但要控速）
    for (const sym of symbols) {
      try {
        // 1) 计算/聚合当批次需要的特征
        const rows = await this.aggregator.buildForSymbol(sym); // 返回 Feature[]（无 _id/时间戳由 writer 填）
        // 2) 批量 upsert
        const { written, skipped } = await this.writer.upsertMany(rows as any);
        perSymbol[sym] = { written, skipped };
        totalWritten += written;
        totalSkipped += skipped;
        this.logger.log(
          `[features] ${sym} upsert done written=${written} skipped=${skipped}`,
        );
      } catch (e: any) {
        const msg = e?.message || String(e);
        perSymbol[sym] = { written: 0, skipped: 0, err: msg };
        this.logger.error(`[features] ${sym} failed: ${msg}`);
      }
    }

    // 3) 广播给下游（signal 层）
    this.events.emit('features.updated', {
      batchSeq,
      symbols,
      totals: { written: totalWritten, skipped: totalSkipped },
      perSymbol,
      finishedAt: Date.now(),
    });

    this.logger.log(
      `[features] emitted features.updated seq=${batchSeq} totals: written=${totalWritten} skipped=${totalSkipped}`,
    );
  }

  // 简单 GC，防止 handled Map 无限增长
  private gcHandled() {
    const now = Date.now();
    for (const [seq, ts] of this.handled.entries()) {
      if (now - ts > this.handledTtlMs) this.handled.delete(seq);
    }
  }
}
