/**
 * 业务层：把"机器状态 → 该做什么"的决策集中在这一个文件里。
 * 其余模块只提供能力，不参与决策——调整保活策略只需改这里。
 *
 * 状态机主干：
 *
 *   running ──────────────► 直接续租
 *   suspended + 冷却中 ───► 跳过（此时唤醒必然被 409 拒绝）
 *   suspended + 冷却结束 ─► wake → 等就绪 → 续租
 *   stopped ──────────────► start → 等就绪 → 续租
 *   过渡态 ───────────────► 跳过（有别的操作在进行，别掺和）
 *   其他/未知 ────────────► 报错退出，触发告警
 */

import { ApiError, createApi, withRetry } from "./api.mjs";
import { log } from "./log.mjs";
import { createMachineOps, isTransitional, cooldownSecondsLeft } from "./machine.mjs";

/**
 * 组装各层实例。集中在此处创建，是为了单测时可以整体替换。
 * @param {object} config loadConfig 的返回值
 */
function wire(config) {
  const api = createApi(config);
  const machine = createMachineOps({ ...config, api });
  return { machine };
}

/**
 * status 子命令：只读查看，不产生任何写请求，适合人工排障。
 *
 * @param {object} config loadConfig 的返回值
 * @returns {Promise<0>} 恒为 0；查询失败由 withRetry 抛错后统一按 1 退出
 */
export async function runStatus(config) {
  const { machine } = wire(config);
  const info = await withRetry(() => machine.get(), config.maxAttempts);
  log("state", {
    name: info.name,
    state: info.state,
    cooldownUntil: info.cooldownUntil || null,
    cooldownSecondsLeft: cooldownSecondsLeft(info),
    autoSuspendAfterSeconds: info.autoSuspendAfterSeconds ?? null,
  });
  return 0;
}

/**
 * keepalive 子命令（on/start 同义）：状态机主干。
 *
 * 各分支的退出码设计直接服务告警策略：
 * 冷却期、过渡态这类正常现象按 0 退出，只有确定性失败才触发告警。
 *
 * @param {object} config loadConfig 的返回值
 * @returns {Promise<0|1>}
 * @throws {ApiError} 未处理状态或重试耗尽（入口统一按 1 退出）
 */
export async function runKeepalive(config) {
  const { machine } = wire(config);

  const current = await withRetry(() => machine.get(), config.maxAttempts);
  log("state", {
    state: current.state,
    cooldownUntil: current.cooldownUntil || null,
  });

  // ── 分支 1：运行中，最常见路径，续租即完成 ──
  if (current.state === "running") {
    log("lease_ok", await withRetry(() => machine.renewLease(), config.maxAttempts));
    return 0;
  }

  // ── 分支 2：冷却期。跳过是良性事件（exit 0）：
  //    免费套餐运行时长到顶后的强制窗口，等冷却结束，下一轮 Actions 会自动唤醒。
  const cooldownLeft = cooldownSecondsLeft(current);
  if (cooldownLeft > 0) {
    log("skip_cooldown", { secondsLeft: cooldownLeft });
    return 0;
  }

  // ── 分支 3：过渡态。别叠加新操作，等下一轮看结果。
  if (isTransitional(current.state)) {
    log("skip_transition", { state: current.state });
    return 0;
  }

  // ── 分支 4：两种值得发起唤醒动作的状态。
  //    其余状态（error/deleting 等）报错让人来看，不盲目操作。
  if (current.state === "suspended") {
    await withRetry(() => machine.wake(), config.maxAttempts);
    log("wake_requested");
  } else if (current.state === "stopped") {
    await withRetry(() => machine.start(), config.maxAttempts);
    log("start_requested");
  } else {
    throw new ApiError(`未处理的状态 ${current.state}，需要人工确认`, { retryable: false });
  }

  // ── 分支 5：唤醒后必须确认真正 running 并完成首次续租，
  //    否则"刚唤醒"的机器可能在无人续租的 30 分钟后再次暂停。
  const ready = await machine.waitForRunning();
  log("running", { state: ready.state });
  log("lease_ok", await withRetry(() => machine.renewLease(), config.maxAttempts));
  return 0;
}
