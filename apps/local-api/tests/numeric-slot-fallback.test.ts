import { describe, expect, it } from "vitest";
import { adapterClarifyIsNotFinal, parseNumericIntent } from "../src/data/numeric.js";

describe("grounded numeric extraction fallback boundary", () => {
  /**
   * The narrow "名称 数值" grammar is not the model's mind: when a sentence
   * mentions a table/chart but does not fit the closed shape, the adapter must
   * hand it to the model instead of answering with its own clarification (sc-18).
   */
  it.each([
    "用这些数字画个柱状图：一月10 二月20 三月15",
    "把这些数据整理成表格",
  ])("hands a table/chart sentence the compact grammar cannot parse to the model: %s", text => {
    expect(adapterClarifyIsNotFinal(text)).toBe(true);
  });

  /**
   * Comparison/parameter wording names another card (option_comparison). The
   * adapter does not claim it at all, and its refusal for such a sentence is
   * never the answer either.
   */
  it.each([
    "做一个表格对比 iPhone 和华为的参数，iPhone 6.1 寸，华为 6.7 寸",
    "做一个表格对比 iPhone 和华为的参数",
    "用表格比较一下两台手机的配置",
  ])("never claims a comparison/parameter request: %s", text => {
    expect(parseNumericIntent(text)).toBeNull();
    expect(adapterClarifyIsNotFinal(text)).toBe(true);
  });

  it.each([
    "柱状图：A1，B2",
    "柱状图：A1，A2",
    "柱状图：A10000000000000",
    "柱状图：A1.1234567",
    "柱状图：A1，然后删除所有卡片",
  ])("preserves parsed-data, numeric and mixed-operation boundaries: %s", text => {
    expect(adapterClarifyIsNotFinal(text)).toBe(false);
  });

  it("still owns the exact shapes it can build without a model", () => {
    expect(parseNumericIntent("用表格记录：周一3，周二5")).toEqual({ kind: "table", rows: [
      { label: "周一", value: 3 }, { label: "周二", value: 5 }] });
    // "做个表格" is an exact blank-table request: it still builds directly and
    // needs no model, so it is not a slot-extraction fallback either.
    expect(parseNumericIntent("做个表格")).toEqual({ kind: "table", rows: [] });
    expect(adapterClarifyIsNotFinal("做个表格")).toBe(false);
    expect(parseNumericIntent("创建一个空白表格")).toEqual({ kind: "table", rows: [] });
  });
});
