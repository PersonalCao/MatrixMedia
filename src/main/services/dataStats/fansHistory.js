"use strict";

/**
 * 粉丝趋势裁剪（2026-10-31 实证）。
 *
 * 视频号 fans_trend(startTs=今天-365天) 会把账号创建前的时段用填充点返回：
 * 账号 2026-10-20 才建，接口却回了 2025-10-21 起的 366 个点、值恒为 1；
 * adapters.js 按数组索引推日期，于是趋势图出现「一年平线」的假历史。
 *
 * 规则：只保留「最早作品发布日（+8 时区）」之后的点；
 * 没有作品（列表拉取失败/新账号还没发）时只保留最近 N 天，避免整段假历史。
 *
 * ⚠ 这个函数会被 toString() 注入到页面上下文执行（adapters.js 的 collectScript），
 * 所以只能写自包含语法：不引用模块作用域常量，不用 import/外部变量。
 */

function clampFansHistory(history, works, nowMs) {
  var CN_OFFSET_MS = 8 * 3600 * 1000;
  var FALLBACK_DAYS = 7;

  var dateOf = function (ms) {
    return new Date(Number(ms) + CN_OFFSET_MS).toISOString().slice(0, 10);
  };

  var list = [];
  var arr = Array.isArray(history) ? history : [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    if (it && it.date) list.push(it);
  }
  if (!list.length) return list;

  var minTs = Infinity;
  var ws = Array.isArray(works) ? works : [];
  for (var j = 0; j < ws.length; j++) {
    var t = Number(ws[j] && ws[j].publishTime);
    if (isFinite(t) && t > 0 && t < minTs) minTs = t;
  }

  var now = Number(nowMs);
  if (!isFinite(now) || now <= 0) now = Date.now();

  // 有作品=账号已开始运营，历史只认到首篇发布日；没有作品=只留最近 7 天（含今天）
  var cutoff = isFinite(minTs)
    ? dateOf(minTs)
    : dateOf(now - (FALLBACK_DAYS - 1) * 86400000);

  var kept = [];
  for (var k = 0; k < list.length; k++) {
    if (String(list[k].date) >= cutoff) kept.push(list[k]);
  }
  return kept;
}

module.exports = {
  clampFansHistory,
  /** 注入页面上下文用（函数自包含，可直接 toString） */
  CLAMP_FANS_HISTORY_SRC: clampFansHistory.toString(),
};
