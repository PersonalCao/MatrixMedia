"use strict";

/**
 * 评论采集执行器：与 dataStats/collector.js 同构——
 * 为单个「分组 × 平台」开隐藏窗口，复用其 session partition 登录态，
 * 在平台页面上下文执行探针/采集脚本。
 *
 * 两个入口：
 * - probeAccount: 端点探针（sniffer 常开，dump 导航链接 + 页面自身请求端点）
 * - collectComments: 按平台适配器拉评论列表（归一化输出）
 */

const path = require("path");
const fs = require("fs");
const { BrowserWindow, app } = require("electron");
const { PRELOAD_SOURCE_COMMENTS } = require("./preloadSource.js");
const {
  PLATFORM_META,
  PROBE_SCRIPT,
  COMMENTS_ADAPTERS,
} = require("./adapters.js");
const { buildReplyScript } = require("./reply.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * preload 必须是磁盘真实文件（同 dataStats：内嵌源码写入 userData，路径稳定）。
 * 评论模块用增强版嗅探（含请求体/json 型响应），独立于 data-stats 的副本。
 */
function ensureSnifferPreloadPath() {
  const file = path.join(
    app.getPath("userData"),
    "comments",
    "preload-sniffer.js"
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PRELOAD_SOURCE_COMMENTS);
  return file;
}

function makeWindow(partition, meta) {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      partition,
      backgroundThrottling: false,
      preload: ensureSnifferPreloadPath(),
      contextIsolation: false,
    },
  });
  if (meta.userAgent) win.webContents.setUserAgent(meta.userAgent);
  win.webContents.on("render-process-gone", () => {
    /* 窗口崩溃由超时兜底 */
  });
  return win;
}

async function loadAndCheck(win, meta, landing) {
  await Promise.race([
    win.loadURL(landing),
    sleep(30000).then(() => {
      throw new Error("落地页加载超时");
    }),
  ]);
  const finalUrl = win.webContents.getURL();
  if (meta.loginUrlPattern && meta.loginUrlPattern.test(finalUrl)) {
    const err = new Error("登录态已失效，请先在「媒体平台管理」重新登录");
    err.code = "NOT_LOGGED_IN";
    throw err;
  }
  await sleep(meta.settleMs || 6000);
  return finalUrl;
}

/**
 * 端点探针。
 * @param {object} opts
 * @param {string} opts.partition  persist:<分组><平台>
 * @param {string} opts.platform   平台中文名（PLATFORM_META 键）
 * @param {string} [opts.url]      自定义落地页（默认平台首页）
 * @param {number} [opts.timeoutMs]
 */
async function probeAccount({ partition, platform, url, clicks, waitMs, fetches, deep, evalFile, timeoutMs = 90000 }) {
  const meta = PLATFORM_META[platform];
  if (!meta) throw new Error(`暂不支持的平台：${platform}`);
  const win = makeWindow(partition, meta);
  const openedUrls = [];
  try {
    // 菜单可能以新标签打开（如抖音互动管理）：记录目标 URL，拒绝真正开窗
    win.webContents.setWindowOpenHandler(({ url }) => {
      openedUrls.push(String(url).slice(0, 200));
      return { action: "deny" };
    });
    const finalUrl = await loadAndCheck(win, meta, url || meta.landingPage);
    // --eval <file>：执行自定义页面脚本（DOM 结构调研等，返回值须为可 JSON 化对象）
    const script = evalFile
      ? fs.readFileSync(evalFile, "utf8")
      : PROBE_SCRIPT({ clicks, waitMs, fetches, deep });
    const result = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      sleep(timeoutMs).then(() => {
        throw new Error("探针执行超时");
      }),
    ]);
    if (!result || typeof result !== "object") {
      throw new Error("探针脚本未返回有效数据");
    }
    return { finalUrl, result, openedUrls };
  } finally {
    try {
      win.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 评论列表采集。
 * @param {object} opts
 * @param {string} opts.partition
 * @param {string} opts.platform
 * @param {string} [opts.work]   按作品标题/ID 过滤（适配器支持时）
 * @param {number} [opts.limit]  条数上限
 * @param {string} [opts.landingUrl] 覆盖采集落地页（调试用）
 * @param {number} [opts.timeoutMs]
 */
async function collectComments({
  partition,
  platform,
  work = "",
  limit = 200,
  landingUrl = "",
  timeoutMs = 120000,
}) {
  const meta = PLATFORM_META[platform];
  if (!meta) throw new Error(`暂不支持的平台：${platform}`);
  const adapter = COMMENTS_ADAPTERS[platform];
  if (!adapter) {
    throw new Error(
      `${platform} 评论采集适配器尚未实现（先用 comments-probe 探明端点）`
    );
  }
  const win = makeWindow(partition, meta);
  try {
    await loadAndCheck(
      win,
      meta,
      landingUrl || adapter.landingPage || meta.landingPage
    );
    const result = await Promise.race([
      win.webContents.executeJavaScript(
        adapter.collectScript({ work, limit }),
        true
      ),
      sleep(timeoutMs).then(() => {
        throw new Error("评论采集执行超时");
      }),
    ]);
    if (!result || typeof result !== "object") {
      throw new Error("采集脚本未返回有效数据");
    }
    return {
      comments: Array.isArray(result.comments) ? result.comments : [],
      collectedAt: Date.now(),
      extra: result.extra || {},
    };
  } finally {
    try {
      win.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 评论回复（写操作）。默认 execute=false 只做校验（dry-run）。
 * @param {object} opts
 * @param {string} opts.partition
 * @param {string} opts.platform
 * @param {Array}  opts.replies   回复条目（形状见 reply.js 头注）
 * @param {boolean} [opts.execute] true=真发（需 CLI --execute 显式给出）
 * @param {number} [opts.maxPerRun] 单轮真发上限（默认 5）
 * @param {number} [opts.timeoutMs]
 */
async function replyComments({
  partition,
  platform,
  replies,
  execute = false,
  maxPerRun = 5,
  timeoutMs = 240000,
}) {
  const meta = PLATFORM_META[platform];
  if (!meta) throw new Error(`暂不支持的平台：${platform}`);
  const adapter = COMMENTS_ADAPTERS[platform];
  const landing = (adapter && adapter.landingPage) || meta.landingPage;
  const script = buildReplyScript({ platform, replies, execute, maxPerRun });
  const win = makeWindow(partition, meta);
  try {
    await loadAndCheck(win, meta, landing);
    const result = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      sleep(timeoutMs).then(() => {
        throw new Error("回复执行超时");
      }),
    ]);
    if (!result || !Array.isArray(result.results)) {
      throw new Error("回复脚本未返回有效数据");
    }
    return result;
  } finally {
    try {
      win.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { probeAccount, collectComments, replyComments };
