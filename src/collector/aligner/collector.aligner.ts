import { Injectable } from '@nestjs/common';
import { ParsedMetric } from '../parser/collector.parser';

@Injectable()
export class CollectorAligner {
  private readonly barMs = 5 * 60 * 1000; // 5m bar

  /** floor 对齐并过滤未闭合 bar */
  alignAndFilter(rows: ParsedMetric[]): ParsedMetric[] {
    const now = Date.now();
    const cutoff = now - this.barMs; // 已闭合 bar 的最大时间
    return rows
      .map((r) => ({
        ...r,
        ts: Math.floor(r.ts / this.barMs) * this.barMs, // floor 对齐
      }))
      .filter((r) => r.ts <= cutoff);
  }
}
