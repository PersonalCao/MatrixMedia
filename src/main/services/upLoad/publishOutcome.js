import maybeClosePublishWindow from "./closeWindow.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";

/**
 * 点击发布后的判定窗口（毫秒）。
 *
 * 旧实现是固定等 5 秒再比 URL，两个方向都会错：
 *  - 平台慢（视频转码/审核排队）时 5 秒不够 → 把已发布误判成异常
 *  - 平台不跳转只弹提示时 → 永远等到「发布异常」
 * 改成分轮询，命中任一成功信号立即返回：URL 跳转 / 成功提示文案。
 */
export const PUBLISH_VERDICT_TIMEOUT_MS = 20000;

/** 兼容旧调用方（外部按固定等待语义引用过） */
export const PUBLISH_NAVIGATE_WAIT_MS = PUBLISH_VERDICT_TIMEOUT_MS;

export const PUBLISH_ABNORMAL_MESSAGE =
  "发布异常：20 秒内既未跳转成功页、也没出现成功提示，可能未真正发布，请到平台确认";

/** 各平台发布/存稿成功后的页面提示文案（命中任一即视为成功信号） */
const SUCCESS_TOAST_TEXTS = [
  "发布成功",
  "已发布",
  "发表成功",
  "上传成功",
  "投稿成功",
  "保存成功",
  "已保存",
  "草稿已保存",
  "保存到草稿箱",
];

/**
 * 穿透 shadow DOM 收集可见文本。
 * 视频号正文与提示在 wujie 影子树里，document.body.innerText 取不到。
 */
const SHADOW_TEXT_JS = `() => {
  const out = [];
  const walk = (root) => {
    try {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
        const t = (el.childElementCount === 0 && el.textContent) ? el.textContent.trim() : '';
        if (t) out.push(t);
      });
    } catch (e) {}
  };
  walk(document);
  return out.join('\\n');
}`;

async function readPageText(page) {
  try {
    if (page && typeof page.evaluate === "function") {
      const t = await page.evaluate(SHADOW_TEXT_JS);
      return typeof t === "string" ? t : "";
    }
  } catch (_) {
    /* 页面销毁/导航中，按空文本处理 */
  }
  return "";
}

/**
 * 轮询等待发布成功信号。
 * @returns {Promise<{ok: boolean, signal: string, urlAfter: string}>}
 */
async function waitForPublishSignal(page, urlBefore, timeoutMs) {
  // 按轮次而不是墙钟计时：每轮含 1 秒等待，真实环境等价于 timeoutMs；
  // 单测里 waitForTimeout 是空实现，也不会空转 20 秒。
  const maxRounds = Math.max(2, Math.ceil(timeoutMs / 1000));
  let urlAfter = readPageUrl(page);
  for (let round = 0; round < maxRounds; round++) {
    urlAfter = readPageUrl(page);
    if (
      urlBefore &&
      urlAfter &&
      normalizeUrl(urlAfter) !== normalizeUrl(urlBefore)
    ) {
      return { ok: true, signal: "url_changed", urlAfter };
    }
    const text = await readPageText(page);
    if (text) {
      for (const kw of SUCCESS_TOAST_TEXTS) {
        if (text.includes(kw)) {
          return { ok: true, signal: `toast:${kw}`, urlAfter };
        }
      }
    }
    await delay(page, 1000);
  }
  return { ok: false, signal: "none", urlAfter: readPageUrl(page) };
}

/** 安全读取当前页面地址，页面已销毁时返回空串 */
export function readPageUrl(page) {
  try {
    if (!page || typeof page.url !== "function") return "";
    return String(page.url() || "");
  } catch (_) {
    return "";
  }
}

/** 忽略末尾斜杠等无意义差异，避免把同一地址判成已跳转 */
function normalizeUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[#?]$/, "")
    .replace(/\/$/, "");
}

function delay(page, ms) {
  if (page && typeof page.waitForTimeout === "function") {
    return page.waitForTimeout(ms).catch(() => {});
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 点击发布/存草稿后统一回执：
 * 等待 5 秒，若为发布模式且页面地址没有变化（未跳成功页），
 * 视为「发布异常」上报，避免把疑似失败记成成功。
 *
 * 注意：这里始终以 status: true 上报，异常通过 publishAbnormal 标记，
 * 因为 status: false 会触发上层的自动重试，导致重复发布。
 *
 * @param {object} options
 * @param {import("puppeteer-core").Page} options.page
 * @param {object} options.data 平台任务数据
 * @param {import("electron").BrowserWindow} options.window
 * @param {{ reply: Function }} options.event
 * @param {string} options.urlBefore 点击发布前的页面地址
 * @param {boolean} [options.isDraftMode] 存草稿不跳转，跳过地址校验
 * @param {string} [options.successMessage]
 * @param {object} [options.extraPayload] 额外回执字段（如 publishMode）
 * @param {object} [options.closeWindowData] 覆盖关窗判断用的数据
 * @param {number} [options.waitMs]
 */
export async function replyPublishOutcome({
  page,
  data,
  window,
  event,
  urlBefore,
  isDraftMode = false,
  successMessage = "上传成功",
  extraPayload = {},
  closeWindowData,
  waitMs = PUBLISH_VERDICT_TIMEOUT_MS,
}) {
  let urlAfter;
  let abnormal = false;
  let signal = "draft_skip";
  if (isDraftMode) {
    // 存草稿不跳转是平台常态，只记录不判定
    await delay(page, waitMs);
    urlAfter = readPageUrl(page);
  } else {
    const verdict = await waitForPublishSignal(page, urlBefore, waitMs);
    urlAfter = verdict.urlAfter;
    signal = verdict.signal;
    abnormal = !verdict.ok && !!verdict.urlAfter;
    console.log(
      `[publish] ${data.pt || ""} 发布判定 signal=${signal} ${
        abnormal ? "→ 异常" : verdict.ok ? "→ 成功" : "→ 无法判定（页面已销毁/读不到地址）"
      }`
    );
  }

  // 读不到地址（窗口已关/页面销毁）时不做异常判定，避免误报
  const urlUnchanged =
    !!urlBefore && !!urlAfter && normalizeUrl(urlAfter) === normalizeUrl(urlBefore);

  const payload = {
    ...data,
    ...extraPayload,
    status: true,
    publishPageUrl: urlAfter,
    publishSignal: signal,
    message: abnormal ? PUBLISH_ABNORMAL_MESSAGE : successMessage,
  };
  // 草稿模式不跳转，地址未变化属正常，不能据此判异常（发布模式的判定见下）。
  // 但仍把「点击存草稿后地址是否变化」记录下来并打日志，便于排查
  // 「回报成功但后台没有草稿」时区分是点了没反应，还是存到了别处。
  if (isDraftMode && urlBefore && urlAfter) {
    payload.draftUrlUnchanged = urlUnchanged;
    console.log(
      `[publish] ${data.pt || ""} 存草稿后页面地址${
        urlUnchanged ? "未变化" : "已变化"
      }（草稿模式仅记录，不判定异常）：${urlAfter}`
    );
  }
  if (abnormal) {
    payload.publishAbnormal = true;
    payload.outcome = "publish_abnormal";
    payload.needsAttention = true;
    // 疑似没发出去时页面还停在发布页（通常是平台校验提示 / 风控弹窗），先截图再关窗。
    // 传入 window：hidden 窗口下 CDP 截图可能等不到合成帧超时，用 capturePage 兜底。
    const shot = await capturePublishFailureScreenshot(page, data, { window });
    if (shot) payload.failScreenshot = shot;
    console.warn(
      `[publish] ${data.pt} ${PUBLISH_ABNORMAL_MESSAGE}（地址：${urlAfter}）`
    );
  }

  try {
    event.reply("puppeteerFile-done", payload);
  } catch (e) {
    console.error("发布回执发送失败:", e && e.message ? e.message : e);
  }
  maybeClosePublishWindow(closeWindowData || data, window);
}

/**
 * 平台 handler 的上传失败回执：先在失败画面上截图，再发 status:false。
 *
 * 各平台 catch 分支原本各自 event.reply("puppeteerFile-done", {...})，
 * 这里统一收口，避免每个平台再复制一遍截图逻辑。
 *
 * @param {object} options
 * @param {import("puppeteer-core").Page} options.page
 * @param {object} options.data
 * @param {import("electron").BrowserWindow} options.window
 * @param {{ reply: Function }} options.event
 * @param {string} options.message 失败原因
 * @param {object} [options.extraPayload]
 * @param {boolean} [options.closeWindow] 是否关闭发布窗口，默认保持各平台原行为（关闭）
 */
export async function replyPublishFailure({
  page,
  data,
  window,
  event,
  message,
  extraPayload = {},
  closeWindow = true,
}) {
  const shot = await capturePublishFailureScreenshot(page, data, { window });
  try {
    event.reply("puppeteerFile-done", {
      ...data,
      ...extraPayload,
      status: false,
      message,
      ...(shot ? { failScreenshot: shot } : {}),
    });
  } catch (e) {
    // 队列 transport 用带 payload 的异常通知外层重试；不能当作 IPC 发送失败吞掉。
    if (e && e._mmUploadFailurePayload) throw e;
    console.error("发布失败回执发送失败:", e && e.message ? e.message : e);
  }
  if (closeWindow) maybeClosePublishWindow(data, window);
}
