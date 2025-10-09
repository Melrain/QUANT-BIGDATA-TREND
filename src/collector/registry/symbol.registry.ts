import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SymbolRegistry {
  private readonly symbols: string[];

  constructor(private readonly config: ConfigService) {
    const assets = this.config.get<string[]>('app.assets') ?? ['BTC'];
    this.symbols = assets.map((a: string) => `${a}-USDT-SWAP`);
  }

  getAll(): string[] {
    return this.symbols;
  }
}
