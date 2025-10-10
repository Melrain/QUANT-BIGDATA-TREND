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
}
