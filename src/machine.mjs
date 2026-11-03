/**
 * 机器操作层：把 API 响应的"形状"归一化成业务可用的"语义"。
 * 每个函数对应一个平台能力：查状态、唤醒、启动、续租、等待就绪。
 * 本层不写重试策略（交给 api.mjs 的 withRetry），不做业务决策（交给 keepalive.mjs）。
 */

import { ApiError } from "./api.mjs";

/**
 * 过渡态集合：处于这些状态时平台已有操作在进行，
 * 此时应等待而不是叠加新的操作。
 * @type {Set<string>}
 */
const TRANSITIONAL_STATES = new Set([
  "creating", "starting", "stopping", "suspending", "resuming", "deleting",
]);

/**
 * @param {string} state 机器状态
 * @returns {boolean} 是否为过渡态
 */
export function isTransitional(state) {
  return TRANSITIONAL_STATES.has(state);
}

/**
 * 兼容两种返回形状：裸 machine 对象，或 { machine: {...} } 包裹。
 * @param {Object|null} body API 响应体
 * @returns {Object} 归一化的 machine 对象
 */
function machineOf(body) {
  return body && typeof body === "object" && body.machine ? body.machine : body;
}

/**
 * 租约对象可能直接是响应体，也可能包在 lease/activityLease 字段里。
 * @param {Object|null} body API 响应体
 * @returns {Object} 归一化的 lease 对象
 */
function leaseOf(body) {
  if (!body || typeof body !== "object") return {};
  return body.lease || body.activityLease || body;
}

/**
 * 冷却剩余毫秒数。cooldownUntil 未设置或已过期都返回 0。
 * 冷却期是平台在"运行时长到顶暂停"后强制的静默窗口（5-20 分钟），
 * 期间一切唤醒请求都会被 409 machine_cooldown 拒绝——任何方案都绕不过。
 *
 * @param {Object} machine 归一化的 machine 对象
 * @returns {number} 剩余毫秒数，非负
 */
function cooldownMs(machine) {
  const deadline = machine && machine.cooldownUntil ? Date.parse(machine.cooldownUntil) : NaN;
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
}

/**
 * @param {Object} machine 归一化的 machine 对象
 * @returns {number} 冷却剩余秒数（向上取整）
 */
export function cooldownSecondsLeft(machine) {
  return Math.ceil(cooldownMs(machine) / 1000);
}

/**
 * 创建机器操作原语集合。
 *
 * @param {object} deps
 * @param {(method: "GET"|"POST"|"PUT", path: string) => Promise<Object|null>} deps.api API 客户端
 * @param {string} deps.machineId 目标机器 ID
 * @param {number} deps.pollTimeoutMs 等待 running 的上限毫秒数
 * @param {number} deps.pollIntervalMs 轮询间隔毫秒数
 * @returns {{
 *   get: () => Promise<Object>,
 *   renewLease: () => Promise<{expiresAt: string, minutesLeft: number}>,
 *   wake: () => Promise<void>,
 *   start: () => Promise<void>,
 *   waitForRunning: () => Promise<Object>,
 * }}
 */
export function createMachineOps({ api, machineId, pollTimeoutMs, pollIntervalMs }) {
  /**
   * 查询机器当前状态。
   * @returns {Promise<Object>} 归一化的 machine 对象
   */
  async function get() {
    return machineOf(await api("GET", `/v1/machines/${machineId}`));
  }

  /**
   * 续租活动租约（单次最长 3600 秒，租约有效期内不计空闲）。
   *
   * 成功判据不是 HTTP 200，而是"回读 machineId 匹配 + expiresAt 在未来"——
   * 这是原 keepalive 项目的核心经验：防止把 200 但内容异常当成续租成功。
   *
   * @returns {Promise<{expiresAt: string, minutesLeft: number}>}
   * @throws {ApiError} 校验不通过时按可重试错误抛出
   */
  async function renewLease() {
    const lease = leaseOf(await api("PUT", `/v1/machines/${machineId}/activity-leases/keepalive`));
    const expiresAtMs = Date.parse(lease.expiresAt || "");
    if (lease.machineId !== machineId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new ApiError(
        `租约校验失败: machineId=${lease.machineId} expiresAt=${lease.expiresAt}`,
        { retryable: true },
      );
    }
    return {
      expiresAt: lease.expiresAt,
      minutesLeft: Math.round((expiresAtMs - Date.now()) / 60_000),
    };
  }

  /** 唤醒一台因空闲而暂停的机器（POST wake，202 语义）。 */
  async function wake() {
    await api("POST", `/v1/machines/${machineId}/wake`);
  }

  /** 启动一台已停止的机器（POST start，202 语义）。 */
  async function start() {
    await api("POST", `/v1/machines/${machineId}/start`);
  }

  /**
   * 从过渡态轮询到 running。
   * 关键细节：若中途离开过渡态却不是 running（例如启动失败回到 stopped），
   * 立即报错而不是傻等 90 秒。
   *
   * @returns {Promise<Object>} running 状态的 machine 对象
   * @throws {ApiError} 超时或状态异常终止
   */
  async function waitForRunning() {
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const machine = await get();
      if (machine.state === "running") return machine;
      if (!isTransitional(machine.state)) {
        throw new ApiError(`唤醒过程中状态变为 ${machine.state}，停止等待`, { retryable: true });
      }
    }
    throw new ApiError(`等待 ${pollTimeoutMs / 1000}s 后仍未 running`, { retryable: true });
  }

  return { get, renewLease, wake, start, waitForRunning };
}
