/**
 * 日志层：只关心"怎么把一件事说清楚"，不关心业务与 HTTP 细节。
 *
 * 双格式输出：
 *   - CI 管道（GitHub Actions）：单行 JSON，便于日志检索；
 *   - 终端（TTY）：人类可读中文文案，一行一件事。
 * 可用 INSTABOX_LOG=json|text 强制指定，未设置时按输出目标自动判断。
 *
 * 注意：只输出状态与结果，绝不打印 apiKey。
 */

/** @returns {boolean} 是否使用人类可读文本格式 */
export function useTextLog() {
  if (process.env.INSTABOX_LOG === "json") return false;
  if (process.env.INSTABOX_LOG === "text") return true;
  return Boolean(process.stdout.isTTY);
}

/** 本地时间戳（时分秒）：12:21:55 */
function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ISO 时间串转本地时分秒（解析失败原样返回）。 */
function localTimeOf(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return iso || "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 各事件在文本模式下的人类可读文案。
 * JSON 模式不受影响，仍输出 event + 结构化字段。
 * @type {Record<string, (data: Record<string, unknown>) => string>}
 */
const EVENT_TEXT = {
  state: (d) => {
    const parts = [d.name, `机器状态 ${d.state}`].filter(Boolean);
    if (d.cooldownSecondsLeft > 0) parts.push(`冷却剩余 ${d.cooldownSecondsLeft}s`);
    if (d.autoSuspendAfterSeconds != null) parts.push(`空闲 ${d.autoSuspendAfterSeconds}s 后自动暂停`);
    return parts.join("，");
  },
  lease_ok: (d) => `续租成功，租约至 ${localTimeOf(d.expiresAt)}（剩余 ${d.minutesLeft} 分钟）`,
  skip_cooldown: (d) =>
    d.secondsLeft != null
      ? `冷却期还剩 ${d.secondsLeft}s，本轮跳过（下轮自动唤醒）`
      : `冷却期，本轮跳过${d.message ? `：${d.message}` : ""}`,
  skip_transition: (d) => `机器处于过渡态 ${d.state}，有操作进行中，跳过本轮`,
  wake_requested: () => "已发送唤醒请求，等待机器就绪",
  start_requested: () => "已发送启动请求，等待机器就绪",
  running: () => "机器已就绪（running）",
  retry: (d) => `第 ${d.attempt} 次尝试失败，${d.waitSeconds}s 后重试：${d.message}`,
  fatal: (d) => {
    const where = d.status
      ? `（HTTP ${d.status}${d.code ? ` ${d.code}` : ""}）`
      : d.code ? `（${d.code}）` : "";
    return `执行失败${where}：${d.message}`;
  },
};

/**
 * 把事件渲染成人类可读单行：`[12:21:55] 续租成功，租约至 13:21（剩余 55 分钟）`。
 * 没有专属文案的事件退化为 `事件名 key=value ...`（跳过 null/undefined 字段）。
 *
 * @param {string} event 事件名
 * @param {Record<string, unknown>} [data] 附加字段
 * @returns {string}
 */
export function renderText(event, data = {}) {
  const body = EVENT_TEXT[event]
    ? EVENT_TEXT[event](data)
    : Object.entries(data)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
  return `[${localTimestamp()}] ${body || event}`;
}

/**
 * 结构化日志：CI 下输出单行 JSON（便于 Actions 日志检索），
 * 终端下输出人类可读中文文案。可用 INSTABOX_LOG=json|text 强制指定。
 *
 * @param {string} event 事件名，如 state / lease_ok / skip_cooldown
 * @param {Record<string, unknown>} [data] 附加字段
 */
export function log(event, data = {}) {
  if (useTextLog()) {
    console.log(renderText(event, data));
  } else {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  }
}
