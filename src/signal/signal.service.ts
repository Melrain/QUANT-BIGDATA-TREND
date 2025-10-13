/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Signal, SignalDocument } from './schemas/signal.schema';
import { Feature, FeatureDocument } from '@/infra/mongo/schemas/feature.schema';
// import { OkxTradeService } from '@/trade/okx-trade.service';

const PERIOD_MS = 5 * 60 * 1000;

@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  private readonly TH_UP = Number(process.env.SIGNAL_TH_UP ?? 0.8); // 上穿阈值
  private readonly TH_DN = Number(process.env.SIGNAL_TH_DN ?? -0.8); // 下穿阈值
  private readonly DRY_RUN = (process.env.DRY_RUN ?? '1') === '1';

  constructor(
    @InjectModel(Feature.name)
    private readonly featureModel: Model<FeatureDocument>,
    @InjectModel(Signal.name)
    private readonly signalModel: Model<SignalDocument>,
    // private readonly trade: OkxTradeService,
  ) {}

  private align5m(ts: number) {
    return Math.floor(ts / PERIOD_MS) * PERIOD_MS;
  }

  async evaluateOnce(sym: string) {
    // 取最近两个 5m feature
    const feats = await this.featureModel
      .find({ sym })
      .sort({ ts: -1 })
      .limit(2)
      .lean()
      .exec();

    if (feats.length === 0) return { made: 0, side: 'FLAT' as const };

    const f0 = feats[0]; // 最新
    const f1 = feats[1]; // 上一档

    const score0 = Number(f0.score_24h ?? NaN);
    const score1 = Number(f1?.score_24h ?? NaN);

    // 简单穿越逻辑
    let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
    if (Number.isFinite(score0) && Number.isFinite(score1)) {
      if (score1 < this.TH_UP && score0 >= this.TH_UP)
        side = 'LONG'; // 上穿
      else if (score1 > this.TH_DN && score0 <= this.TH_DN)
        side = 'SHORT'; // 下穿
      else side = 'FLAT';
    }

    const ts = this.align5m(f0.ts);
    const _id = `${sym}|${ts}`;

    await this.signalModel.updateOne(
      { _id },
      {
        $set: {
          _id,
          sym,
          ts,
          side,
          score: score0,
          taker_imb: f0.taker_imb,
          oi_chg: f0.oi_chg,
          meta: {
            th_up: this.TH_UP,
            th_dn: this.TH_DN,
            raw: { score0, score1 },
          },
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    // 下单（可选）
    if (!this.DRY_RUN) {
      // const instId = sym; // e.g. BTC-USDT-SWAP
      // const notional = Number(process.env.SIGNAL_NOTIONAL_USDT ?? 100);
      // const size = await this.trade.notionalToSize(instId, notional);
      // if (side === 'LONG') {
      //   await this.trade.placeOrder({ instId, side: 'buy', tdMode: 'cross', ordType: 'market', sz: size });
      // } else if (side === 'SHORT') {
      //   await this.trade.placeOrder({ instId, side: 'sell', tdMode: 'cross', ordType: 'market', sz: size });
      // }
      // this.logger.log(`Executed ${side} ${sym} size=${size}`);
    } else {
      this.logger.log(
        `Signal ${sym} @${ts}: ${side} (score=${score0?.toFixed?.(3)}) [DRY_RUN]`,
      );
    }

    return { made: 1, side };
  }
}
