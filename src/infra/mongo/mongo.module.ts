import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService, ConfigModule } from '@nestjs/config';

import { Bar, BarSchema } from './schemas/bar.schema';
import { Status, StatusSchema } from './schemas/status.schema';

@Module({
  imports: [
    ConfigModule,
    // 连接 Mongo（支持 .env 配置）
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        uri: cfg.get<string>('mongo.uri') ?? 'mongodb://127.0.0.1:27017/quant',
        // 这里可按需加其他 mongoose 连接参数
        // dbName: cfg.get<string>('mongo.db') ?? 'quant',
      }),
    }),

    // 注册集合
    MongooseModule.forFeature([
      { name: Bar.name, schema: BarSchema },
      { name: Status.name, schema: StatusSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class MongoModule {}
