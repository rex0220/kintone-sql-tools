// ============================================================
// renderResult — ExecuteResult を HTML 文字列に変換する
// ============================================================

import type { ExecuteResult, SelectResult, UpsertResult, ProcessRow } from "../core";

// ============================================================
// 表示オプション
// ============================================================

export interface DisplayOptions {
  /** ユーザー系フィールド（CREATOR / MODIFIER / USER_SELECT 等）の表示形式 */
  userFormat?:  "full" | "name" | "code";
  /** 配列フィールド（CHECK_BOX / MULTI_SELECT / ユーザー複数選択 等）の表示形式 */
  arrayFormat?: "full" | "join";
  /** サブテーブルフィールドの表示形式 */
  tableFormat?: "full" | "count";
  /** 日付・日時フィールドの表示形式 */
  dateFormat?:  "full" | "local";
  /** 添付ファイルフィールドの表示形式 */
  attachmentFormat?: "full" | "name" | "fileKey";
}

// ============================================================
// メイン
// ============================================================

export function renderResult(result: ExecuteResult, opts: DisplayOptions = {}): string {
  switch (result.type) {
    case "SELECT": return renderSelect(result, opts);
    case "INSERT": return renderSuccess(`${result.insertedCount} 件のレコードを登録しました。${isolationSuffix(result)}`);
    case "UPDATE": return renderSuccess(`${result.updatedCount} 件のレコードを更新しました。${isolationSuffix(result)}`);
    case "DELETE": return renderSuccess(`${result.deletedCount} 件のレコードを削除しました。`);
    case "REORDER": return renderSuccess(`${result.reorderedParentCount} 件の親レコードで並び順を更新しました。`);
    case "UPSERT": return renderSuccess(
      `登録 ${result.insertedCount} 件 / 更新 ${result.updatedCount} 件${isolationSuffix(result)}`
    );
    case "ASSERT": return renderSuccess(`アサーション成立: ${result.condition}`);
    case "VALIDATION": {
      const importSuffix = result.importDetail
        ? ` / IMPORT実データpreflight / mutation候補 ${result.importDetail.parents.mutationCandidates} 件 / 書込み 0`
        : "";
      const summary = renderInfo(`検証 ${result.validatedRows} 件 / 正常 ${result.validRows} 件 / 不正 ${result.invalidRows} 件 / エラー ${result.errorCount} 件${importSuffix}`);
      const applySummary = (result.apply ?? []).map((detail) => renderInfo(
        `APPLY ${detail.field}: ${detail.operations.map((operation) =>
          operation.kind === "APPEND"
            ? `APPEND 追加 ${operation.addedRows}`
            : `PATCH 一致 ${operation.matchedRows} / 変更 ${operation.changedRows}`
        ).join("; ")} / 変更子行 ${detail.changedSubtableRows} / 削除 ${detail.deletedRows}`
      )).join("");
      const guardSummary = result.guards
        ? result.guards.wouldExceed
          ? `<div class="ksql-warn">${escHtml(
            `安全ガード超過: 親 ${result.guards.parentRows}/${result.guards.dmlMaxRows}, ` +
            `子 ${result.guards.subtableRows}/${result.guards.dmlMaxSubtableRows}（書込み 0）`
          )}</div>`
          : renderInfo(
            `安全ガード: 親 ${result.guards.parentRows}/${result.guards.dmlMaxRows}, ` +
            `子 ${result.guards.subtableRows}/${result.guards.dmlMaxSubtableRows} / revision 必須 / 書込み 0`
          )
        : "";
      if (result.errorCount === 0) return `${summary}${applySummary}${guardSummary}${renderInfo("検証エラーはありません。")}`;
      return `${summary}${applySummary}${guardSummary}${renderSelect({ type: "SELECT", columns: result.columns, rows: result.errors, rowCount: result.errorCount }, opts)}`;
    }
  }
}

/** バッチの情報行を文順に並べ、最終結果セットを続けて描画する。 */
export function renderBatchResult(
  result: ExecuteResult | null,
  infoLines: readonly string[],
  opts: DisplayOptions = {}
): string {
  const infoHtml = infoLines.map(renderInfo).join("");
  return `${infoHtml}${result ? renderResult(result, opts) : ""}`;
}

/** VALIDATE INTO は結果表を表示せず、実体化した統計を情報行として表示する。 */
export function formatValidateIntoStats(result: SelectResult, tempName: string): string | null {
  if (!result.validateStats) return null;
  return `VALIDATE: エラー ${result.validateStats.errorRecords} レコード / ${result.validateStats.errorCount} 件（${tempName} へ ${result.rowCount} 行）`;
}

function isolationSuffix(result: { skippedRows?: number; errTable?: string }): string {
  // 隔離は ON ERROR SKIP INTO #err のときだけ。errTable が無ければ「（undefined）」を出さない。
  if (result.skippedRows === undefined || result.errTable === undefined) return "";
  return ` 隔離 ${result.skippedRows} 件（${result.errTable}）`;
}

export function renderError(err: unknown): string {
  const lines: string[] = [];
  const fallback = "エラーが発生しましたが、詳細を取得できませんでした。";

  if (err instanceof Error) {
    // kintoneClient.toDetailedApiError はフィールド単位の詳細を改行区切りで
    // message に畳み込む（バッチ経由では message しか運ばれないため）。行に展開する
    lines.push(...err.message.split("\n"));
  } else if (isKintoneApiError(err)) {
    lines.push(err.message);
    for (const [field, detail] of Object.entries(err.errors ?? {})) {
      for (const m of detail.messages) {
        lines.push(`  ${field}: ${m}`);
      }
    }
  } else {
    const text = err === null || err === undefined || typeof err === "object"
      ? fallback
      : String(err);
    lines.push(text);
  }

  const displayLines = lines.filter((line) => line.trim() !== "");
  const html = (displayLines.length > 0 ? displayLines : [fallback]).map((l) => escHtml(l)).join("<br>");
  return `<div class="ksql-error"><span class="ksql-error-icon">⚠</span>${html}</div>`;
}

interface KintoneApiError {
  code: string;
  message: string;
  errors?: Record<string, { messages: string[] }>;
}

function isKintoneApiError(v: unknown): v is KintoneApiError {
  return (
    typeof v === "object" && v !== null &&
    "message" in v && typeof (v as Record<string, unknown>).message === "string" &&
    "code"    in v && typeof (v as Record<string, unknown>).code    === "string"
  );
}

export function renderLoading(): string {
  return `<div class="ksql-loading">実行中...</div>`;
}

// ============================================================
// SELECT 結果テーブル
// ============================================================

function renderSelect(result: SelectResult, opts: DisplayOptions): string {
  const warnings = [...(result.warnings ?? [])];

  const viewRows = result.rows.length > RENDER_ROW_MAX
    ? result.rows.slice(0, RENDER_ROW_MAX)
    : result.rows;
  if (result.rows.length > RENDER_ROW_MAX) {
    warnings.push(`表示件数が多いため、先頭 ${RENDER_ROW_MAX} 件のみ表示しています。`);
  }

  const warnHtml = warnings
    .map((w) => `<div class="ksql-warn">${escHtml(w)}</div>`)
    .join("");

  if (result.rows.length === 0) {
    const emptyMessage = result.validateStats
      ? `エラー ${result.validateStats.errorRecords} レコード / ${result.validateStats.errorCount} 件（表示 0 行）`
      : "0 件でした。";
    return `${warnHtml}${renderInfo(emptyMessage)}`;
  }

  const headers = result.columns.length > 0 ? result.columns : Object.keys(viewRows[0]);
  const headerHtml = headers
    .map((h, i) => `<th class="ksql-sortable-th" data-col-index="${i}">${escHtml(h)}</th>`)
    .join("");
  const bodyHtml = viewRows
    .map((row, i) => renderRow(row, headers, opts, i + 1))
    .join("");

  return `
${warnHtml}
<div class="ksql-result-meta">
  <span>${result.validateStats
    ? `エラー ${result.validateStats.errorRecords} レコード / ${result.validateStats.errorCount} 件（表示 <span class="ksql-result-count">${result.rowCount}</span> 行）`
    : `<span class="ksql-result-count">${result.rowCount}</span> 件`}</span>
  <button type="button" class="ksql-result-full-btn" aria-label="全画面表示" title="全画面表示">⤢</button>
</div>
<div class="ksql-result-filter-row">
  <input class="ksql-result-filter-input" type="text" placeholder="結果をフィルター..." />
</div>
<div class="ksql-table-wrapper">
  <table class="ksql-table">
    <thead><tr><th class="ksql-rowno-th">#</th>${headerHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</div>`.trim();
}

function renderRow(row: ProcessRow, headers: string[], opts: DisplayOptions, rowNo: number): string {
  const values = headers.map((h) => formatCellValue(String(row[h] ?? ""), opts));
  const cells = values.map((v, i) => renderCell(v, headers[i])).join("");
  const searchText = buildSearchText(values, SEARCH_TEXT_MAX);
  return `<tr data-search="${escHtml(searchText)}"><td class="ksql-rowno-td">${rowNo}</td>${cells}</tr>`;
}

function renderCell(v: CellRenderValue, header: string): string {
  const text = clampText(v.text, CELL_TEXT_MAX);
  if (v.subtableRowsJson) {
    const total = v.subtableTotal ?? 0;
    return `<td><button type="button" class="ksql-subtbl-count" data-ksql-subtbl="${escHtml(v.subtableRowsJson)}" data-ksql-subtbl-total="${total}" data-ksql-subtbl-field="${escHtml(header)}">${escHtml(text)}</button></td>`;
  }
  return `<td>${escHtml(text)}</td>`;
}

// ============================================================
// セル値整形（ユーザー系・配列・サブテーブル・日付フィールド対応）
// ============================================================

// --- 日付パターン ---
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function fmtDateStr(raw: string): string {
  if (DATE_RE.test(raw)) {
    return raw.replace(/-/g, "/");               // "2024-04-01" → "2024/04/01"
  }
  if (DATETIME_RE.test(raw)) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return raw;
}

// --- ユーザーオブジェクト ---
interface UserObj { code: string; name?: string; }
interface AttachmentObj { fileKey?: string; name?: string; }

function isUserObj(v: unknown): v is UserObj {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    "code" in v && typeof (v as Record<string, unknown>).code === "string"
  );
}

function isAttachmentObj(v: unknown): v is AttachmentObj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "fileKey" in obj || "name" in obj;
}

function fmtUser(u: UserObj, fmt: "full" | "name" | "code"): string {
  if (fmt === "name") return u.name ?? u.code;
  if (fmt === "code") return u.code;
  return JSON.stringify(u);
}

// --- サブテーブル行判定: [{id:"...", value:{...}}, ...] ---
function isSubtableRow(v: unknown): v is { id: string; value: Record<string, unknown> } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj["id"] === "string" && typeof obj["value"] === "object" && obj["value"] !== null;
}

interface CellRenderValue {
  text: string;
  subtableRowsJson?: string;
  subtableTotal?: number;
}

const SEARCH_TEXT_MAX = 2048;
const RENDER_ROW_MAX = 3000;
const CELL_TEXT_MAX = 10000;

function buildSearchText(values: CellRenderValue[], maxLen: number): string {
  let out = "";
  for (const v of values) {
    const part = String(v.text ?? "");
    if (part === "") continue;
    if (out.length > 0) out += " ";
    const remain = maxLen - out.length;
    if (remain <= 0) break;
    out += part.length > remain ? part.slice(0, remain) : part;
  }
  return out.toLowerCase();
}

function clampText(raw: string, maxLen: number): string {
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)} ...(truncated)`;
}

function toDisplayText(v: unknown, opts: DisplayOptions): string {
  // kintone サブテーブルのセル値は { type, value } 形式のため value を優先する
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if ("value" in obj) {
      return toDisplayText(obj["value"], opts);
    }
  }
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return formatCellValue(v, opts).text;
  if (typeof v === "number" || typeof v === "boolean") return formatCellValue(String(v), opts).text;
  try {
    return formatCellValue(JSON.stringify(v), opts).text;
  } catch {
    return String(v);
  }
}

function formatCellValue(raw: string, opts: DisplayOptions): CellRenderValue {
  const userFmt  = opts.userFormat  ?? "full";
  const arrFmt   = opts.arrayFormat ?? "full";
  const tblFmt   = opts.tableFormat ?? "full";
  const dateFmt  = opts.dateFormat  ?? "full";
  const attFmt   = opts.attachmentFormat ?? "full";

  // 日付・日時（JSON ではなく平文文字列）
  if (dateFmt !== "full" && (DATE_RE.test(raw.trim()) || DATETIME_RE.test(raw.trim()))) {
    return { text: fmtDateStr(raw.trim()) };
  }

  // すべて "full" なら変換不要
  if (userFmt === "full" && arrFmt === "full" && tblFmt === "full" && attFmt === "full") return { text: raw };

  const str = raw.trim();
  if (str === "" || (str[0] !== "{" && str[0] !== "[")) return { text: raw };

  let parsed: unknown;
  try { parsed = JSON.parse(str); } catch { return { text: raw }; }

  // 単一ユーザーオブジェクト: {"code":"...", "name":"..."}
  if (isUserObj(parsed)) {
    return { text: fmtUser(parsed, userFmt) };
  }

  // 配列
  if (Array.isArray(parsed) && parsed.length > 0) {
    const items = parsed as unknown[];

    // サブテーブル: [{id, value}, ...]
    if (tblFmt === "count" && items.every(isSubtableRow)) {
      const rows = (items as Array<{ id: string; value: Record<string, unknown> }>)
        .slice(0, 100)
        .map((r) => {
          const o: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.value)) {
            o[k] = toDisplayText(v, opts);
          }
          return o;
        });
      return {
        text: `${items.length} 行`,
        subtableRowsJson: JSON.stringify(rows),
        subtableTotal: items.length,
      };
    }

    // ユーザーオブジェクトの配列
    if (items.every(isUserObj)) {
      const parts = (items as UserObj[]).map((u) => fmtUser(u, userFmt));
      return { text: arrFmt === "join" ? parts.join(", ") : parts.join(" / ") };
    }

    // 添付ファイル配列
    if (items.every(isAttachmentObj)) {
      if (attFmt === "full") return { text: raw };
      const parts = (items as AttachmentObj[]).map((a) => {
        if (attFmt === "name") return a.name ?? "";
        return a.fileKey ?? "";
      }).filter((v) => v !== "");
      return { text: parts.join(", ") };
    }

    // 文字列配列（CHECK_BOX / MULTI_SELECT 等）
    if (arrFmt === "join") {
      return { text: items.map(String).join(", ") };
    }
  }

  return { text: raw };
}

// ============================================================
// 共通メッセージ
// ============================================================

function renderSuccess(msg: string): string {
  return `<div class="ksql-success"><span class="ksql-success-icon">✓</span>${escHtml(msg)}</div>`;
}

function renderInfo(msg: string): string {
  return `<div class="ksql-info">${escHtml(msg)}</div>`;
}

// ============================================================
// XSS 対策: HTML エスケープ
// ============================================================

function escHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
