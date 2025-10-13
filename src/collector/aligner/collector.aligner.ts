// src/collector/aligner/collector.aligner.ts
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable } from '@nestjs/common';

export type BarLike = {
  sym: string; // 'BTC-USDT-SWAP'
  metric: string; // e.g. 'open_interest'
  ts: number; // ms
  val: number; // numeric value
};

function parsePeriodToMs(p: string | undefined): number {
  const s = (p ?? '5m').trim().toLowerCase();
  const m = /^(\d+)\s*([smhd])$/.exec(s);
  if (!m) return 5 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

@Injectable()
export class CollectorAligner {
  private readonly periodMs = parsePeriodToMs(process.env.OKX_RUBIK_PERIOD);
  // 哪些 metric 允许为 0（都允许），但不允许为负
  // 如果有人后续要允许负值（比如净流入可为负），可在此白名单。
  private readonly allowNegative = new Set<string>([
    // 目前全是“量/比”类，全部不应为负；留接口以备扩展
  ]);

  /**
   * 对齐 + 质量过滤 + 去重 + 可选截尾
   */
  alignAndFilter(items: BarLike[], opts?: { winsor?: number }) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const winsor = Number(opts?.winsor ?? 0); // 0 ~ 0.49（建议 <0.1）
    const aligned: BarLike[] = [];

    // 1) 对齐 & 基础过滤
    for (const it of items) {
      if (!it) continue;
      const sym = String(it.sym ?? '').trim();
      const metric = String(it.metric ?? '').trim();
      const tsNum = Number(it.ts);
      const valNum = Number(it.val);

      if (!sym || !metric) continue;
      if (!Number.isFinite(tsNum) || tsNum <= 0) continue;
      if (!Number.isFinite(valNum)) continue;

      if (!this.allowNegative.has(metric) && valNum < 0) continue;

      // 对齐到周期边界（向下取整）
      const tsAligned = Math.floor(tsNum / this.periodMs) * this.periodMs;

      aligned.push({ sym, metric, ts: tsAligned, val: valNum });
    }

    if (aligned.length === 0) return [];

    // 2) 截尾（按 metric 分组）
    let processed = aligned;
    if (winsor > 0 && winsor < 0.49) {
      const byMetric = new Map<string, BarLike[]>();
      for (const x of aligned) {
        const key = `${x.metric}`;
        if (!byMetric.has(key)) byMetric.set(key, []);
        byMetric.get(key)!.push(x);
      }
      const out: BarLike[] = [];
      for (const [, arr] of byMetric) {
        const vals = arr
          .map((a) => a.val)
          .slice()
          .sort((a, b) => a - b);
        const loIdx = Math.floor(vals.length * winsor);
        const hiIdx = Math.ceil(vals.length * (1 - winsor)) - 1;
        const lo = vals[Math.max(0, Math.min(vals.length - 1, loIdx))];
        const hi = vals[Math.max(0, Math.min(vals.length - 1, hiIdx))];
        for (const a of arr) {
          const v = Math.min(Math.max(a.val, lo), hi);
          out.push({ ...a, val: v });
        }
      }
      processed = out;
    }

    // 3) 去重（最后一条为准；OKX 若重叠拉取以最新覆盖）
    const uniq = new Map<string, BarLike>();
    for (const x of processed) {
      const key = `${x.sym}|${x.metric}|${x.ts}`;
      uniq.set(key, x);
    }

    // 4) 输出按 ts 升序（可选）
    return Array.from(uniq.values()).sort((a, b) =>
      a.ts === b.ts ? a.metric.localeCompare(b.metric) : a.ts - b.ts,
    );
  }
}
