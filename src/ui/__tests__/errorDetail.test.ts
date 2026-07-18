// ============================================================
// kintone API エラーの詳細表示（v1.9.0 実機検証で発覚した UX 改善）
//
// kintone.api() の reject（プレーンオブジェクト）はバッチ実行だと
// BatchStatementError に縮約され「[2] 入力内容が正しくありません。」
// だけになる。toDetailedApiError が errors 詳細を message に畳み込み、
// renderError が改行を行として展開することを固定する。
// ============================================================

import { toDetailedApiError } from "../kintoneClient";
import { renderError } from "../renderResult";
import { CursorCleanupWarning } from "../../core/errors/cursorErrors";

test("toDetailedApiError: kintone エラーオブジェクトの errors 詳細を message に畳み込む", () => {
  const raw = {
    code: "CB_VA01",
    id: "xxxx",
    message: "入力内容が正しくありません。",
    errors: {
      "records[0].顧客No_.value": { messages: ["数値で入力してください。"] },
      "records[1].案件名.value": { messages: ["必須です。", "最大文字数を超えています。"] },
    },
  };
  const err = toDetailedApiError(raw);
  expect(err).toBeInstanceOf(Error);
  const e = err as Error;
  expect(e.message).toBe(
    "入力内容が正しくありません。（CB_VA01）\n"
    + "records[0].顧客No_.value: 数値で入力してください。\n"
    + "records[1].案件名.value: 必須です。 / 最大文字数を超えています。"
  );
  // BatchStatementError.code に kintone のエラーコードが通る
  expect(e.name).toBe("CB_VA01");
});

test("toDetailedApiError: errors なしのエラーオブジェクトは message + code のみ", () => {
  const err = toDetailedApiError({ code: "GAIA_AP01", message: "指定したアプリが見つかりません。" });
  expect((err as Error).message).toBe("指定したアプリが見つかりません。（GAIA_AP01）");
});

test("toDetailedApiError: message のある Error はそのまま通す", () => {
  const original = new Error("boom");
  expect(toDetailedApiError(original)).toBe(original);
});

test.each([
  ["message なしオブジェクト", { code: "X" }],
  ["空 message", { message: "" }],
  ["空白だけの message", { message: "   " }],
  ["undefined", undefined],
])("toDetailedApiError: %s を fallback 文言付き Error に正規化して cause を保持する", (_label, raw) => {
  const err = toDetailedApiError(raw) as Error & { cause?: unknown };
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("ネットワークエラー");
  expect(err.message).toContain("kintone からの応答がありません");
  expect(err.cause).toBe(raw);
});

test("renderError: 複数行 message の Error は行ごとに <br> 区切りで表示される", () => {
  // バッチ経由: runBatchSql が「[N] message」の Error に包み直すため、
  // 詳細行は message 内の改行としてしか届かない
  const html = renderError(new Error("[2] 入力内容が正しくありません。（CB_VA01）\nrecords[0].顧客No_.value: 数値で入力してください。"));
  expect(html).toContain("[2] 入力内容が正しくありません。（CB_VA01）<br>records[0].顧客No_.value: 数値で入力してください。");
});

test.each([new Error(""), {}, undefined])("renderError: 空表示になる値には汎用文言を表示する", (raw) => {
  const html = renderError(raw);
  expect(html).toContain("詳細を取得できませんでした");
  expect(html).not.toContain("[object Object]");
});

test("Cursor 系 Error インスタンスの表示と同一性に影響しない", () => {
  const cursorError = new CursorCleanupWarning(new Error("cleanup failed"));
  expect(toDetailedApiError(cursorError)).toBe(cursorError);
  expect(renderError(cursorError)).toContain("CursorCleanupWarning: Cursor の解放を確認できません。");
});
