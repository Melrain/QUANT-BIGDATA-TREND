/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Bar, BarDocument } from '@/infra/mongo/schemas/bar.schema';
import { FeaturesWriter } from '../writer/features.writer';

type Metric =
  | 'taker_vol_buy'
  | 'taker_vol_sell'
  | 'open_interest'
  | 'contracts_volume'
  | 'longshort_all_acc'
  | 'longshort_elite_acc'
  | 'longshort_elite_pos';

const PERIOD_MS = 5 * 60 * 1000;
const NEED: Metric[] = [
  'taker_vol_buy',
  'taker_vol_sell',
  'open_interest',
  'contracts_volume',
  'longshort_all_acc',
  'longshort_elite_acc',
  'longshort_elite_pos',
];

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);

  constructor(
    @InjectModel(Bar.name) private readonly barModel: Model<BarDocument>,
    private readonly writer: FeaturesWriter,
  ) {}

  private align5m(ts: number) {
    return Math.floor(ts / PERIOD_MS) * PERIOD_MS;
  }

  private z(series: number[]) {
    if (!series.length) return NaN;
    const mu = series.reduce((a, b) => a + b, 0) / series.length;
    const varc = series.reduce((s, x) => s + (x - mu) ** 2, 0) / series.length;
    const sd = Math.sqrt(varc);
    if (!Number.isFinite(sd) || sd === 0) return 0;
    return (series[series.length - 1] - mu) / sd;
  }

  private async loadBars(sym: string, lookbackMin: number) {
    const since = Date.now() - lookbackMin * 60 * 1000;
    const rows = await this.barModel
      .find({ sym, metric: { $in: NEED }, ts: { $gte: since } })
      .sort({ ts: 1 })
      .lean()
      .exec();
    return rows as Array<{
      sym: string;
      metric: Metric;
      ts: number;
      val: number;
    }>;
  }

  /** 取最近 lastK 个对齐 ts，逐个生成特征（带 LOCF 容错） */
  async aggregateRecent(
    sym: string,
    opts: { lastK: number; allowCarryMs: number } = {
      lastK: 4,
      allowCarryMs: 10 * 60 * 1000,
    },
  ) {
    const lookbackMin = 24 * 60;
    const rows = await this.loadBars(sym, lookbackMin);
    if (!rows.length) return { written: 0, skipped: 0 };

    // metric -> (ts -> val)
    const m2 = new Map<Metric, Map<number, number>>();
    for (const m of NEED) m2.set(m, new Map());
    for (const r of rows) m2.get(r.metric)!.set(this.align5m(r.ts), r.val);

    // 全部对齐的 ts 升序
    const tsAll = Array.from(new Set(rows.map((r) => this.align5m(r.ts)))).sort(
      (a, b) => a - b,
    );
    const targets = tsAll.slice(-opts.lastK); // 最近 K 个档

    const out: Array<{
      sym: string;
      ts: number;
      taker_imb?: number;
      oi_chg?: number;
      vol_z_24h?: number;
      ls_all_z_24h?: number;
      ls_eacc_z_24h?: number;
      ls_epos_z_24h?: number;
      score_24h?: number;
    }> = [];

    const takeSeries = (m: Metric, uptoTs: number, minutes: number) => {
      const sinceTs = uptoTs - minutes * 60 * 1000 + PERIOD_MS;
      const mmap = m2.get(m)!;
      return tsAll
        .filter((t) => t >= sinceTs && t <= uptoTs && mmap.has(t))
        .map((t) => mmap.get(t)!);
    };

    const carry = (m: Metric, ts: number, allowCarryMs: number) => {
      // 找最近的历史值，但不能早于 ts-allowCarryMs
      const minTs = ts - allowCarryMs;
      for (let t = ts; t >= minTs; t -= PERIOD_MS) {
        const v = m2.get(m)!.get(t);
        if (v !== undefined) return v;
      }
      return undefined;
    };

    for (const ts of targets) {
      // 取当前/上一档的核心量
      const buy =
        m2.get('taker_vol_buy')!.get(ts) ??
        carry('taker_vol_buy', ts, opts.allowCarryMs);
      const sell =
        m2.get('taker_vol_sell')!.get(ts) ??
        carry('taker_vol_sell', ts, opts.allowCarryMs);
      const oiNow =
        m2.get('open_interest')!.get(ts) ??
        carry('open_interest', ts, opts.allowCarryMs);
      const oiPrev = m2.get('open_interest')!.get(ts - PERIOD_MS);

      // 基础特征
      const eps = 1e-9;
      const taker_imb =
        buy !== undefined && sell !== undefined
          ? (buy - sell) / Math.max(buy + sell, eps)
          : undefined;
      const oi_chg =
        oiNow !== undefined && oiPrev !== undefined && Math.abs(oiPrev) > 0
          ? oiNow / oiPrev - 1
          : undefined;

      // Z 分数（24h）
      const vol_z_24h = this.z(takeSeries('contracts_volume', ts, 24 * 60));
      const ls_all_z_24h = this.z(takeSeries('longshort_all_acc', ts, 24 * 60));
      const ls_eacc_z_24h = this.z(
        takeSeries('longshort_elite_acc', ts, 24 * 60),
      );
      const ls_epos_z_24h = this.z(
        takeSeries('longshort_elite_pos', ts, 24 * 60),
      );

      const parts: number[] = [];
      if (Number.isFinite(taker_imb as number))
        parts.push((taker_imb as number) * 1.0);
      if (Number.isFinite(oi_chg as number))
        parts.push((oi_chg as number) * 0.5);
      if (Number.isFinite(vol_z_24h)) parts.push(vol_z_24h * 0.25);
      if (Number.isFinite(ls_all_z_24h)) parts.push(ls_all_z_24h * 0.25);
      if (Number.isFinite(ls_eacc_z_24h)) parts.push(ls_eacc_z_24h * 0.25);
      if (Number.isFinite(ls_epos_z_24h)) parts.push(ls_epos_z_24h * 0.25);
      const score_24h = parts.length
        ? parts.reduce((a, b) => a + b, 0)
        : undefined;

      // 过滤全 undefined
      const hasAny = [
        taker_imb,
        oi_chg,
        vol_z_24h,
        ls_all_z_24h,
        ls_eacc_z_24h,
        ls_epos_z_24h,
        score_24h,
      ].some((v) => typeof v === 'number' && Number.isFinite(v));

      if (hasAny) {
        out.push({
          sym,
          ts,
          taker_imb,
          oi_chg,
          vol_z_24h,
          ls_all_z_24h,
          ls_eacc_z_24h,
          ls_epos_z_24h,
          score_24h,
        });
      }
    }

    if (!out.length) return { written: 0, skipped: targets.length };
    return this.writer.upsertMany(out as any);
  }
}
