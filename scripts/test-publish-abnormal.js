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

/** 带正文文本的页面 mock：waitForTimeout 推进 url 序列，evaluate 返回固定文本 */
function createTextPage(urls, text) {
  let i = 0;
  return {
    url: () => urls[Math.min(i, urls.length - 1)],
    waitForTimeout: async () => {
      i += 1;
    },
    evaluate: async () => text || "",
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

  // 3. 存草稿无任何信号：不再无条件报成功，标记待人工核对（#42）
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
    assert.strictEqual(payload.status, true);
    assert.strictEqual(payload.draftVerified, false);
    assert.strictEqual(payload.needsAttention, true);
    assert.strictEqual(payload.outcome, "draft_unverified");
    assert.ok(payload.message.includes("未能确认草稿是否保存成功"));
    // 草稿模式记录「点击后地址是否变化」用于排查，但不判定异常（#42）
    assert.strictEqual(payload.draftUrlUnchanged, true);
  }

  // 3b. 草稿模式点击后地址变了：视为确认成功
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
      waitMs: 50,
      successMessage: "保存草稿成功",
    });
    const payload = event.calls[0].payload;
    assert.strictEqual(payload.publishAbnormal, undefined);
    assert.strictEqual(payload.draftVerified, true);
    assert.strictEqual(payload.needsAttention, undefined);
    assert.strictEqual(payload.message, "保存草稿成功");
    assert.strictEqual(payload.draftUrlUnchanged, false);
  }

  // 3c. 草稿模式页面出现「保存成功」提示：确认成功
  {
    const page = createTextPage(
      ["https://x.com/publish", "https://x.com/publish"],
      "视频已上传 保存成功 可在草稿箱查看"
    );
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
    assert.strictEqual(payload.status, true);
    assert.strictEqual(payload.draftVerified, true);
    assert.strictEqual(payload.message, "保存草稿成功");
  }

  // 3d. 草稿模式页面出现「保存失败」提示：抛错走失败上报，不回执成功
  {
    const page = createTextPage(
      ["https://x.com/publish", "https://x.com/publish"],
      "保存失败，请稍后重试"
    );
    const event = createEvent();
    let thrown = null;
    try {
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
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "应当抛错走各平台 catch 的失败上报");
    assert.ok(thrown.message.includes("保存草稿失败"));
    assert.ok(thrown.message.includes("保存失败"));
    assert.strictEqual(event.calls.length, 0);
  }

  // 3e. 草稿模式点击后跳到登录页：判失败
  {
    const page = createPage([
      "https://x.com/publish",
      "https://passport.x.com/login",
    ]);
    const event = createEvent();
    let thrown = null;
    try {
      await replyPublishOutcome({
        page,
        data: { pt: "抖音", closeWindowAfterPublish: false },
        window: null,
        event,
        urlBefore: "https://x.com/publish",
        isDraftMode: true,
        waitMs: 50,
        successMessage: "保存草稿成功",
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "跳登录页应当判失败");
    assert.ok(thrown.message.includes("登录"));
    assert.strictEqual(event.calls.length, 0);
  }

  // 3f. 草稿模式只有校验提示：不判失败（避免常驻提示误判重复上传），标记待核对
  {
    const page = createTextPage(
      ["https://x.com/publish", "https://x.com/publish"],
      "请选择封面"
    );
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
    assert.strictEqual(payload.status, true);
    assert.strictEqual(payload.draftVerified, false);
    assert.strictEqual(payload.needsAttention, true);
    assert.ok(payload.message.includes("校验提示"));
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

    // 7. 结果映射：草稿未确认 → needs_attention（退出码 4），记录仍为 draft，不触发重试
    {
      const unverified = resolvePublishCompletion({
        status: true,
        needsAttention: true,
        outcome: "draft_unverified",
        publishMode: "draft",
        message: "未能确认草稿是否保存成功，请到平台草稿箱核对",
      });
      assert.strictEqual(unverified.recordStatus, "draft");
      assert.strictEqual(unverified.status, "needs_attention");
      assert.strictEqual(unverified.exitCode, 4);
      assert.strictEqual(unverified.savedAsDraft, true);
      assert.strictEqual(unverified.publishAbnormal, false);
      assert.strictEqual(unverified.fallbackDraft, true);
    }

    // 8. 结果映射：已确认草稿 → 正常 draft，退出码 0
    {
      const verified = resolvePublishCompletion({
        status: true,
        publishMode: "draft",
        draftVerified: true,
        message: "保存草稿成功",
      });
      assert.strictEqual(verified.recordStatus, "draft");
      assert.strictEqual(verified.status, "draft");
      assert.strictEqual(verified.exitCode, 0);
      assert.strictEqual(verified.fallbackDraft, false);
    }
  }

  console.log("test-publish-abnormal: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
