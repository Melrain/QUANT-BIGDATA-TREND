/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import * as okxTradeService from './okx-trade.service';

@Controller('v1')
export class OkxTradeController {
  constructor(private readonly okx: okxTradeService.OkxTradeService) {}

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'okx-contract-trader',
      ts: new Date().toISOString(),
    };
  }

  @Post('orders')
  placeOrder(@Body() dto: okxTradeService.PlaceContractOrderInput) {
    return this.okx.placeOrder(dto);
  }

  @Get('orders')
  getOrder(@Query() q: okxTradeService.GetOrderInput) {
    return this.okx.getOrder(q);
  }

  @Delete('orders')
  cancelOrder(@Body() dto: okxTradeService.CancelOrderInput) {
    return this.okx.cancelOrder(dto);
  }

  @Post('leverage')
  setLeverage(@Body() dto: okxTradeService.SetLeverageInput) {
    return this.okx.setLeverage(dto);
  }

  @Post('position-mode')
  setPositionMode(@Body() body: { posMode: 'net_mode' | 'long_short_mode' }) {
    return this.okx.setPositionMode(body.posMode);
  }

  // okx-trade.controller.ts
  @Get('account-config')
  getAccountConfig() {
    // 复用 service 里的方法：直接调用真实接口
    return (this.okx as any)['fetchAccountPosMode']
      ?.call(this.okx)
      .then((posMode: string) => ({ posMode }))
      .catch((e: any) => ({ error: e?.response?.data ?? e.message }));
  }
}
