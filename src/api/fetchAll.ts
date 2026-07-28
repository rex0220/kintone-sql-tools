// ============================================================
// fetchAll — kintone 全件取得（カーソルベースページング）
//
// kintone API 制約:
//   - 1リクエストで取得できる最大件数: 500件
//   - ページングは query 末尾の "limit 500 offset N" で制御
//   - fetchAll は offset 10000 到達前後で保守的にカーソル方式へ切り替える
//
// 10000件超対応:
//   - offset が KINTONE_MAX_OFFSET (10000) に達したら
//     最後のレコードの $id をカーソルとして "and $id > cursorId order by $id asc"
//     を付与し offset を 0 にリセットする（参照: selectlookup プラグインと同手法）
//
// 設計方針:
//   - kintone.api() への依存を直接持たない
//   - 「1ページ分を取得する関数」を外から注入（Fetcher）
//   - テスト可能・kintone 環境外でも単体テストできる
// ============================================================

import type { KintoneRecord } from "../converter/dmlToKintone";

// ------------------------------------------------------------
// 型定義
// ------------------------------------------------------------

/** kintone GET /k/v1/records.json のレスポンス */
export interface KintoneGetResponse {
  records: KintoneRecord[];
  /** totalCount=true のときに返る query 一致レコード件数 */
  totalCount?: string;
  /** like / not like の 10 万件検索打ち切りを検出した場合に true */
  searchAborted?: boolean;
}

/** 1ページ分の GET を実行する関数 */
export type PageFetcher = (params: PageFetchParams) => Promise<KintoneGetResponse>;

export interface PageFetchParams {
  app: number;
  query: string;   // "WHERE句 order by ... limit 500 offset N" の形式
  fields: string[];
  /** query 一致レコード件数をレスポンスへ含める */
  totalCount?: boolean;
}

// ------------------------------------------------------------
// fetchAll 本体
// ------------------------------------------------------------

export interface FetchAllOptions {
  /** 1ページあたりの取得件数（デフォルト: 500）*/
  pageSize?: number;
  /** 並列取得数（デフォルト: 1 = 直列） */
  parallel?: number;
  /** 全件取得の上限（デフォルト: 10_000）。超えたら FetchAllLimitError */
  maxRecords?: number;
  /** この件数を保持した時点で正常終了する軟停止上限（maxRecords 以下） */
  stopAfter?: number;
  /** 上限到達時の動作（error=例外 / truncate=上限で打ち切って返す） */
  onLimit?: "error" | "truncate";
  /** truncate 時に通知されるコールバック */
  onTruncate?: (maxRecords: number) => void;
  /** ページレスポンスで検索打ち切りを検出したときに通知 */
  onSearchAborted?: () => void;
}

/**
 * kintone アプリの全レコードを取得して返す。
 *
 * @param fetcher  1ページ分を取得する関数（kintone.api のラッパー等）
 * @param app      アプリ ID
 * @param query    WHERE 句（ORDER BY / LIMIT なし）。例: 'ステータス = "完了"'
 * @param fields   取得フィールド一覧（空 = 全フィールド）
 * @param options  pageSize / maxRecords の上書き
 */
export async function fetchAll(
  fetcher: PageFetcher,
  app: number,
  query: string,
  fields: string[],
  options: FetchAllOptions = {}
): Promise<KintoneRecord[]> {
  const pageSize   = options.pageSize   ?? PAGE_SIZE_DEFAULT;
  const parallel   = Math.max(1, options.parallel ?? PARALLEL_DEFAULT);
  const maxRecords = options.maxRecords ?? MAX_RECORDS_DEFAULT;
  const onLimit    = options.onLimit    ?? "error";
  const stopAfter  = options.stopAfter;

  if (
    stopAfter !== undefined &&
    (!Number.isSafeInteger(stopAfter) || stopAfter <= 0 || stopAfter > maxRecords)
  ) {
    throw new RangeError("stopAfter must be a positive safe integer <= maxRecords");
  }
  const fetchCap = stopAfter ?? maxRecords;

  // カーソルページングには $id が必要。fields 指定時に含まれていない場合は追加
  const fetchFields = fields.length > 0 && !fields.includes("$id")
    ? [...fields, "$id"]
    : fields;

  const allRecords: KintoneRecord[] = [];
  let notified = false;
  const limitMessage =
    `取得件数が上限（${maxRecords} 件）を超えました。` +
    "WHERE 句で絞り込むか、maxRecords を引き上げてください。";

  // カーソル状態
  let cursorId     = 0;  // 前のウィンドウで最後に取得したレコードの $id
  let windowOffset = 0;  // 現在のウィンドウ内 offset

  // ---- 先頭ページ ----
  const cursorQuery0 = buildCursorQuery(query, cursorId);
  const first = await fetchPage(fetcher, app, cursorQuery0, fetchFields, pageSize, windowOffset);
  notifySearchAborted(first, options);
  allRecords.push(...first.records);

  if (stopAfter !== undefined && allRecords.length >= stopAfter) {
    return allRecords.slice(0, stopAfter);
  }

  // 上限チェック
  if (allRecords.length > maxRecords) {
    if (onLimit === "truncate") {
      if (!notified && options.onTruncate) { options.onTruncate(maxRecords); notified = true; }
      return allRecords.slice(0, maxRecords);
    }
    throw new FetchAllLimitError(limitMessage);
  }

  // 先頭ページが最終ページなら終了
  if (first.records.length < pageSize) return allRecords;
  windowOffset += pageSize;

  // offset がリミットに達したらカーソルリセット
  if (windowOffset >= KINTONE_MAX_OFFSET) {
    cursorId = getLastId(first.records);
    windowOffset = 0;
  }

  // ---- 2ページ目以降 ----
  while (true) {
    if (stopAfter !== undefined && allRecords.length >= stopAfter) {
      return allRecords.slice(0, stopAfter);
    }

    // 上限に達した時点で次バッチを投げない（parallel 過剰取得を防止）
    if (allRecords.length >= maxRecords) {
      if (onLimit === "truncate") {
        if (!notified && options.onTruncate) { options.onTruncate(maxRecords); notified = true; }
        return allRecords.slice(0, maxRecords);
      }
      throw new FetchAllLimitError(limitMessage);
    }

    const remaining = fetchCap - allRecords.length;
    const maxPagesByLimit = Math.ceil(remaining / pageSize);
    const batchParallel = Math.max(1, Math.min(parallel, maxPagesByLimit));

    // KINTONE_MAX_OFFSET を超えないよう parallel を制限
    const batchOffsets: number[] = [];
    for (let i = 0; i < batchParallel; i++) {
      const off = windowOffset + i * pageSize;
      if (off >= KINTONE_MAX_OFFSET) break;
      batchOffsets.push(off);
    }

    const cq = buildCursorQuery(query, cursorId);
    const responses = await Promise.all(
      batchOffsets.map((offset) =>
        fetchPage(fetcher, app, cq, fetchFields, pageSize, offset)
      )
    );

    // 短い最終ページや上限による early return より前に、
    // 並列バッチの全レスポンスを検査する。
    for (const response of responses) notifySearchAborted(response, options);

    // offset 順に結合して順序を安定化
    let done = false;
    for (const res of responses) {
      allRecords.push(...res.records);

      if (stopAfter !== undefined && allRecords.length >= stopAfter) {
        return allRecords.slice(0, stopAfter);
      }

      // 上限チェック
      if (allRecords.length > maxRecords) {
        if (onLimit === "truncate") {
          if (!notified && options.onTruncate) { options.onTruncate(maxRecords); notified = true; }
          return allRecords.slice(0, maxRecords);
        }
        throw new FetchAllLimitError(limitMessage);
      }

      if (res.records.length < pageSize) { done = true; break; }
    }
    if (done) break;

    windowOffset += pageSize * batchOffsets.length;

    // offset がリミットに達したらカーソルリセット
    if (windowOffset >= KINTONE_MAX_OFFSET) {
      const lastRes = responses[responses.length - 1];
      cursorId = getLastId(lastRes.records);
      windowOffset = 0;
    }
  }

  return allRecords;
}

function notifySearchAborted(response: KintoneGetResponse, options: FetchAllOptions): void {
  if (response.searchAborted) options.onSearchAborted?.();
}

// ------------------------------------------------------------
// GET 後に $id を抽出するヘルパー
// ------------------------------------------------------------

/**
 * fetchAll で取得したレコードから $id（数値）を抽出して返す。
 * UPDATE / DELETE の 2フェーズ目で使用する。
 */
export function extractIds(records: KintoneRecord[]): number[] {
  return records.map((r) => {
    const raw = r["$id"]?.value;
    if (raw === undefined) {
      throw new Error(
        "レコードに $id フィールドが含まれていません。fields に \"$id\" を指定してください。"
      );
    }
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      throw new Error(`$id の値が数値ではありません: ${raw}`);
    }
    return id;
  });
}

// ------------------------------------------------------------
// ヘルパー
// ------------------------------------------------------------

const PAGE_SIZE_DEFAULT   = 500;
const PARALLEL_DEFAULT    = 1;
const MAX_RECORDS_DEFAULT = 10_000;
/** offset 10000 到達前後で保守的にカーソル方式へ切り替える内部閾値。 */
const KINTONE_MAX_OFFSET  = 10_000;

async function fetchPage(
  fetcher: PageFetcher,
  app: number,
  query: string,
  fields: string[],
  pageSize: number,
  offset: number
): Promise<KintoneGetResponse> {
  const pageQuery = buildPageQuery(query, pageSize, offset);
  return fetcher({ app, query: pageQuery, fields });
}

/**
 * カーソル条件を baseQuery に付与する。
 *
 * ページングの安定化のため、初回ウィンドウ（cursorId=0）から常に
 * "order by $id asc" を付与する。順序保証のない offset ページングは
 * 並列取得時の取りこぼし・カーソル切替時の重複取得の原因になる。
 *
 * カーソル条件を AND 結合する際は baseQuery を括弧で包む
 * （"A or B and $id > N" への意味変化を防ぐ）。
 *
 * 例:
 *   buildCursorQuery("", 0)
 *     → "order by $id asc"
 *   buildCursorQuery('ステータス = "完了"', 0)
 *     → 'ステータス = "完了" order by $id asc'
 *   buildCursorQuery('ステータス = "完了"', 500)
 *     → '(ステータス = "完了") and $id > 500 order by $id asc'
 */
export function buildCursorQuery(baseQuery: string, cursorId: number): string {
  const base = baseQuery.trimEnd();
  if (cursorId <= 0) {
    return base ? `${base} order by $id asc` : "order by $id asc";
  }
  const cursor = `$id > ${cursorId} order by $id asc`;
  return base ? `(${base}) and ${cursor}` : cursor;
}

/**
 * 既存のクエリに "limit N offset M" を付与する。
 *
 * kintone クエリのルール:
 *   - limit / offset は末尾に置く
 *   - すでに limit / offset が含まれている場合は上書きしない
 *     （fetchAll に渡す query には limit/offset を含めないことを前提とする）
 *
 * 例:
 *   query="" → "limit 500 offset 0"
 *   query='ステータス = "完了"' → 'ステータス = "完了" limit 500 offset 0'
 *   query='$id > 0 order by $id asc'
 *     → '$id > 0 order by $id asc limit 500 offset 0'
 */
export function buildPageQuery(
  query: string,
  pageSize: number,
  offset: number
): string {
  const base = query.trimEnd();
  const suffix = `limit ${pageSize} offset ${offset}`;
  return base ? `${base} ${suffix}` : suffix;
}

/** レコード配列の末尾の $id を取得する */
function getLastId(records: KintoneRecord[]): number {
  const last = records[records.length - 1];
  const raw = last?.["$id"]?.value;
  if (raw === undefined) return 0;
  const id = Number(raw);
  return Number.isFinite(id) ? id : 0;
}

// ------------------------------------------------------------
// エラー
// ------------------------------------------------------------

export class FetchAllLimitError extends Error {
  constructor(message: string, readonly completeInputWrapped = false) {
    super(message);
    this.name = "FetchAllLimitError";
  }
}
