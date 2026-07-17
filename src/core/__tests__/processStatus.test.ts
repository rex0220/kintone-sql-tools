import { normalizeProcessStatusStates } from "../processStatus";

test("status.json の index を数値化し、null は区別して保持する", () => {
  expect(normalizeProcessStatusStates({
    open: { name: "未処理", index: "10" },
    done: { name: "完了", index: 20 },
  })).toEqual([
    { name: "未処理", index: 10 },
    { name: "完了", index: 20 },
  ]);
  expect(normalizeProcessStatusStates(null)).toBeNull();
});

test.each(["NaN", "1.5", "-1", Number.MAX_SAFE_INTEGER + 1])(
  "不正な STATUS index=%s は fail-closed にする",
  (index) => {
    expect(() => normalizeProcessStatusStates({ bad: { name: "bad", index } })).toThrow(
      "ArgumentError: invalid process status index"
    );
  }
);
