/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Injectable, Logger } from '@nestjs/common';

/**
 * 兼容 OKX BigData 两种返回形态：
 *  1) 对象：{ ts, buyVol, sellVol, oi, vol, longShortRatio, ... }
 *  2) 数组：[ ts, v1, v2, ... ] —— 各接口列位固定但文档不完全一致
 *
 * 统一输出 { sym, metric, ts(ms), val(number) }
 */

@Injectable()
export class CollectorParser {
  private readonly logger = new Logger(CollectorParser.name);

  private num(x: any): number {
    const v = Number(x);
    return Number.isFinite(v) ? v : NaN;
  }
  private asMs(x: any): number {
    const n = this.num(x);
    if (!Number.isFinite(n)) return NaN;
    // OKX ts 通常已是 ms；若误给秒，这里做个兜底放大
    return n < 1e12 ? n * 1000 : n;
  }
  private make(sym: string, metric: string, ts: any, val: any) {
    const t = this.asMs(ts);
    const v = this.num(val);
    if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
    return { sym, metric, ts: t, val: v };
  }

  // ========== 1) taker-volume-contract ==========
  // 形态 A: { ts, buyVol, sellVol, ... }
  // 形态 B: [ ts, buyVol, sellVol, ... ]
  parseTakerVolumeContract(raw: any[], sym: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec1 = this.make(sym, 'taker_vol_buy', row[0], row[1]);
        const rec2 = this.make(sym, 'taker_vol_sell', row[0], row[2]);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      } else {
        const ts = row?.ts ?? row?.timestamp ?? row?.[0];
        const buy = row?.buyVol ?? row?.[1];
        const sell = row?.sellVol ?? row?.[2];
        const rec1 = this.make(sym, 'taker_vol_buy', ts, buy);
        const rec2 = this.make(sym, 'taker_vol_sell', ts, sell);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      }
    }
    return out;
  }

  // ========== 2) contracts/open-interest-volume ==========
  // A: { ts, oi, vol }  B: [ ts, oi, vol ]
  parseOpenInterestVolumeContracts(raw: any[], sym: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec1 = this.make(sym, 'open_interest', row[0], row[1]);
        const rec2 = this.make(sym, 'contracts_volume', row[0], row[2]);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      } else {
        const ts = row?.ts ?? row?.[0];
        const oi = row?.oi ?? row?.[1];
        const vol = row?.vol ?? row?.[2];
        const rec1 = this.make(sym, 'open_interest', ts, oi);
        const rec2 = this.make(sym, 'contracts_volume', ts, vol);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      }
    }
    return out;
  }

  // ========== 3) 全体账户 多空账户比（合约/普通口径） ==========
  // A: { ts, longShortRatio }  B: [ ts, longShortRatio ]
  parseLongShortAllAccounts(raw: any[], sym: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec = this.make(sym, 'longshort_all_acc', row[0], row[1]);
        if (rec) out.push(rec);
      } else {
        const ts = row?.ts ?? row?.[0];
        const r = row?.longShortRatio ?? row?.ratio ?? row?.[1];
        const rec = this.make(sym, 'longshort_all_acc', ts, r);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // ========== 4) 精英 Top Trader —— 账户数比 ==========
  // A: { ts, longShortRatio }  B: [ ts, longShortRatio ]
  parseLongShortEliteAccountTopTrader(raw: any[], sym: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec = this.make(sym, 'longshort_elite_acc', row[0], row[1]);
        if (rec) out.push(rec);
      } else {
        const ts = row?.ts ?? row?.[0];
        const r = row?.longShortRatio ?? row?.ratio ?? row?.[1];
        const rec = this.make(sym, 'longshort_elite_acc', ts, r);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // ========== 5) 精英 Top Trader —— 持仓量比 ==========
  // A: { ts, longShortRatio }  B: [ ts, longShortRatio ]
  parseLongShortElitePositionTopTrader(raw: any[], sym: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec = this.make(sym, 'longshort_elite_pos', row[0], row[1]);
        if (rec) out.push(rec);
      } else {
        const ts = row?.ts ?? row?.[0];
        const r = row?.longShortRatio ?? row?.ratio ?? row?.[1];
        const rec = this.make(sym, 'longshort_elite_pos', ts, r);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // ========== 6) （可选）现货 taker-volume ==========
  // A: { ts, buyVol, sellVol }  B: [ ts, buyVol, sellVol ]
  parseTakerVolumeSpot(raw: any[], ccy: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec1 = this.make(ccy, 'taker_vol_buy_spot', row[0], row[1]);
        const rec2 = this.make(ccy, 'taker_vol_sell_spot', row[0], row[2]);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      } else {
        const ts = row?.ts ?? row?.[0];
        const buy = row?.buyVol ?? row?.[1];
        const sell = row?.sellVol ?? row?.[2];
        const rec1 = this.make(ccy, 'taker_vol_buy_spot', ts, buy);
        const rec2 = this.make(ccy, 'taker_vol_sell_spot', ts, sell);
        if (rec1) out.push(rec1);
        if (rec2) out.push(rec2);
      }
    }
    return out;
  }

  // ========== 7) （可选）margin/loan-ratio ==========
  // A: { ts, ratio }  B: [ ts, ratio ]
  parseMarginLoanRatio(raw: any[], ccy: string) {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const rec = this.make(ccy, 'margin_loan_ratio', row[0], row[1]);
        if (rec) out.push(rec);
      } else {
        const ts = row?.ts ?? row?.[0];
        const r = row?.ratio ?? row?.[1];
        const rec = this.make(ccy, 'margin_loan_ratio', ts, r);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // 可按需补：option 系列若也返回数组形态，照此模式兼容
}
