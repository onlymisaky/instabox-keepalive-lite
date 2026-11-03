/**
 * 配置层：唯一读取环境变量、命令行参数和内置常量的地方。
 *
 * 凭据（API Key 与机器 ID）按以下优先级解析，命中即止：
 *   1. 启动参数：--api-key ibk_... --machine-id m_...
 *   2. 环境变量：INSTABOX_API_KEY / INSTABOX_MACHINE_ID
 *   3. 源码常量：直接修改本文件顶部的 FALLBACK_*（保存即生效）
 *   4. 以上都未命中时，在终端交互式询问用户输入（仅限 TTY 环境）
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 兜底凭据：不想配置环境变量/启动参数的用户，可直接把值写死在这里。
 * 注意：公开仓库不要这样做——key 会随代码一起公开。
 * @type {string}
 */
const FALLBACK_API_KEY = "";

/**
 * 兜底机器 ID，用法同 FALLBACK_API_KEY。
 * @type {string}
 */
const FALLBACK_MACHINE_ID = "";

/** 机器 ID 格式：m_ + 26 位小写 base32（官方 openapi 约定）。 */
const MACHINE_ID_PATTERN = /^m_[a-z2-7]{26}$/;

/**
 * 极简参数解析：支持 --api-key KEY / --api-key=KEY 与
 * --machine-id ID / --machine-id=ID 两种写法，其余视为位置参数。
 *
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {{flags: {apiKey?: string, machineId?: string}, positional: string[]}}
 */
function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api-key") {
      flags.apiKey = argv[(i += 1)];
    } else if (arg.startsWith("--api-key=")) {
      flags.apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--machine-id") {
      flags.machineId = argv[(i += 1)];
    } else if (arg.startsWith("--machine-id=")) {
      flags.machineId = arg.slice("--machine-id=".length);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * 交互式询问一段凭据，直到拿到非空输入。
 *
 * @param {import("node:readline/promises").Interface} rl readline 接口
 * @param {string} label 提示文案
 * @returns {Promise<string>} 用户输入（已 trim）
 */
async function askUntilNotEmpty(rl, label) {
  for (;;) {
    const answer = (await rl.question(label)).trim();
    if (answer) {
      return answer;
    }
    console.error("输入不能为空，请重新输入。");
  }
}

/**
 * 三种静态方式都未命中凭据时，在终端交互式补齐。
 * 非 TTY（如 GitHub Actions、管道调用）下无法交互，返回 null 交给调用方报错。
 *
 * @returns {Promise<{apiKey: string, machineId: string} | null>}
 */
async function promptForCredentials() {
  if (!stdin.isTTY) {
    return null;
  }
  console.error("未检测到凭据，请按提示输入（也可退出后用 --api-key / 环境变量提供）：");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const apiKey = await askUntilNotEmpty(rl, "请输入 API Key (ibk_...): ");
    const machineId = await askUntilNotEmpty(rl, "请输入机器 ID (m_...): ");
    return { apiKey, machineId };
  } finally {
    rl.close();
  }
}

/**
 * 加载并校验配置。凭据在三种静态方式均缺失且无法交互补齐、
 * 或格式不合法时直接终止进程（exit 2），宁可快速失败，
 * 也不要等第一次请求才报 401/404。
 *
 * @param {object} [inject] 可注入的依赖（测试用）
 * @param {NodeJS.ProcessEnv} [inject.env=process.env] 环境变量来源
 * @param {string[]} [inject.argv=process.argv.slice(2)] 命令行参数
 * @returns {Promise<{
 *   mode: string,
 *   apiKey: string,
 *   machineId: string,
 *   apiBase: string,
 *   timeoutMs: number,
 *   pollTimeoutMs: number,
 *   pollIntervalMs: number,
 *   maxAttempts: number,
 * }>}
 */
export async function loadConfig({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const { flags, positional } = parseArgv(argv);
  const mode = (positional[0] || "keepalive").toLowerCase();

  // 优先级：启动参数 > 环境变量 > 源码常量 > 交互输入
  let apiKey = flags.apiKey || env.INSTABOX_API_KEY || FALLBACK_API_KEY;
  let machineId = flags.machineId || env.INSTABOX_MACHINE_ID || FALLBACK_MACHINE_ID;

  if (!apiKey || !machineId) {
    const prompted = await promptForCredentials();
    if (!prompted) {
      console.error("缺少凭据：API Key 与机器 ID 必须提供，三种方式任选其一：");
      console.error("  1. 启动参数：instabox keepalive --api-key ibk_... --machine-id m_...");
      console.error("  2. 环境变量：INSTABOX_API_KEY / INSTABOX_MACHINE_ID");
      console.error("  3. 源码常量：编辑 src/config.mjs 顶部的 FALLBACK_API_KEY / FALLBACK_MACHINE_ID");
      process.exit(2);
    }
    apiKey = apiKey || prompted.apiKey;
    machineId = machineId || prompted.machineId;
  }

  // 机器 ID 拼错一位会导致对不存在机器的 404，提前校验格式省一轮排错。
  if (!MACHINE_ID_PATTERN.test(machineId)) {
    console.error(`INSTABOX_MACHINE_ID 格式不合法（应为 m_ + 26 位小写 base32）: ${machineId}`);
    process.exit(2);
  }

  return {
    mode,
    apiKey,
    machineId,
    /** 去掉末尾斜杠，避免拼接出 //v1/ 这样的路径。 */
    apiBase: (env.INSTABOX_API_BASE || "https://api.instabox.sh").replace(/\/+$/, ""),
    /** 单次请求超时：API 正常响应远快于此，超时多半是网络问题。 */
    timeoutMs: 20_000,
    /** 唤醒/启动后等待 running 的上限。 */
    pollTimeoutMs: 90_000,
    /** 轮询间隔。 */
    pollIntervalMs: 3_000,
    /** 可重试错误的最大尝试次数。 */
    maxAttempts: 3,
  };
}
