"use strict";

/**
 * 验证「点击发布后 5 秒页面地址未变化 → 发布异常」的判定与结果映射：
 * 1. replyPublishOutcome：地址未变化时上报 publishAbnormal，变化时上报成功
 * 2. 存草稿模式不做地址校验
 * 3. resolvePublishCompletion：publishAbnormal 降级为 abnormal，不计成功
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const outcomeBundle = path.join(outDir, "publishOutcome.cjs");
const resultBundle = path.join(outDir, "publishResult.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/upLoad/publishOutcome.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outcomeBundle,
  external: ["electron"],
});
buildSync({
  entryPoints: [path.join(root, "src/shared/publishResult.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resultBundle,
});

const { replyPublishOutcome } = require(outcomeBundle);
const { resolvePublishCompletion } = require(resultBundle);

function createPage(urls) {
  let i = 0;
  return {
    url: () => urls[Math.min(i, urls.length - 1)],
    waitForTimeout: async () => {
      i += 1;
    },
  };
}

function createEvent() {
  const calls = [];
  return {
    calls,
    reply: (channel, payload) => calls.push({ channel, payload }),
  };
}

(async () => {
  // 1. 地址未变化 → 发布异常
  {
    const page = createPage(["https://x.com/publish", "https://x.com/publish"]);
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "抖音", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.status, true);
    assert.strictEqual(payload.publishAbnormal, true);
    assert.strictEqual(payload.outcome, "publish_abnormal");
    assert.ok(payload.message.includes("发布异常"));
  }

  // 2. 地址已跳到成功页 → 正常成功
  {
    const page = createPage(["https://x.com/publish", "https://x.com/success"]);
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "抖音", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
      successMessage: "上传成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.status, true);
    assert.strictEqual(payload.publishAbnormal, undefined);
    assert.strictEqual(payload.message, "上传成功");
  }

  // 3. 存草稿不跳转，也不能判成异常
  {
    const page = createPage(["https://x.com/publish", "https://x.com/publish"]);
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "抖音", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      isDraftMode: true,
      waitMs: 0,
      successMessage: "保存草稿成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.publishAbnormal, undefined);
    assert.strictEqual(payload.message, "保存草稿成功");
    // 草稿模式记录「点击后地址是否变化」用于排查，但不判定异常（#42）
    assert.strictEqual(payload.draftUrlUnchanged, true);
  }

  // 3b. 草稿模式点击后地址变了：同样不判异常，只记录
  {
    const page = createPage(["https://x.com/publish", "https://x.com/drafts"]);
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "抖音", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      isDraftMode: true,
      waitMs: 0,
      successMessage: "保存草稿成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.publishAbnormal, undefined);
    assert.strictEqual(payload.draftUrlUnchanged, false);
  }

  // 4. 末尾斜杠差异不算跳转
  {
    const page = createPage([
      "https://x.com/publish",
      "https://x.com/publish/",
    ]);
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "视频号", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
    });
    assert.strictEqual(event.calls[0].payload.publishAbnormal, true);
  }

  // 5. 读不到地址时不误报异常
  {
    const page = { url: () => "", waitForTimeout: async () => {} };
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "快手", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
      successMessage: "上传成功",
    });
    assert.strictEqual(event.calls[0].payload.publishAbnormal, undefined);
  }

  // 5b. 地址未变但页面出现成功提示 → 判成功
  // （2026-10 新增：视频号等平台点完不跳转、只弹提示，旧判据会误报异常）
  {
    const page = {
      url: () => "https://x.com/publish",
      waitForTimeout: async () => {},
      evaluate: async () => "发布成功",
    };
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "视频号", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
      successMessage: "上传成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.publishAbnormal, undefined);
    assert.strictEqual(payload.publishSignal, "toast:发布成功");
    assert.strictEqual(payload.message, "上传成功");
  }

  // 5c. 页面静态文案里出现「已发布/保存成功/已保存」时不能误判成功
  // （这些词在创作后台左栏/标签页里常驻；全页 includes 会假阳性）
  {
    const page = {
      url: () => "https://x.com/publish",
      waitForTimeout: async () => {},
      evaluate: async () => "首页 内容管理 已发布 保存成功 已保存 数据看板",
    };
    const event = createEvent();
    await replyPublishOutcome({
      page,
      data: { pt: "视频号", closeWindowAfterPublish: false },
      window: null,
      event,
      urlBefore: "https://x.com/publish",
      waitMs: 0,
      successMessage: "上传成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.publishAbnormal, true, "静态泛化文案不得判成功");
    assert.strictEqual(payload.publishSignal, "none");
    assert.ok(payload.message.includes("发布异常"));
  }

  // 6. 结果映射：异常不计成功
  {
    const abnormal = resolvePublishCompletion({
      status: true,
      publishAbnormal: true,
      needsAttention: true,
      message: "发布异常",
    });
    assert.strictEqual(abnormal.recordStatus, "abnormal");
    assert.strictEqual(abnormal.status, "publish_abnormal");
    assert.strictEqual(abnormal.savedAsDraft, false);
    assert.notStrictEqual(abnormal.exitCode, 0);

    const ok = resolvePublishCompletion({ status: true, message: "上传成功" });
    assert.strictEqual(ok.recordStatus, "success");
    assert.strictEqual(ok.exitCode, 0);
    assert.strictEqual(ok.draftUnverified, false);

    // 存草稿但平台无草稿箱（抖音/快手）：状态机仍是 draft、退出码 0，
    // 但必须带 draftUnverified 标记，不能对外宣称"已保存草稿"
    const unverifiedDraft = resolvePublishCompletion({
      status: true,
      publishMode: "draft",
      draftUnverified: true,
      message: "已点击存草稿（抖音网页端无草稿箱，无法核验）",
    });
    assert.strictEqual(unverifiedDraft.savedAsDraft, true);
    assert.strictEqual(unverifiedDraft.recordStatus, "draft");
    assert.strictEqual(unverifiedDraft.exitCode, 0);
    assert.strictEqual(unverifiedDraft.draftUnverified, true);

    // 视频号有真草稿箱，未带标记
    const sphDraft = resolvePublishCompletion({
      status: true,
      publishMode: "draft",
      message: "保存草稿成功",
    });
    assert.strictEqual(sphDraft.draftUnverified, false);

    // 登录态失效：单独状态 + 退出码 5，不能混进普通失败（P2-8）
    const needLogin = resolvePublishCompletion({
      status: false,
      loginRequired: true,
      message: "视频号登录状态已失效，请重新登录后再试",
    });
    assert.strictEqual(needLogin.status, "login_required");
    assert.strictEqual(needLogin.recordStatus, "login_required");
    assert.strictEqual(needLogin.exitCode, 5);
    assert.strictEqual(needLogin.loginRequired, true);

    // 普通失败仍是 3，不被登录态吞掉
    const plainFail = resolvePublishCompletion({ status: false, message: "上传失败" });
    assert.strictEqual(plainFail.status, "failed");
    assert.strictEqual(plainFail.exitCode, 3);
    assert.strictEqual(plainFail.loginRequired, false);
  }

  console.log("test-publish-abnormal: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
