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
    const baseUrl = this.config.get<string>('okx.baseUrl');
    const timeout = this.config.get<number>('okx.timeoutMs');
    this.retry = this.config.get<number>('okx.retry')!;
    this.backoffMs = this.config.get<number>('okx.retryBackoffMs')!;

    this.client = axios.create({
      baseURL: baseUrl,
      timeout,
      headers: { 'User-Agent': 'quant-bigdata-trend/1.0' },
    });

    this.logger.log(`✅ HTTP client ready: ${baseUrl} (timeout=${timeout}ms)`);
  }

  /** GET 请求带重试 */
  async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      try {
        const res = await this.client.get<T>(path, { params });
        return res.data;
      } catch (err: any) {
        const code = err.response?.status;
        const msg = err.message ?? 'Unknown error';
        this.logger.warn(
          `GET ${path} failed (try ${attempt + 1}/${this.retry + 1}): ${code} ${msg}`,
        );
        if (attempt === this.retry) throw err;
        await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
      }
    }
    throw new Error(`GET ${path} failed after ${this.retry + 1} attempts`);
  }

  /** POST 请求带重试 */
  async post<T = any>(path: string, data?: any): Promise<T> {
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      try {
        const res = await this.client.post<T>(path, data);
        return res.data;
      } catch (err: any) {
        const code = err.response?.status;
        const msg = err.message ?? 'Unknown error';
        this.logger.warn(
          `POST ${path} failed (try ${attempt + 1}/${this.retry + 1}): ${code} ${msg}`,
        );
        if (attempt === this.retry) throw err;
        await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
      }
    }
    throw new Error(`POST ${path} failed after ${this.retry + 1} attempts`);
  }
}
