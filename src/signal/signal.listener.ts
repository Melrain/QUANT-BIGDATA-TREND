/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/signal/signals.listener.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SignalsService } from './signal.service';

@Injectable()
export class SignalsListener {
  private readonly logger = new Logger(SignalsListener.name);
  constructor(
    private readonly signals: SignalsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('features.updated')
  async handleFeaturesUpdated(payload: {
    batchSeq: number;
    symbols: string[];
    tsFrom?: number;
    tsTo?: number;
    written?: number;
    skipped?: number;
  }) {
    const { batchSeq, symbols } = payload;
    this.logger.log(
      `[signals] received features.updated seq=${batchSeq} symbols=${symbols.length}`,
    );

    let ok = 0;
    for (const sym of symbols) {
      try {
        const r = await this.signals.evaluateOnce(sym);
        if (r.made) ok++;
      } catch (e: any) {
        this.logger.warn(`[signals] ${sym} error: ${e?.message ?? e}`);
      }
    }
    this.eventEmitter.emit('signals.updated', {
      batchSeq,
      symbols,
      ok,
    });
    this.logger.log(
      `[signals] emitted signals.updated seq=${batchSeq} ok=${ok}/${symbols.length}`,
    );
  }
}
