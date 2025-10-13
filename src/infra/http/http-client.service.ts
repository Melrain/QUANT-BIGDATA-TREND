/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class HttpClientService {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(HttpClientService.name);
  private readonly retry: number;
  private readonly backoffMs: number;

  constructor(private readonly config: ConfigService) {
    const baseURL =
      this.config.get<string>('okx.baseUrl') ?? 'https://www.okx.com';
    const timeout = Number(this.config.get<number>('okx.timeoutMs') ?? 10000);
    this.retry = Number(this.config.get<number>('okx.retry') ?? 3);
    this.backoffMs = Number(
      this.config.get<number>('okx.retryBackoffMs') ?? 500,
    );

    this.client = axios.create({
      baseURL,
      timeout,
      proxy: false, // ✅ 明确禁用代理
      headers: {
        'User-Agent': 'quant-bigdata-trend/1.0',
        Accept: 'application/json',
      },
      validateStatus: (status) => status < 500, // 只对 5xx 重试
    });

    this.logger.log(
      `✅ HTTP client ready: ${baseURL} (timeout=${timeout}ms, retry=${this.retry})`,
    );
  }

  /** 带重试的 GET */
  async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    for (let attempt = 1; attempt <= this.retry + 1; attempt++) {
      try {
        const res = await this.client.get<T>(path, { params });
        return res.data;
      } catch (err: any) {
        const code = err.code ?? 'UNKNOWN';
        const status = err.response?.status;
        const msg = err.message ?? 'Unknown error';
        const retriable =
          [408, 429, 500, 502, 503, 504].includes(status) ||
          ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNABORTED'].includes(
            code,
          );

        this.logger.warn(
          `GET ${path} failed (try ${attempt}/${this.retry + 1}): ${status} ${code} ${msg}`,
        );

        if (!retriable || attempt === this.retry + 1) throw err;
        await this.sleep(this.backoffMs * attempt);
      }
    }
    throw new Error(`GET ${path} failed after ${this.retry + 1} attempts`);
  }

  /** 带重试的 POST */
  async post<T = any>(path: string, data?: any): Promise<T> {
    for (let attempt = 1; attempt <= this.retry + 1; attempt++) {
      try {
        const res = await this.client.post<T>(path, data);
        return res.data;
      } catch (err: any) {
        const code = err.code ?? 'UNKNOWN';
        const status = err.response?.status;
        const msg = err.message ?? 'Unknown error';
        const retriable =
          [408, 429, 500, 502, 503, 504].includes(status) ||
          ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNABORTED'].includes(
            code,
          );

        this.logger.warn(
          `POST ${path} failed (try ${attempt}/${this.retry + 1}): ${status} ${code} ${msg}`,
        );

        if (!retriable || attempt === this.retry + 1) throw err;
        await this.sleep(this.backoffMs * attempt);
      }
    }
    throw new Error(`POST ${path} failed after ${this.retry + 1} attempts`);
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
