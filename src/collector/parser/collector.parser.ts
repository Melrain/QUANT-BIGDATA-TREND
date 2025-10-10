/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';

export interface ParsedMetric {
  metric: string;
  sym: string;
  ts: number;
  val: number;
}

@Injectable()
export class CollectorParser {
  /** 把 OKX taker-volume 数据解析为标准化结构 */
  parseTakerVolume(raw: any[], sym: string): ParsedMetric[] {
    const parsed: ParsedMetric[] = [];
    for (const row of raw) {
      const [ts, buyVol, sellVol] = row;
      const tsNum = Number(ts);
      if (!tsNum || isNaN(tsNum)) continue;

      parsed.push({
        metric: 'taker_vol_buy',
        sym,
        ts: tsNum,
        val: Number(buyVol),
      });
      parsed.push({
        metric: 'taker_vol_sell',
        sym,
        ts: tsNum,
        val: Number(sellVol),
      });
    }
    return parsed;
  }

  /** OI & Contracts Volume */
  parseOpenInterestVolume(raw: any[], sym: string) {
    const out: { metric: string; sym: string; ts: number; val: number }[] = [];
    for (const row of raw) {
      // 兼容数组或对象
      const ts = Number(Array.isArray(row) ? row[0] : row.ts);
      const oi = Number(
        Array.isArray(row) ? row[1] : (row.openInterest ?? row.oi),
      );
      const vol = Number(Array.isArray(row) ? row[2] : (row.volume ?? row.vol));
      if (!ts || isNaN(oi) || isNaN(vol)) continue;
      out.push({ metric: 'open_interest', sym, ts, val: oi });
      out.push({ metric: 'contracts_volume', sym, ts, val: vol });
    }
    return out;
  }

  /** 全体账户长短比（Account/Position） */
  parseLongShortAll(raw: any[], sym: string) {
    const out: { metric: string; sym: string; ts: number; val: number }[] = [];
    for (const row of raw) {
      const ts = Number(Array.isArray(row) ? row[0] : row.ts);
      // 有的返回就是 ratio，有的可能返回 long/short 两列，这里做两手准备：
      const acc = Number(
        Array.isArray(row)
          ? row[1]
          : (row.longShortAccountRatio ?? row.accountRatio ?? row.acc),
      );
      const pos = Number(
        Array.isArray(row)
          ? row[2]
          : (row.longShortPositionRatio ?? row.positionRatio ?? row.pos),
      );
      if (!ts || isNaN(acc)) continue; // pos 可能缺；若缺就只存 acc
      out.push({ metric: 'longshort_all_acc', sym, ts, val: acc });
      if (!isNaN(pos))
        out.push({ metric: 'longshort_all_pos', sym, ts, val: pos });
    }
    return out;
  }

  /** 精英长短比（Top Trader） */
  parseLongShortElite(raw: any[], sym: string) {
    const out: { metric: string; sym: string; ts: number; val: number }[] = [];
    for (const row of raw) {
      const ts = Number(Array.isArray(row) ? row[0] : row.ts);
      const acc = Number(
        Array.isArray(row)
          ? row[1]
          : (row.topTraderAccountRatio ?? row.accountRatio ?? row.acc),
      );
      const pos = Number(
        Array.isArray(row)
          ? row[2]
          : (row.topTraderPositionRatio ?? row.positionRatio ?? row.pos),
      );
      if (!ts || isNaN(acc)) continue;
      out.push({ metric: 'longshort_elite_acc', sym, ts, val: acc });
      if (!isNaN(pos))
        out.push({ metric: 'longshort_elite_pos', sym, ts, val: pos });
    }
    return out;
  }
}
