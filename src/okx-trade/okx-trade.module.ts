import { Module } from '@nestjs/common';
import { OkxTradeService } from './okx-trade.service';
import { OkxTradeController } from './okx-trade.controller';

@Module({
  imports: [],
  controllers: [OkxTradeController],
  providers: [OkxTradeService],
  exports: [OkxTradeService],
})
export class OkxTradeModule {}
