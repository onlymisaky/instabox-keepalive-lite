#!/usr/bin/env node

/**
 * CLI 入口：加载配置、分发子命令、约定退出码。
 *
 * 退出码约定（GitHub Actions 与本机共用）：
 *   0 = 成功，或"良性跳过"（冷却期、过渡态）—— 不触发失败告警
 *   1 = 真故障（认证失效、额度耗尽、重试后仍失败）—— Actions 运行标红
 *   2 = 用法错误（参数/凭据缺失）—— 人要改配置，同样标红
 */

import { loadConfig } from "../src/config.mjs";
import { runStatus, runKeepalive } from "../src/keepalive.mjs";
import { renderText, useTextLog } from "../src/log.mjs";

/**
 * 按当前日志格式输出一行（文本模式走语义化文案，否则单行 JSON）。
 * @param {(chunk: string) => void} write 输出函数（console.log 或 console.error）
 * @param {string} event 事件名
 * @param {Record<string, unknown>} data 附加字段
 */
function emit(write, event, data) {
  if (useTextLog()) {
    write(renderText(event, data));
  } else {
    write(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  }
}

/**
 * keepalive 的同义子命令集合。
 * "on/start" 在语义上强调"把机器拉起来"，实现与 keepalive 完全一致。
 * @type {Set<string>}
 */
const KEEPALIVE_MODES = new Set(["keepalive", "on", "start"]);

/** 打印用法说明。 */
function usage() {
  console.error("用法: insta-box [status | keepalive | on | start] [--api-key KEY] [--machine-id ID]");
  console.error("  status      只读查看机器状态（state、冷却剩余时间）");
  console.error("  keepalive   续租活动租约；已暂停/已停止时自动唤醒/启动（默认）");
  console.error("");
  console.error("凭据（API Key 与机器 ID）三种提供方式任选其一，优先级从高到低：");
  console.error("  1. 启动参数：--api-key ibk_... --machine-id m_...");
  console.error("  2. 环境变量：INSTABOX_API_KEY / INSTABOX_MACHINE_ID");
  console.error("  3. 源码常量：编辑 src/config.mjs 顶部的 FALLBACK_API_KEY / FALLBACK_MACHINE_ID");
}

/**
 * 主流程：解析模式并分发到对应业务函数。
 * @returns {Promise<0|1|2>} 进程退出码
 */
async function main() {
  const config = loadConfig();

  if (config.mode === "status") {
    return runStatus(config);
  }
  if (KEEPALIVE_MODES.has(config.mode)) {
    return runKeepalive(config);
  }

  console.error(`未知模式 "${config.mode}"`);
  usage();
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // 冷却期（409 machine_cooldown）是平台在"运行时长到顶暂停"后的强制窗口，
    // 期间一切唤醒请求必然被拒绝——这是平台策略而非故障。
    // 按 0 退出，避免 GitHub Actions 误发失败告警。
    if (error && error.code === "machine_cooldown") {
      emit(console.log, "skip_cooldown", { message: error.message });
      process.exit(0);
    }
    // 其余一切未捕获错误视为真故障，exit 1 触发告警。
    emit(console.error, "fatal", {
      message: error.message,
      status: error.status ?? null,
      code: error.code ?? null,
    });
    process.exit(1);
  });
