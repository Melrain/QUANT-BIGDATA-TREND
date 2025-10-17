/**
 * @file position.types.ts
 * @description 统一仓位方向与交易方向枚举，用于 reco/order/trade 模块
 */

export type PositionState = 'LONG' | 'SHORT' | 'FLAT';

/**
 * 下单方向（用于交易层请求）
 * 与 OKX 的方向保持一致：
 * - LONG 代表买入开多（buy → long）
 * - SHORT 代表卖出开空（sell → short）
 */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * 订单动作：BUY / SELL
 * - BUY   => 买入（开多或平空）
 * - SELL  => 卖出（开空或平多）
 */
export type TradeSide = 'BUY' | 'SELL';

/**
 * 交易信号来源统一结构（供 reco/order 层读取）
 */
export interface PositionContext {
  sym: string;
  ts: number;
  side: TradeSide; // BUY / SELL
  targetPos: PositionState; // LONG / SHORT / FLAT
  lastPos: PositionState;
  score?: number;
  notionalUSDT?: number;
}

/**
 * 仓位信息（来自账户模块 / OKX接口）
 */
export interface PositionInfo {
  sym: string;
  posSide: PositionSide; // LONG/SHORT
  size: number;
  avgPx: number;
  leverage: number;
  unrealizedPnl?: number;
}
