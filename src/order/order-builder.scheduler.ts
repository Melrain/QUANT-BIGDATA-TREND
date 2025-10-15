/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/orders/order-builder.scheduler.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderBuilderService } from './order-builder.service';
import { SymbolRegistry } from '@/collector/registry/symbol.registry';

@Injectable()
export class OrderBuilderScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrderBuilderScheduler.name);
  private running = false;

  // 多标的支持：环境变量以逗号分隔

  // cron：默认在每分钟第 50 秒执行（在 reco 之后、exec 之前）
  private readonly cronExpr = process.env.CRON_RECO_TO_ORDER || '50 * * * * *';

  // 启动时兜底构建一档（幂等）
  private readonly buildOnBoot =
    (process.env.BUILD_ORDER_ON_BOOT || '1') === '1';

  constructor(
    private readonly orderBuilder: OrderBuilderService,
    private readonly symbolRegistry: SymbolRegistry,
  ) {}

  private get symbols(): string[] {
    return this.symbolRegistry.getAll();
  }

  async onModuleInit() {
    this.logger.log(
      `OrdersScheduler ready: symbols=${this.symbols.join(', ')} cron="${this.cronExpr}"`,
    );

    if (this.buildOnBoot) {
      const t0 = Date.now();
      let ok = 0,
        skip = 0,
        fail = 0;

      for (const sym of this.symbols) {
        try {
          const r = await this.orderBuilder.buildOne(sym);
          if (r.ok) {
            ok++;
            this.logger.log(`(boot) OrderSuggested ✓ ${sym} id=${r.id}`);
          } else {
            skip++;
            this.logger.warn(
              `(boot) OrderSuggested - ${sym} skip: ${r.reason}`,
            );
          }
        } catch (e: any) {
          fail++;
          this.logger.error(
            `(boot) OrderSuggested ✗ ${sym}: ${e?.message || e}`,
          );
        }
      }
      this.logger.log(
        `(boot) OrderSuggested summary: ok=${ok} skip=${skip} fail=${fail} in ${Date.now() - t0}ms`,
      );
    }
  }

  @Cron('* * * * * *') // 每秒触发一次，由内部判断是否是我们的 cron 秒位
  async tick() {
    const sec = new Date().getSeconds();
    const targetSec =
      Number((this.cronExpr.split(' ')[0] || '50').replace('*/', '')) || 50;
    const isEveryN = this.cronExpr.startsWith('*/');
    const n = isEveryN
      ? Number(this.cronExpr.slice(2).split(' ')[0]) || 1
      : null;
    const shouldRun = isEveryN ? sec % (n as number) === 0 : sec === targetSec;

    if (!shouldRun) return;

    if (this.running) {
      this.logger.warn('Previous tick still running, skip this schedule.');
      return;
    }
    this.running = true;

    const started = Date.now();
    let ok = 0,
      skip = 0,
      fail = 0;

    try {
      for (const sym of this.symbols) {
        try {
          const r = await this.orderBuilder.buildOne(sym);
          if (r.ok) {
            ok++;
            this.logger.log(`OrderSuggested ✓ ${sym} id=${r.id}`);
          } else {
            skip++;
            this.logger.warn(`OrderSuggested - ${sym} skip: ${r.reason}`);
          }
        } catch (e: any) {
          fail++;
          this.logger.error(`OrderSuggested ✗ ${sym}: ${e?.message || e}`);
        }
      }
    } finally {
      this.running = false;
      this.logger.log(
        `OrderSuggested tick: ok=${ok} skip=${skip} fail=${fail} elapsed=${Date.now() - started}ms`,
      );
    }
  }
}
