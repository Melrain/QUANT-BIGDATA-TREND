/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import * as dns from 'dns';

@Injectable()
export class HttpClientService {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(HttpClientService.name);
  private readonly retry: number;
  private readonly backoffMs: number;

  constructor(private readonly config: ConfigService) {
    const baseUrl =
      this.config.get<string>('okx.baseUrl') ?? 'https://www.okx.com';
    const timeout = Number(this.config.get<number>('okx.timeoutMs') ?? 20000); // 默认 20s
    this.retry = Number(this.config.get<number>('okx.retry') ?? 2);
    this.backoffMs = Number(
      this.config.get<number>('okx.retryBackoffMs') ?? 400,
    );

    // Node 原生 https.Agent（只用类型里确有的字段）
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 256,
      maxFreeSockets: 64,
      keepAliveMsecs: 1000,
      scheduling: 'lifo',
    });

    // —— 关键：IPv4 lookup 适配器 —— //
    // 说明：axios 的 lookup 类型与 Node 的 dns.lookup 类型不完全一致；
    // 这里用 any 做适配，避免和 axios 自己的 AddressFamily/LookupAddress 类型冲突。
    const ipv4Lookup = (hostname: string, options: any, cb?: any): void => {
      // 兼容 (host, cb) / (host, options, cb)
      const opts = typeof options === 'function' ? {} : options || {};
      const callback = typeof options === 'function' ? options : cb;
      // 强制 family: 4
      (dns.lookup as any)(hostname, { ...opts, family: 4 }, callback);
    };

    this.client = axios.create({
      baseURL: baseUrl,
      timeout,
      httpsAgent,
      // 用 any 断言，避免与 axios 的自定义类型冲突（只在这一处放宽）
      lookup: ipv4Lookup as any,
      headers: {
        'User-Agent': 'quant-bigdata-trend/1.0',
        Accept: 'application/json',
      },
    });

    this.logger.log(`✅ HTTP client ready: ${baseUrl} (timeout=${timeout}ms)`);
  }

  /** GET 请求（带重试与退避抖动；将超时/网络错误也视为可重试） */
  async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    for (let attempt = 1; attempt <= this.retry + 1; attempt++) {
      try {
        const res = await this.client.get<T>(path, { params });
        return res.data;
      } catch (err: any) {
        const status = err?.response?.status;
        const code = err?.code;
        const msg = err?.message ?? 'Unknown';
        const retriable =
          [408, 429, 500, 502, 503, 504].includes(status) ||
          [
            'ECONNRESET',
            'ETIMEDOUT',
            'EAI_AGAIN',
            'ECONNABORTED',
            'ERR_BAD_RESPONSE',
          ].includes(code);

        this.logger.warn(
          `GET ${path} failed (try ${attempt}/${this.retry + 1}): status=${status} code=${code} msg=${msg}`,
        );

        if (!retriable || attempt > this.retry) throw err;
        await new Promise((r) =>
          setTimeout(r, this.backoffMs * attempt + Math.random() * 300),
        );
      }
    }
    throw new Error(`GET ${path} failed after ${this.retry + 1} attempts`);
  }

  /** POST 请求（带重试与退避抖动） */
  async post<T = any>(path: string, data?: any): Promise<T> {
    for (let attempt = 1; attempt <= this.retry + 1; attempt++) {
      try {
        const res = await this.client.post<T>(path, data);
        return res.data;
      } catch (err: any) {
        const status = err?.response?.status;
        const code = err?.code;
        const msg = err?.message ?? 'Unknown';
        const retriable =
          [408, 429, 500, 502, 503, 504].includes(status) ||
          [
            'ECONNRESET',
            'ETIMEDOUT',
            'EAI_AGAIN',
            'ECONNABORTED',
            'ERR_BAD_RESPONSE',
          ].includes(code);

        this.logger.warn(
          `POST ${path} failed (try ${attempt}/${this.retry + 1}): status=${status} code=${code} msg=${msg}`,
        );

        if (!retriable || attempt > this.retry) throw err;
        await new Promise((r) =>
          setTimeout(r, this.backoffMs * attempt + Math.random() * 300),
        );
      }
    }
    throw new Error(`POST ${path} failed after ${this.retry + 1} attempts`);
  }
}
