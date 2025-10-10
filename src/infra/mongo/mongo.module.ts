import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { MongoService } from './mongo.service';

import { Status, StatusSchema } from './schemas/status.schema';
import { Bar, BarSchema } from './schemas/bar.schemat';

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        uri: cfg.get<string>('MONGO_URL') ?? 'mongodb://127.0.0.1:27017/quant',
        dbName: cfg.get<string>('MONGO_DB') ?? 'quant',
      }),
    }),
    MongooseModule.forFeature([
      { name: Bar.name, schema: BarSchema },
      { name: Status.name, schema: StatusSchema },
    ]),
  ],
  providers: [MongoService],
  exports: [MongoService],
})
export class MongoModule {}
