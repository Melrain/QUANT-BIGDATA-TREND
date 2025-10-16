import { Cron } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { SignalEvaluatorService } from './signal-evaluator.service';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';

@Injectable()
export class SignalEvaluatorScheduler {
  private readonly logger = new Logger(SignalEvaluatorScheduler.name);
  constructor(
    private readonly evalSvc: SignalEvaluatorService,
    private readonly symbols: SymbolRegistry,
  ) {}

  @Cron(process.env.CRON_SIGNAL_EVAL ?? '0 */10 * * * *') // 每10分钟
  async tick() {
    const syms = this.symbols.getAll();
    if (!syms?.length) {
      this.logger.warn('[Eval] no symbols');
      return;
    }
    await this.evalSvc.evaluateRecentForSymbols(
      syms,
      Number(process.env.EVAL_BATCH_LIMIT ?? 500),
    );
  }
}
