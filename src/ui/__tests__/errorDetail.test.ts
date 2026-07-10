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

test("toDetailedApiError: Error / 文字列 / message なしオブジェクトはそのまま通す", () => {
  const original = new Error("boom");
  expect(toDetailedApiError(original)).toBe(original);
  expect(toDetailedApiError("plain")).toBe("plain");
  const noMessage = { code: "X" };
  expect(toDetailedApiError(noMessage)).toBe(noMessage);
});

test("renderError: 複数行 message の Error は行ごとに <br> 区切りで表示される", () => {
  // バッチ経由: runBatchSql が「[N] message」の Error に包み直すため、
  // 詳細行は message 内の改行としてしか届かない
  const html = renderError(new Error("[2] 入力内容が正しくありません。（CB_VA01）\nrecords[0].顧客No_.value: 数値で入力してください。"));
  expect(html).toContain("[2] 入力内容が正しくありません。（CB_VA01）<br>records[0].顧客No_.value: 数値で入力してください。");
});
