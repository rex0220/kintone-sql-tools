import {
  fetchAll,
  extractIds,
  buildPageQuery,
  buildCursorQuery,
  FetchAllLimitError,
  PageFetcher,
  KintoneGetResponse,
} from "../fetchAll";
import type { KintoneRecord } from "../../converter/dmlToKintone";

// ----------------------------------------------------------------
// buildPageQuery
// ----------------------------------------------------------------

test("buildPageQuery: クエリなし", () => {
  expect(buildPageQuery("", 500, 0)).toBe("limit 500 offset 0");
});

test("buildPageQuery: WHERE 句あり", () => {
  expect(buildPageQuery('ステータス = "完了"', 500, 0))
    .toBe('ステータス = "完了" limit 500 offset 0');
});

test("buildPageQuery: ORDER BY あり・offset 500", () => {
  expect(buildPageQuery("ステータス = \"完了\" order by 作成日 desc", 500, 500))
    .toBe("ステータス = \"完了\" order by 作成日 desc limit 500 offset 500");
});

// ----------------------------------------------------------------
// buildCursorQuery
// ----------------------------------------------------------------

test("buildCursorQuery: baseQuery なし・cursorId=0", () => {
  expect(buildCursorQuery("", 0)).toBe("");
});

test("buildCursorQuery: baseQuery あり・cursorId=0", () => {
  expect(buildCursorQuery('ステータス = "完了"', 0))
    .toBe('ステータス = "完了"');
});

test("buildCursorQuery: cursorId > 0（カーソルリセット後）", () => {
  expect(buildCursorQuery('ステータス = "完了"', 9500))
    .toBe('ステータス = "完了" and $id > 9500 order by $id asc');
});

// ----------------------------------------------------------------
// fetchAll モック
// ----------------------------------------------------------------

/** N 件のダミーレコードを生成する */
function makeRecords(count: number, startId = 1): KintoneRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    $id: { value: String(startId + i) },
  }));
}

/** ページごとにレコードを返す Fetcher のモック */
function mockFetcher(pages: KintoneRecord[][]): PageFetcher {
  let pageIndex = 0;
  return async (): Promise<KintoneGetResponse> => {
    const records = pages[pageIndex] ?? [];
    pageIndex++;
    return { records };
  };
}

/**
 * クエリ文字列を検査できる Fetcher のモック。
 * 各ページのクエリを記録する。
 */
function recordingFetcher(
  pages: KintoneRecord[][],
  calls: string[]
): PageFetcher {
  let pageIndex = 0;
  return async (params): Promise<KintoneGetResponse> => {
    calls.push(params.query);
    const records = pages[pageIndex] ?? [];
    pageIndex++;
    return { records };
  };
}

// ----------------------------------------------------------------
// fetchAll — ページング
// ----------------------------------------------------------------

test("1ページで収まる場合（499件）", async () => {
  const records = makeRecords(499);
  const fetcher = mockFetcher([records]);
  const result = await fetchAll(fetcher, 100, "", []);
  expect(result).toHaveLength(499);
});

test("ちょうど500件 → 2回目の取得（0件）で終了", async () => {
  const fetcher = mockFetcher([makeRecords(500), []]);
  const result = await fetchAll(fetcher, 100, "", []);
  expect(result).toHaveLength(500);
});

test("1500件: 3ページ（500+500+500）→ 4回目 0件で終了", async () => {
  const fetcher = mockFetcher([
    makeRecords(500, 1),
    makeRecords(500, 501),
    makeRecords(500, 1001),
    [],
  ]);
  const result = await fetchAll(fetcher, 100, "", []);
  expect(result).toHaveLength(1500);
});

test("1501件: 4ページ（500+500+500+1）", async () => {
  const fetcher = mockFetcher([
    makeRecords(500, 1),
    makeRecords(500, 501),
    makeRecords(500, 1001),
    makeRecords(1, 1501),
  ]);
  const result = await fetchAll(fetcher, 100, "", []);
  expect(result).toHaveLength(1501);
});

test("offset がページごとに正しく付与される（カーソルクエリ形式）", async () => {
  const calls: string[] = [];
  const fetcher = recordingFetcher(
    [makeRecords(500), makeRecords(500), makeRecords(1), []],
    calls
  );
  await fetchAll(fetcher, 100, 'ステータス = "完了"', [], { pageSize: 500 });

  expect(calls[0]).toBe('ステータス = "完了" limit 500 offset 0');
  expect(calls[1]).toBe('ステータス = "完了" limit 500 offset 500');
  expect(calls[2]).toBe('ステータス = "完了" limit 500 offset 1000');
});

test("pageSize オプションを変更できる", async () => {
  const calls: string[] = [];
  const fetcher = recordingFetcher([makeRecords(100), []], calls);
  await fetchAll(fetcher, 100, "", [], { pageSize: 100 });
  expect(calls[0]).toContain("limit 100 offset 0");
});

test("parallel オプションで複数ページを同時取得しても offset 順で結合される", async () => {
  const fetcher: PageFetcher = async (params) => {
    if (params.query.endsWith("offset 0")) {
      return { records: makeRecords(500, 1) };
    }
    if (params.query.endsWith("offset 500")) {
      await new Promise((r) => setTimeout(r, 30));
      return { records: makeRecords(500, 501) };
    }
    if (params.query.endsWith("offset 1000")) {
      await new Promise((r) => setTimeout(r, 1));
      return { records: makeRecords(500, 1001) };
    }
    return { records: [] };
  };

  const result = await fetchAll(fetcher, 100, "", [], { parallel: 2 });
  expect(result).toHaveLength(1500);
  expect(result[0].$id.value).toBe("1");
  expect(result[499].$id.value).toBe("500");
  expect(result[500].$id.value).toBe("501");
  expect(result[1499].$id.value).toBe("1500");
});

// ----------------------------------------------------------------
// fetchAll — offset 10000 超のカーソルリセット
// ----------------------------------------------------------------

test("10000件超: offset リセット後に $id > lastId クエリが発行される", async () => {
  const calls: string[] = [];
  // pageSize=500 で 21 ページ = 10500件、maxRecords=11000
  // ページ 1〜20: offset 0〜9500 (各500件、$id 1〜10000)
  // ページ 21: カーソルリセット後 offset 0、$id > 10000 のクエリ
  const pages: KintoneRecord[][] = [
    ...Array.from({ length: 20 }, (_, i) => makeRecords(500, i * 500 + 1)),
    makeRecords(500, 10001),  // カーソルリセット後の1ページ目
    [],
  ];
  const fetcher = recordingFetcher(pages, calls);

  const result = await fetchAll(fetcher, 100, "", [], {
    pageSize: 500,
    maxRecords: 11000,
  });

  expect(result).toHaveLength(10500);

  // ページ 1〜20: baseQuery（空）で offset 0〜9500
  expect(calls[0]).toBe("limit 500 offset 0");
  expect(calls[19]).toBe("limit 500 offset 9500");

  // ページ 21: カーソルが 10000 にリセットされ offset 0 から再開
  expect(calls[20]).toBe("$id > 10000 order by $id asc limit 500 offset 0");
});

test("10000件超でも maxRecords=10000 なら上限エラー", async () => {
  // 21ページ分のデータがあっても maxRecords=10000 で打ち切り
  const pages: KintoneRecord[][] = [
    ...Array.from({ length: 20 }, (_, i) => makeRecords(500, i * 500 + 1)),
    makeRecords(500, 10001),
    [],
  ];
  const fetcher = mockFetcher(pages);

  await expect(
    fetchAll(fetcher, 100, "", [], { maxRecords: 10000 })
  ).rejects.toThrow(FetchAllLimitError);
});

// ----------------------------------------------------------------
// fetchAll — 上限チェック
// ----------------------------------------------------------------

test("maxRecords を超えると FetchAllLimitError", async () => {
  // pageSize=500 で 1501件返す → maxRecords=1000 を超える
  const fetcher = mockFetcher([
    makeRecords(500),
    makeRecords(500),
    makeRecords(500),
    [],
  ]);
  await expect(
    fetchAll(fetcher, 100, "", [], { maxRecords: 1000 })
  ).rejects.toThrow(FetchAllLimitError);
});

test("maxRecords=3000 + parallel=5（truncate）で余分な先読みページを投げない", async () => {
  const calls: string[] = [];
  const pages: KintoneRecord[][] = [
    ...Array.from({ length: 20 }, (_, i) => makeRecords(500, i * 500 + 1)),
    [],
  ];
  const fetcher = recordingFetcher(pages, calls);

  const result = await fetchAll(fetcher, 100, "", [], {
    maxRecords: 3000,
    parallel: 5,
    onLimit: "truncate",
  });

  expect(result).toHaveLength(3000);
  expect(calls).toHaveLength(6); // offset 0,500,1000,1500,2000,2500 だけ
  expect(calls.some((q) => q.endsWith("offset 3000"))).toBe(false);
  expect(calls.some((q) => q.endsWith("offset 5000"))).toBe(false);
});

// ----------------------------------------------------------------
// extractIds
// ----------------------------------------------------------------

test("extractIds: $id を数値に変換", () => {
  const records: KintoneRecord[] = [
    { $id: { value: "1" } },
    { $id: { value: "42" } },
    { $id: { value: "100" } },
  ];
  expect(extractIds(records)).toEqual([1, 42, 100]);
});

test("extractIds: $id が存在しないレコードはエラー", () => {
  const records: KintoneRecord[] = [{ 名前: { value: "田中" } }];
  expect(() => extractIds(records)).toThrow("$id フィールドが含まれていません");
});

test("extractIds: $id が数値でない場合はエラー", () => {
  const records: KintoneRecord[] = [{ $id: { value: "abc" } }];
  expect(() => extractIds(records)).toThrow("数値ではありません");
});
