"use strict";

/** 将平台自动化回执统一为 CLI / HTTP / MCP 可消费的结果。 */
export function resolvePublishCompletion(payload) {
  const ok = Boolean(payload && payload.status === true);
  const message =
    (payload && payload.message) || (ok ? "上传成功" : "上传失败");
  const fallbackDraft = Boolean(
    ok &&
      payload.needsAttention === true &&
      payload.outcome === "draft_saved"
  );
  // 发布成功后平台会自动跳成功页；5 秒后地址未变化时主进程标记 publishAbnormal，
  // 这里统一降级为「发布异常」，避免当成成功。
  const publishAbnormal = Boolean(ok && payload.publishAbnormal === true);
  const savedAsDraft = Boolean(
    ok &&
      !publishAbnormal &&
      (fallbackDraft ||
        payload.publishMode === "draft" ||
        payload.publishToDraft === true)
  );
  const draftUnverified = Boolean(ok && payload.draftUnverified === true);
  // 登录态失效：不是内容/流程失败，需要人重新扫码。单独给一个状态和退出码，
  // 让流水线能区分「该重试/该补登录」和「内容有问题」。
  const loginRequired = Boolean(payload && payload.loginRequired === true);
  return {
    ok,
    message,
    fallbackDraft,
    publishAbnormal,
    savedAsDraft,
    // 存草稿结果无法核验（抖音/快手网页端无草稿箱）：点击成功但草稿不存在于任何地方。
    // 这里不降级成失败（不触发自动重试，避免重复发布），只把语义说清楚。
    draftUnverified,
    loginRequired,
    recordStatus: loginRequired
      ? "login_required"
      : publishAbnormal
        ? "abnormal"
        : savedAsDraft
          ? "draft"
          : ok
            ? "success"
            : "failed",
    status: loginRequired
      ? "login_required"
      : publishAbnormal
        ? "publish_abnormal"
        : fallbackDraft
          ? "needs_attention"
          : savedAsDraft
            ? "draft"
            : ok
              ? "success"
              : "failed",
    exitCode: loginRequired
      ? 5
      : publishAbnormal
        ? 4
        : fallbackDraft
          ? 4
          : ok
            ? 0
            : 3,
  };
}
