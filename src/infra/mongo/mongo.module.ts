import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService, ConfigModule } from '@nestjs/config';

import { Bar, BarSchema } from './schemas/bar.schema';
import { Status, StatusSchema } from './schemas/status.schema';

@Module({
  imports: [
    ConfigModule, // 确保 AppModule 里用了 ConfigModule.forRoot(...)
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        // 1) 只认 MONGO_URL，不再用自定义的 mongo.uri
        const uri = cfg.get<string>('MONGO_URL') ?? process.env.MONGO_URL ?? '';

        if (!uri) {
          // 2) 绝不回退到 localhost，直接报错以免误连 127.0.0.1
          throw new Error(
            'MONGO_URL is not set. Refusing to fallback to localhost.',
          );
        }

        const dbName =
          cfg.get<string>('MONGO_DB') ?? process.env.MONGO_DB ?? 'quant';

        return {
          uri,
          dbName,
          // Railway 内网连单节点更稳
          directConnection: true,
          serverSelectionTimeoutMS: 30_000,
          // 按需加：
          // authSource 可以直接放在 uri 里，如 ?authSource=admin
          // user/password 也建议放在 uri 里
        };
      },
    }),

    MongooseModule.forFeature([
      { name: Bar.name, schema: BarSchema },
      { name: Status.name, schema: StatusSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class MongoModule {}
