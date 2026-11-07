import { createKintoneClient } from "../writableClient";
import type { CreateKintoneClientConfig } from "../publicTypes";

/**
 * B206: 外のレコード（ブラウザーが持っているもの）を**既定の名称にそろえる**口。
 *
 * 形は依頼元のアプリ 4387 に合わせる（KJ-10 §6）。**実 API の形を崩さない**＝
 * プロセス管理が有効なアプリは `form/fields` が `STATUS` / `STATUS_ASSIGNEE` / `CATEGORY` を返し、
 * 言語ごとの表示名を設定した項目は `lang=user` で**選択肢のキーごと変わる**（B205 で 3 回刺された点）。
 */
const DISPLAY: Record<string, string> = {
  sample1: "サンプル１", sample2: "サンプル２",
  detail1: "明細１", detail2: "明細２",
  mark1: "印１", mark2: "印２",
};
const STATUS_DISPLAY: Record<string, string> = {
  未処理: "みしょり", 処理中: "しょりちゅう", 完了: "かんりょう",
};

/** `app/form/fields.json` の形（`lang` なし＝既定名 / `lang=user`＝表示名）。 */
const formProperties = (lang: "default" | "user") => {
  const name = (canonical: string) => lang === "user" ? DISPLAY[canonical] : canonical;
  const options = (...canonicals: string[]) => Object.fromEntries(
    canonicals.map((canonical, index) => [name(canonical), { label: name(canonical), index: String(index) }])
  );
  return {
    ラジオボタン: { type: "RADIO_BUTTON", code: "ラジオボタン", label: "ラジオボタン", options: options("sample1", "sample2") },
    // 言語ごとの表示名を設定していない項目（値は両方の `lang` で同じ）。
    // 選択肢の `未処理` は**ステータスの既定名と同じ文字列**＝表が混ざらないことを見る
    処理状況: {
      type: "DROP_DOWN", code: "処理状況", label: "処理状況",
      options: { 未処理: { label: "未処理", index: "0" }, 処理済: { label: "処理済", index: "1" } },
    },
    担当者: { type: "SINGLE_LINE_TEXT", code: "担当者", label: "担当者" },
    金額: { type: "NUMBER", code: "金額", label: "金額" },
    明細: {
      type: "SUBTABLE", code: "明細", label: "明細",
      fields: {
        明細区分: { type: "DROP_DOWN", code: "明細区分", label: "明細区分", options: options("detail1", "detail2") },
        明細印: { type: "CHECK_BOX", code: "明細印", label: "明細印", options: options("mark1", "mark2") },
      },
    },
    // プロセス管理が有効なアプリは次の 3 つも返る（`CATEGORY` は無効でも返る）
    ステータス: { type: "STATUS", code: "ステータス", label: "ステータス", enabled: true },
    作業者: { type: "STATUS_ASSIGNEE", code: "作業者", label: "作業者", enabled: true },
    カテゴリー: { type: "CATEGORY", code: "カテゴリー", label: "カテゴリー", enabled: false },
  };
};

const statusBody = (localized: boolean, duplicateName = false) => ({
  enable: true,
  states: Object.fromEntries(Object.keys(STATUS_DISPLAY).map((canonical, index) => [
    canonical,
    {
      // 2 つのステータスに**同じ言語ごとの名称**を付けたアプリ（`status.json` のキーは既定名なので、
      // この形は実機で起こり得る。読み戻しが多対一になるので受け取らない）
      name: duplicateName ? "おなじ" : localized ? STATUS_DISPLAY[canonical] : canonical,
      index: String(index),
    },
  ])),
});

interface FetchLog { readonly url: string }

function clientFor(
  options: { localized?: boolean; duplicateStatusName?: boolean; collapsedOption?: boolean } = {}
) {
  const localized = options.localized ?? true;
  const calls: FetchLog[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes("/app/form/fields.json")) {
      const lang = url.includes("lang=user") ? "user" : "default";
      if (lang === "user" && options.collapsedOption === true) {
        // 2 つの選択肢に**同じ表示名**を付けたアプリ。`lang=user` の options はその名前で引くので
        // **1 つに潰れて返る**（キーが重複できないため）＝件数が合わず index で対にできない
        return json({ properties: {
          ...formProperties("user"),
          ラジオボタン: {
            type: "RADIO_BUTTON", code: "ラジオボタン", label: "ラジオボタン",
            options: { 同じ名前: { label: "同じ名前", index: "0" } },
          },
        } });
      }
      return json({ properties: formProperties(lang === "user" && localized ? "user" : "default") });
    }
    if (url.includes("/app/status.json")) {
      return json(statusBody(localized, options.duplicateStatusName === true));
    }
    throw new Error(`想定していない要求: ${url}`);
  };
  const config: CreateKintoneClientConfig = {
    baseUrl: "https://example.cybozu.com",
    auth: { type: "apiToken", apiToken: "dummy" },
    fetch: fetchImpl,
  };
  return { client: createKintoneClient(config), calls };
}

/** ブラウザーのレコード（`kintone.app.record.get()` の形）。 */
const browserRecord = () => ({
  $id: { type: "__ID__", value: "227" },
  $revision: { type: "__REVISION__", value: "3" },
  ラジオボタン: { type: "RADIO_BUTTON", value: "サンプル１" },
  処理状況: { type: "DROP_DOWN", value: "未処理" },
  担当者: { type: "SINGLE_LINE_TEXT", value: "鈴木" },
  金額: { type: "NUMBER", value: "150000" },
  ステータス: { type: "STATUS", value: "みしょり" },
  作業者: { type: "STATUS_ASSIGNEE", value: [{ code: "user1", name: "鈴木" }] },
  カテゴリー: { type: "CATEGORY", value: [] },
  明細: {
    type: "SUBTABLE",
    value: [
      { id: "1", value: { 明細区分: { type: "DROP_DOWN", value: "明細１" }, 明細印: { type: "CHECK_BOX", value: ["印１"] } } },
      { id: "2", value: { 明細区分: { type: "DROP_DOWN", value: "明細２" }, 明細印: { type: "CHECK_BOX", value: ["印１", "印２"] } } },
    ],
  },
});

test("B206 AC1: 選択肢とステータスが既定の名称になる", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const result = normalize(browserRecord());
  expect(result.ラジオボタン.value).toBe("sample1");
  expect(result.ステータス.value).toBe("未処理");
});

test("B206 AC2: 表示名を設定していない項目は不変（ステータスの表と混ざらない）", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const result = normalize(browserRecord());
  // `処理状況` の「未処理」はステータスの既定名と同じ文字列。項目の表で引くので変わらない
  expect(result.処理状況.value).toBe("未処理");
  expect(result.担当者.value).toBe("鈴木");
  expect(result.金額.value).toBe("150000");
});

test("B206 AC3: 選択肢に無い値はそのまま通る", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const record = { ...browserRecord(), ラジオボタン: { type: "RADIO_BUTTON", value: "サンプル３" } };
  expect(normalize(record).ラジオボタン.value).toBe("サンプル３");
});

test("B206 AC4: サブテーブルの単値と配列の両方が既定の名称になる", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const rows = normalize(browserRecord()).明細.value as Array<{ id: string; value: Record<string, { value: unknown }> }>;
  expect(rows.map((row) => row.value.明細区分.value)).toEqual(["detail1", "detail2"]);
  expect(rows.map((row) => row.value.明細印.value)).toEqual([["mark1"], ["mark1", "mark2"]]);
  // 行の id は保つ
  expect(rows.map((row) => row.id)).toEqual(["1", "2"]);
});

test("B206 AC5: 入力のレコードを書き換えない（画面の値を壊さない）", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const record = browserRecord();
  const before = JSON.parse(JSON.stringify(record));
  const result = normalize(record);
  expect(record).toEqual(before);
  expect(result).not.toBe(record);
  expect(result.ラジオボタン).not.toBe(record.ラジオボタン);
  // 触らない項目は同じ参照のまま（無駄な複製をしない）
  expect(result.担当者).toBe(record.担当者);
});

test("B206 AC6: ステータスに同じ名称を付けたアプリは作る時点で ArgumentError", async () => {
  const { client } = clientFor({ duplicateStatusName: true });
  await expect(client.createRecordNormalizer(4387))
    .rejects.toThrow('display name "おなじ" is used by more than one option');
});

test("B206 AC6: 選択肢に同じ表示名を付けたアプリも作る時点で ArgumentError", async () => {
  // `lang=user` の options が 1 つに潰れて返るので、件数が合わず index で対にできない
  const { client } = clientFor({ collapsedOption: true });
  await expect(client.createRecordNormalizer(4387))
    .rejects.toThrow("the mapping cannot be paired by index");
});

test("B206: ステータスは type で見つける（項目コードが違っても・1 項目だけでも当たる）", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  // 依頼元の @_status / @_prev_status の正規化（KJ-10 の質問 4）
  expect(normalize({ ステータス: { type: "STATUS", value: "みしょり" } }).ステータス.value).toBe("未処理");
  // 英語で作ったアプリの項目コード
  expect(normalize({ Status: { type: "STATUS", value: "かんりょう" } }).Status.value).toBe("完了");
  // キーの名前は何でもよい
  expect(normalize({ s: { type: "STATUS", value: "しょりちゅう" } }).s.value).toBe("処理中");
});

test("B206: 作業者とカテゴリーは素通し", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const record = browserRecord();
  const result = normalize(record);
  expect(result.作業者).toBe(record.作業者);
  expect(result.カテゴリー).toBe(record.カテゴリー);
});

test("B206: 言語ごとの表示名が無いアプリは素通しの関数（同じ参照を返す）", async () => {
  const { client } = clientFor({ localized: false });
  const normalize = await client.createRecordNormalizer(4387);
  const record = browserRecord();
  expect(normalize(record)).toBe(record);
});

test("B206: null・数値・{ code } の配列は触らない", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const record = {
    ラジオボタン: { type: "RADIO_BUTTON", value: null },
    金額: { type: "NUMBER", value: 150000 },
    作業者: { type: "STATUS_ASSIGNEE", value: [{ code: "user1", name: "鈴木" }] },
  };
  const result = normalize(record);
  expect(result).toBe(record);
});

test("B206: 通信は 3 回（既定名の項目定義 1 ＋ 表示名の項目定義とプロセス管理 2）", async () => {
  const { client, calls } = clientFor();
  await client.createRecordNormalizer(4387);
  expect(calls).toHaveLength(3);
  expect(calls.filter((call) => call.url.includes("lang=user"))).toHaveLength(2);
  expect(calls.filter((call) => call.url.includes("/app/form/fields.json") && !call.url.includes("lang="))).toHaveLength(1);
});

test("B206: 返りは渡した型のまま（キャストが要らない）", async () => {
  const { client } = clientFor();
  const normalize = await client.createRecordNormalizer(4387);
  const record = { ラジオボタン: { type: "RADIO_BUTTON", value: "サンプル２" } };
  const result: typeof record = normalize(record);
  expect(result.ラジオボタン.value).toBe("sample2");
});
