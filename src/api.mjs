/**
 * HTTP 层：只关心"怎么调 API"，不关心"调了之后业务上意味着什么"。
 *
 * 关键约定来自 InstaBox 官方文档：
 *   - 鉴权走 X-API-Key 请求头；
 *   - 所有写操作必须携带 Idempotency-Key（重试时复用同一个）；
 *   - 错误响应体形如 { error: { code, message } }，
 *     Retry-After 响应头给出重试等待秒数。
 */

import { randomUUID } from "node:crypto";
import { log } from "./log.mjs";

/**
 * API 调用错误。与普通 Error 的区别在于携带结构化信息，
 * 供上层区分"可重试的网络问题"与"确定性的业务失败"。
 */
export class ApiError extends Error {
  /**
   * @param {string} message 人类可读的错误描述
   * @param {object} [meta]
   * @param {number} [meta.status=0] HTTP 状态码，0 表示请求本身未完成（网络错误）
   * @param {string} [meta.code=""] 服务端错误码，如 machine_cooldown / credit_exhausted
   * @param {number} [meta.retryAfter=0] 服务端要求的重试等待秒数
   * @param {boolean} [meta.retryable=false] 是否值得重试
   */
  constructor(message, { status = 0, code = "", retryAfter = 0, retryable = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
  }
}

/**
 * 创建 API 客户端（闭包持有鉴权信息，调用方无需反复传 key）。
 *
 * @param {object} config
 * @param {string} config.apiBase API 根地址，末尾无斜杠
 * @param {string} config.apiKey API Key（永不写入日志）
 * @param {number} config.timeoutMs 单次请求超时毫秒数
 * @returns {(method: "GET"|"POST"|"PUT", path: string) => Promise<Object|null>}
 */
export function createApi({ apiBase, apiKey, timeoutMs }) {
  return async function api(method, path) {
    /** @type {Record<string, string>} */
    const headers = { "X-API-Key": apiKey };
    if (method !== "GET") {
      // 同一次调用内的重试共用同一个幂等键：服务端按 method+path+body 幂等回放，
      // 每次重试换新键反而可能造成重复的 start/wake。
      headers["Idempotency-Key"] = randomUUID();
    }

    let response;
    try {
      response = await fetch(apiBase + path, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // DNS 失败、超时、连接重置……请求未完成，一律按可重试的网络错误处理。
      throw new ApiError(`${method} ${path}: ${error.name} ${error.message}`, { retryable: true });
    }

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null; // 非 JSON 响应（如网关错误页），保持 null，错误信息里带原文即可
    }

    if (!response.ok) {
      const detail = (body && body.error) || {};
      throw new ApiError(
        `${method} ${path} -> ${response.status}` +
        `${detail.code ? ` ${detail.code}` : ""}${detail.message ? `: ${detail.message}` : ""}`,
        {
          status: response.status,
          code: detail.code || "",
          retryAfter: Number(response.headers.get("retry-after") || 0),
          // 429（限流）与 5xx 可重试；其余 4xx 是确定性失败，重试没有意义
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }

    return body;
  };
}

/**
 * 通用重试包装：只对 retryable 的错误退避重试。
 * 退避策略：优先尊重服务端的 Retry-After，否则线性 5s / 10s。
 *
 * @template T
 * @param {() => Promise<T>} task 异步任务（每次调用重新发起）
 * @param {number} maxAttempts 最大尝试次数
 * @returns {Promise<T>} 首次成功的结果
 * @throws {ApiError} 重试耗尽后抛出最后一次错误
 */
export async function withRetry(task, maxAttempts) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!error.retryable || attempt >= maxAttempts) throw error;
      const waitMs = error.retryAfter > 0 ? error.retryAfter * 1000 : attempt * 5_000;
      log("retry", { attempt, waitSeconds: waitMs / 1000, message: error.message });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
