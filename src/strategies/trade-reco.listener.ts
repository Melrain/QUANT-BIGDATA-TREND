/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/strategies/listeners/trade-reco.listener.ts
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { TradeRecoService } from './trade-reco.service';

type SignalsUpdatedEvent = {
  seq?: number | string;
  symbols?: string[];
  // 可选：补充一些统计字段，不影响本监听器工作
  ok?: number;
  skip?: number;
  window?: { from?: number; to?: number };
};

type SignalNewEvent = {
  sym: string;
  ts: number;
  side?: 'LONG' | 'SHORT' | 'FLAT';
  score?: number;
};

@Injectable()
export class TradeRecoListener {
  private readonly logger = new Logger(TradeRecoListener.name);

  // 可选：控制并发；Reco 逻辑通常轻量，默认 2~4 足够
  private readonly CONCURRENCY = Math.max(
    1,
    Number(process.env.RECO_CONCURRENCY ?? 3),
  );

  // 防重入（signals.updated 可能很频繁）
  private runningBatch = false;

  constructor(
    private readonly svc: TradeRecoService,
    private readonly events: EventEmitter2,
  ) {}

  /** 简单并发执行器：把一组 async 任务以固定并发跑完 */
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
              `reco task#${idx} failed: ${err?.message || String(err)}`,
            );
            results[idx] = undefined;
          }
        }
      });

    await Promise.all(workers);
    return results;
  }

  /**
   * 批量：上游 features → signals 完成后会发 signals.updated（建议携带 symbols）
   * 我们对这些符号逐一产出 reco。
   */
  @OnEvent('signals.updated', { async: true })
  async onSignalsUpdated(evt: SignalsUpdatedEvent) {
    const syms = (evt?.symbols || []).filter(Boolean);
    if (!syms.length) {
      this.logger.warn('[reco] signals.updated received but no symbols.');
      return;
    }

    if (this.runningBatch) {
      this.logger.warn('[reco] previous batch still running, skip this one.');
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
          const r = await this.svc.buildOne(sym);
          if (r.ok) ok++;
          else skip++;
        } catch (e: any) {
          fail++;
          this.logger.error(`[reco] ${sym} error: ${e?.message || e}`);
        }
      });

      // 受控并发
      await this.runWithConcurrency(tasks, this.CONCURRENCY);

      this.logger.log(
        `[reco] batch seq=${evt?.seq ?? '-'} result ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - t0}ms`,
      );

      // 广播给下游（order-builder 等）
      this.events.emit('reco.updated', {
        seq: Date.now(),
        fromSeq: evt?.seq,
        ok,
        skip,
        fail,
        symbols: syms,
        elapsedMs: Date.now() - t0,
      });
      this.logger.log(`[reco] batch event emitted.`);
    } finally {
      this.runningBatch = false;
    }
  }

  /**
   * 单条：若你也在 SignalsService 中对每条新信号 emit('signal.new', {...})，
   * 这里可以快速响应某个符号的最新信号，实时更新 reco（幂等）。
   */
  @OnEvent('signal.new', { async: true })
  async onSignalNew(evt: SignalNewEvent) {
    const sym = evt?.sym;
    if (!sym) return;

    try {
      const r = await this.svc.buildOne(sym);
      if (r.ok) {
        this.logger.log(`[reco] single ✓ ${sym} id=${r.id}`);
        this.events.emit('reco.updated', {
          seq: Date.now(),
          symbols: [sym],
          ok: 1,
          skip: 0,
          fail: 0,
          reason: 'single',
        });
      } else {
        this.logger.debug(`[reco] single - ${sym} skip: ${r.reason}`);
      }
    } catch (e: any) {
      this.logger.error(`[reco] single ✗ ${sym}: ${e?.message || e}`);
      this.events.emit('reco.updated', {
        seq: Date.now(),
        symbols: [sym],
        ok: 0,
        skip: 0,
        fail: 1,
        reason: 'error',
      });
    }
  }
}
