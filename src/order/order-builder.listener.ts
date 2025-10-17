/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/order/listeners/order-builder.listener.ts
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { OrderBuilderService } from './order-builder.service';

type RecoUpdatedEvent = {
  seq?: number | string;
  symbols?: string[];
  ok?: number;
  skip?: number;
  fail?: number;
  reason?: string;
  elapsedMs?: number;
};

type RecoNewEvent = {
  sym: string;
  ts: number;
  action?: string; // 可选，仅记录
  score?: number; // 可选，仅记录
};

@Injectable()
export class OrderBuilderListener {
  private readonly logger = new Logger(OrderBuilderListener.name);

  // 受控并发；订单建议构建是轻量的，2~4 足够
  private readonly CONCURRENCY = Math.max(
    1,
    Number(process.env.ORDER_BUILD_CONCURRENCY ?? 3),
  );

  private runningBatch = false;

  constructor(
    private readonly builder: OrderBuilderService,
    private readonly events: EventEmitter2,
  ) {}

  /** 简单并发执行器 */
  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
  ): Promise<(T | undefined)[]> {
    const results: (T | undefined)[] = new Array(tasks.length);
    let cursor = 0;

    const workers = new Array(Math.min(limit, tasks.length))
      .fill(0)
      .map(async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= tasks.length) break;
          try {
            results[idx] = await tasks[idx]();
          } catch (err: any) {
            this.logger.warn(
              `order task#${idx} failed: ${err?.message || String(err)}`,
            );
            results[idx] = undefined;
          }
        }
      });

    await Promise.all(workers);
    return results;
  }

  /** 批量：reco.updated → 为这些 symbols 产出/更新 order_suggested */
  @OnEvent('reco.updated', { async: true })
  async onRecoUpdated(evt: RecoUpdatedEvent) {
    const syms = (evt?.symbols || []).filter(Boolean);
    if (!syms.length) {
      this.logger.warn('[order] reco.updated received but no symbols.');
      return;
    }
    if (this.runningBatch) {
      this.logger.warn('[order] previous batch still running, skip.');
      return;
    }
    this.runningBatch = true;

    const t0 = Date.now();
    let ok = 0,
      skip = 0,
      fail = 0;

    try {
      const tasks = syms.map((sym) => async () => {
        try {
          const r = await this.builder.buildOne(sym);
          if (r.ok) {
            ok++;
            // 可选：每条成功时也广播单条事件
            this.events.emit('order.suggested.new', { sym, id: r.id });
          } else {
            skip++;
            this.logger.debug(`[order] - ${sym} skip: ${r.reason}`);
          }
        } catch (e: any) {
          fail++;
          this.logger.error(`[order] ✗ ${sym}: ${e?.message || e}`);
        }
      });

      await this.runWithConcurrency(tasks, this.CONCURRENCY);

      const elapsedMs = Date.now() - t0;
      this.logger.log(
        `[order] batch from reco seq=${evt?.seq ?? '-'} ok=${ok} skip=${skip} fail=${fail} elapsed=${elapsedMs}ms`,
      );

      // 广播给评估/执行层
      this.events.emit('order.suggested.updated', {
        seq: Date.now(),
        fromSeq: evt?.seq,
        ok,
        skip,
        fail,
        symbols: syms,
        elapsedMs,
      });
      this.logger.log(`[order] batch event emitted.`);
    } finally {
      this.runningBatch = false;
    }
  }

  /** 单条：reco.new（如你在 reco 层选择也发这个事件） */
  @OnEvent('reco.new', { async: true })
  async onRecoNew(evt: RecoNewEvent) {
    const sym = evt?.sym;
    if (!sym) return;
    try {
      const r = await this.builder.buildOne(sym);
      if (r.ok) {
        this.logger.log(`[order] single ✓ ${sym} id=${r.id}`);
        this.events.emit('order.suggested.new', { sym, id: r.id });
      } else {
        this.logger.debug(`[order] single - ${sym} skip: ${r.reason}`);
      }
    } catch (e: any) {
      this.logger.error(`[order] single ✗ ${sym}: ${e?.message || e}`);
    }
  }
}
