import { describe, expect, it } from "vitest";
import { classifyIntent } from "../turnTaking";

describe("turnTaking classifyIntent", () => {
  it("classifies stop/backchannel/constraints/topics/cancel/continue", () => {
    expect(classifyIntent("停止")).toBe("stop");
    expect(classifyIntent("嗯")).toBe("backchannel");
    expect(classifyIntent("还有就是再加一个待办")).toBe("new_constraint");
    expect(classifyIntent("换个话题")).toBe("new_topic");
    expect(classifyIntent("取消任务")).toBe("cancel_task");
    expect(classifyIntent("继续")).toBe("continue");
    expect(classifyIntent("")).toBe("irrelevant");
  });
});
