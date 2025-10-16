// src/orders/order-suggested.evaluator.scheduler.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SymbolRegistry } from '@/collector/registry/symbol.registry';
import { OrderSuggestedEvaluatorService } from './order-sugested.evaluator.service';

@Injectable()
export class OrderSuggestedEvaluatorScheduler {
  private readonly logger = new Logger(OrderSuggestedEvaluatorScheduler.name);
  private readonly cronExpr = process.env.CRON_ORDER_EVAL || '10 * * * * *'; // 每分钟第10秒

  constructor(
    private readonly svc: OrderSuggestedEvaluatorService,
    private readonly symbols: SymbolRegistry,
  ) {}

  @Cron(process.env.CRON_ORDER_EVAL || '10 * * * * *')
  async tick() {
    const syms = this.symbols.getAll();
    for (const sym of syms) {
      try {
        await this.svc.evaluateRecentForSymbol(sym, 500);
      } catch (e: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.logger.error(`${sym} eval error: ${e?.message || e}`);
      }
    }
  }
}
