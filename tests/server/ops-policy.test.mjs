import assert from "node:assert/strict";
import test from "node:test";

import { manualActionAuthorized } from "../../server/ops-policy.mjs";

test("manual action authorization distinguishes diagnosis from execution", () => {
  const diagnosticMessages = [
    "看一下任务怎么报错了",
    "任务报错了，这是怎么回事？",
    "那你提交了吗，看着失败了",
    [
      "现场已保留",
      "error: Please commit your changes or stash them before checkout.",
      "HYPERV_COMMAND_FAILED 任务报错了",
    ].join("\n"),
    "Why did this task fail?",
  ];
  const actionMessages = [
    "请继续任务并安全恢复现场",
    "提交自己的修改到 git，并同步远程",
    "帮我修复这个对话的问题",
    "Please restart Relay",
    "Continue and verify Guardian state",
  ];

  for (const message of diagnosticMessages) {
    assert.equal(manualActionAuthorized(message), false, message);
  }
  for (const message of actionMessages) {
    assert.equal(manualActionAuthorized(message), true, message);
  }
});
