// ============================================================
// desktop.ts — kintone プラグインのエントリポイント
// ============================================================

import {
  execute,
  executeBatch,
  buildBatchExplainPlans,
  parseSqlStatement,
  parseSqlStatements,
  analyzeBatch,
  getInsertValuesCount,
  getStatementType,
  isDmlType,
  OperationCancelledError,
} from "../core";
import type {
  BatchExecuteResult,
  DmlConfirmContext,
  ExecuteResult,
  KintoneAppInfo,
  SelectResult,
} from "../core";
import { createKintoneClient } from "./kintoneClient";
import { renderResult, renderError, renderLoading } from "./renderResult";
import type { DisplayOptions } from "./renderResult";

type KintoneApiWithUrl = typeof kintone.api & { url(path: string, guest: boolean): string };
const apiUrl = (path: string) => (kintone.api as KintoneApiWithUrl).url(path, true);

/** ゲストスペース ID を URL から取得する（通常スペースは null） */
function getGuestSpaceId(): string | null {
  const m = location.pathname.match(/^\/k\/guest\/(\d+)\//);
  return m ? m[1] : null;
}

/** レコード詳細 URL を生成する（ゲストスペース対応） */
function recordShowUrl(appId: number | string, recordId: number | string): string {
  const spaceId = getGuestSpaceId();
  const base = spaceId
    ? `${location.origin}/k/guest/${spaceId}/${appId}`
    : `${location.origin}/k/${appId}`;
  return `${base}/show#record=${encodeURIComponent(String(recordId))}`;
}

// ============================================================
// フィールド一覧キャッシュ
// ============================================================

interface FieldInfo {
  code: string;
  label: string;
  fieldType: string;
  choices?: string[];
}

interface KintoneFieldValue {
  value: unknown;
}

type KintoneUiRecord = Record<string, KintoneFieldValue>;

interface IndexShowEvent {
  viewType?: string;
  viewName?: string;
  viewId?: string | number;
  records?: KintoneUiRecord[];
}

interface RecordShowEvent {
  type?: string;
  record?: KintoneUiRecord;
  error?: string;
}

const fieldCache = new Map<number, FieldInfo[]>();
let appListCache: KintoneAppInfo[] | null = null;
let appListPending: Promise<KintoneAppInfo[]> | null = null;

async function fetchFields(appId: number): Promise<FieldInfo[]> {
  if (fieldCache.has(appId)) return fieldCache.get(appId)!;

  const res = await kintone.api(
    apiUrl("/k/v1/app/form/fields.json"),
    "GET",
    { app: appId }
  ) as { properties: Record<string, { code: string; label: string; type: string; options?: Record<string, { label?: string }> }> };

  const fields: FieldInfo[] = Object.values(res.properties).map((f) => ({
    code:      f.code,
    label:     f.label,
    fieldType: f.type,
    choices:   extractFieldChoices(f.type, f.options),
  }));
  fieldCache.set(appId, fields);
  return fields;
}

function extractFieldChoices(fieldType: string, options?: Record<string, { label?: string }>): string[] | undefined {
  if (!options || typeof options !== "object") return undefined;
  if (fieldType !== "RADIO_BUTTON" && fieldType !== "DROP_DOWN" && fieldType !== "MULTI_SELECT" && fieldType !== "CHECK_BOX") return undefined;
  const labels = Object.values(options)
    .map((o) => String(o?.label ?? "").trim())
    .filter((v) => v.length > 0);
  return labels.length > 0 ? labels : undefined;
}

async function fetchApps(): Promise<KintoneAppInfo[]> {
  if (appListCache) return appListCache;
  if (appListPending) return appListPending;

  appListPending = createKintoneClient()
    .getApps()
    .then((apps) => {
      const sorted = [...apps].sort((a, b) => a.appId - b.appId);
      appListCache = sorted;
      return sorted;
    })
    .finally(() => {
      appListPending = null;
    });

  return appListPending;
}

const PLUGIN_ID        = kintone.$PLUGIN_ID as string;
const HISTORY_KEY      = `ksql_history_${PLUGIN_ID}`;
const TAB_KEY          = `ksql_option_tab_${PLUGIN_ID}`;
const FETCH_OPTIONS_KEY = `ksql_fetch_options_${PLUGIN_ID}`;
const HISTORY_MAX = 60;
const FETCH_PARALLEL_DEFAULT = 5;

interface SqlHistoryItem {
  sql: string;
  displayOptions?: DisplayOptions;
  maxRecords?: number;
  onLimitReached?: "error" | "truncate";
  savedAt?: string;
}

// ============================================================
// 表示オプション状態（セッション中に保持）
// ============================================================

const displayOptions: DisplayOptions = {
  userFormat:  "full",
  arrayFormat: "full",
};

let lastResult: ExecuteResult | null = null;
let latestRecordForForm: KintoneUiRecord | null = null;
let latestPanelDisplayOptions: DisplayOptions = {
  userFormat: "full",
  arrayFormat: "full",
  tableFormat: "full",
  dateFormat: "full",
  attachmentFormat: "full",
};
let latestPanelMaxRecords = 3000;
let latestPanelOnLimit: "error" | "truncate" = "error";

// ============================================================
// SQL 履歴（localStorage）
// ============================================================

function normalizeHistoryItem(raw: unknown): SqlHistoryItem | null {
  if (typeof raw === "string") {
    const sql = raw.trim();
    if (!sql) return null;
    return { sql };
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as {
    sql?: unknown;
    displayOptions?: unknown;
    maxRecords?: unknown;
    onLimitReached?: unknown;
    savedAt?: unknown;
  };
  const sql = typeof obj.sql === "string" ? obj.sql.trim() : "";
  if (!sql) return null;
  const display = (typeof obj.displayOptions === "object" && obj.displayOptions !== null)
    ? obj.displayOptions as DisplayOptions
    : undefined;
  const max = sanitizeMaxRecords(String(obj.maxRecords ?? ""));
  const mode = obj.onLimitReached === "truncate" ? "truncate" : "error";
  const savedAt = typeof obj.savedAt === "string" ? obj.savedAt : undefined;
  return { sql, displayOptions: display, maxRecords: max, onLimitReached: mode, savedAt };
}

function loadHistory(): SqlHistoryItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown[];
    if (!Array.isArray(list)) return [];
    return list
      .map(normalizeHistoryItem)
      .filter((v): v is SqlHistoryItem => !!v);
  } catch {
    return [];
  }
}

function normalizeDisplayOptions(opts: DisplayOptions | undefined): DisplayOptions {
  return {
    userFormat: opts?.userFormat ?? "full",
    arrayFormat: opts?.arrayFormat ?? "full",
    tableFormat: opts?.tableFormat ?? "full",
    dateFormat: opts?.dateFormat ?? "full",
    attachmentFormat: opts?.attachmentFormat ?? "full",
  };
}

function saveHistory(
  sql: string,
  displayOptions?: DisplayOptions,
  maxRecords = 3000,
  onLimitReached: "error" | "truncate" = "error"
): void {
  const item: SqlHistoryItem = {
    sql,
    displayOptions: normalizeDisplayOptions(displayOptions),
    maxRecords: sanitizeMaxRecords(String(maxRecords)),
    onLimitReached,
    savedAt: new Date().toISOString(),
  };
  const key = JSON.stringify({
    sql: item.sql,
    display: item.displayOptions,
    max: item.maxRecords,
    mode: item.onLimitReached,
  });
  const list = loadHistory().filter((h) => JSON.stringify({
    sql: h.sql,
    display: normalizeDisplayOptions(h.displayOptions),
    max: sanitizeMaxRecords(String(h.maxRecords ?? 3000)),
    mode: h.onLimitReached === "truncate" ? "truncate" : "error",
  }) !== key);
  list.unshift(item);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
}

// ============================================================
// kintone イベント登録
// ============================================================

kintone.events.on(
  ["app.record.index.show"],
  async (event) => {
    const e = event as IndexShowEvent;

    document.getElementById("ksql-layout")?.remove();
    document.getElementById("ksql-panel")?.remove();
    document.getElementById("ksql-index-record-pane")?.remove();

    if (!isSqlCustomView(e)) return event;
    const paneRecords = await loadRecordsForIndexPane(e);
    mountPanel(paneRecords);
    return event;
  }
);

kintone.events.on(
  ["app.record.detail.show", "app.record.edit.show", "app.record.create.show"],
  (event) => {
    const e = event as RecordShowEvent;
    if (e.type === "app.record.edit.show") {
      lockSqlIdOnEdit(e);
    }
    if (e.type === "app.record.create.show") {
      lockSqlIdOnCreate(e);
    }
    latestRecordForForm = e.record ?? null;
    mountRecordPanel(e);
    return event;
  }
);

kintone.events.on(
  [
    "app.record.edit.change.上限到達時の動作",
    "app.record.create.change.上限到達時の動作",
    "app.record.edit.change.最大取得件数",
    "app.record.create.change.最大取得件数",
  ],
  (event) => {
    const e = event as RecordShowEvent;
    latestRecordForForm = e.record ?? latestRecordForForm;
    return event;
  }
);

kintone.events.on(
  ["app.record.edit.submit", "app.record.create.submit"],
  async (event) => {
    const e = event as RecordShowEvent;
    syncRecordFieldsFromSpacePanel(e);
    if (e.type === "app.record.create.submit") {
      await assignSqlIdOnCreate(e);
    }
    return event;
  }
);

// ============================================================
// パネルのマウント
// ============================================================

function mountPanel(records: KintoneUiRecord[]): void {
  const panel  = buildPanel(records);
  const header = kintone.app.getHeaderSpaceElement();
  if (!header) return;
  const layout = el("div", "ksql-layout", { id: "ksql-layout" });
  layout.appendChild(panel);
  const sidePane = buildIndexRecordPane(records, panel);
  if (sidePane) layout.appendChild(sidePane);
  header.appendChild(layout);
}

interface AppViewInfo {
  id: string;
  filterCond?: string;
  sort?: string;
}

function normalizeSortClause(sort: string): string {
  const raw = String(sort ?? "").trim();
  if (!raw) return "";
  return /^order\s+by\s+/i.test(raw) ? raw : `order by ${raw}`;
}

function normalizeAppIdCsv(raw: string): string {
  const ids = String(raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v))
    .map((v) => String(parseInt(v, 10)))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort((a, b) => Number(a) - Number(b));
  return ids.length > 0 ? `,${ids.join(",")},` : "";
}

function extractTargetAppIdsFromSql(sql: string): string {
  const found: string[] = [];
  const re = /\bAPP(\d+)\b/ig;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(String(sql ?? ""))) !== null) {
    found.push(m[1]);
  }
  return normalizeAppIdCsv(found.join(","));
}

function containsAppId(normalizedCsv: string, appIdInput: string): boolean {
  const appId = String(appIdInput ?? "").trim();
  if (!/^\d+$/.test(appId)) return false;
  const normalized = normalizeAppIdCsv(normalizedCsv);
  return normalized.includes(`,${String(parseInt(appId, 10))},`);
}

function formatAppIdCsvForDisplay(raw: string): string {
  const normalized = normalizeAppIdCsv(raw);
  if (!normalized) return "-";
  return normalized.replace(/^,|,$/g, "");
}

async function loadRecordsForIndexPane(event: IndexShowEvent): Promise<KintoneUiRecord[]> {
  const appId = kintone.app.getId();
  if (!appId) return [];

  const requiredFields = [
    "$id",
    "SQLID",
    "タイトル",
    "対象アプリ",
    "区分",
    "SQL",
    "ユーザー",
    "配列",
    "テーブル",
    "日時",
    "ファイル",
    "最大取得件数",
    "上限到達時の動作",
  ];

  let filterCond = "";
  let sort = "";
  try {
    const res = await kintone.api(apiUrl("/k/v1/app/views.json"), "GET", {
      app: appId,
    }) as { views: Record<string, AppViewInfo> };
    const views = Object.values(res.views ?? {});
    const targetViewId = String(event.viewId ?? "");
    const view = views.find((v) => String(v.id) === targetViewId);
    filterCond = String(view?.filterCond ?? "").trim();
    sort = normalizeSortClause(String(view?.sort ?? "").trim());
  } catch {
    // ignore and fallback to no filter/sort
  }

  const PAGE = 500;
  const MAX = 1000;
  const rows: KintoneUiRecord[] = [];
  let offset = 0;

  while (rows.length < MAX) {
    const limit = Math.min(PAGE, MAX - rows.length);
    const queryParts = [filterCond, sort, `limit ${limit}`, `offset ${offset}`].filter((s) => !!String(s).trim());
    const query = queryParts.join(" ");

    const res = await kintone.api(apiUrl("/k/v1/records.json"), "GET", {
      app: appId,
      query,
      fields: requiredFields,
    }) as { records: KintoneUiRecord[] };
    const page = Array.isArray(res.records) ? res.records : [];
    rows.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }

  return rows;
}

// ============================================================
// パネル DOM の構築
// ============================================================

interface PanelBuildOptions {
  initialSql?: string;
  initialDisplayOptions?: DisplayOptions;
  initialMaxRecords?: number;
  initialOnLimitReached?: "error" | "truncate";
  resolveMaxRecords?: () => number;
  resolveOnLimitReached?: () => "error" | "truncate";
  panelId?: string;
}

function buildPanel(records: KintoneUiRecord[], options: PanelBuildOptions = {}): HTMLElement {
  const panelOptions: DisplayOptions = {
    userFormat: options.initialDisplayOptions?.userFormat ?? displayOptions.userFormat ?? "full",
    arrayFormat: options.initialDisplayOptions?.arrayFormat ?? displayOptions.arrayFormat ?? "full",
    tableFormat: options.initialDisplayOptions?.tableFormat ?? displayOptions.tableFormat ?? "full",
    dateFormat: options.initialDisplayOptions?.dateFormat ?? displayOptions.dateFormat ?? "full",
    attachmentFormat: options.initialDisplayOptions?.attachmentFormat ?? displayOptions.attachmentFormat ?? "full",
  };
  // initialMaxRecords が未指定（一覧ページ）の場合は localStorage から復元する
  const storedFetch = options.initialMaxRecords === undefined
    ? loadFetchOptions(FETCH_OPTIONS_KEY)
    : null;
  let panelMaxRecordsState = options.initialMaxRecords ?? storedFetch?.maxRecords ?? 3000;
  let panelOnLimitState: "error" | "truncate" = options.initialOnLimitReached ?? storedFetch?.onLimitReached ?? "error";
  // 実行時は常にパネルの現在UI状態を優先する。
  // （レコード保存前に options.resolve* 側の値が古い場合でも、直近入力値で実行できるようにする）
  const resolveMaxRecords = (): number => panelMaxRecordsState;
  const resolveOnLimitReached = (): "error" | "truncate" => panelOnLimitState;
  latestPanelDisplayOptions = { ...panelOptions };
  latestPanelMaxRecords = panelMaxRecordsState;
  latestPanelOnLimit = panelOnLimitState;

  let panelLastResult: ExecuteResult | null = null;
  const panel = el("div", "ksql-panel", { id: "ksql-panel" });
  if (options.panelId) panel.id = options.panelId;

  // --- ヘッダー ---
  const header = el("div", "ksql-panel-header");
  const title  = el("span", "ksql-panel-title");
  title.textContent = "kSQL — SQL クエリ実行";
  const toggle = el("button", "ksql-toggle-btn");
  toggle.textContent = "▲ 折りたたむ";
  toggle.addEventListener("click", () => toggleBody(body, toggle));
  header.append(title, toggle);

  // --- ボディ ---
  const body = el("div", "ksql-panel-body", { id: "ksql-panel-body" });

  // --- エディタ本体 ---
  const editorRow = el("div", "ksql-editor-row");
  const editorCol = el("div", "ksql-editor-col");
  // 結果エリア（先に生成して各ハンドラから参照できるようにする）
  const resultArea = el("div", "ksql-result", { id: "ksql-result" });

  // テキストエリア
  const editor = el("textarea", "ksql-editor", {
    id:           "ksql-editor",
    placeholder:  "SELECT * FROM APP100 WHERE ステータス = '完了'",
    spellcheck:   "false",
    autocomplete: "off",
  }) as HTMLTextAreaElement;
  editor.value = options.initialSql ?? "";

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runSql(editor.value.trim(), resultArea, false, [], panelOptions, resolveMaxRecords(), resolveOnLimitReached()).then((r) => {
        if (r) panelLastResult = r;
      });
    }
  });

  // ボタン行
  const buttonRow = el("div", "ksql-button-row");

  const runBtn = el("button", "ksql-run-btn", { id: "ksql-run-btn" });
  runBtn.textContent = "実行（Ctrl+Enter）";
  runBtn.addEventListener("click", () => {
    void runSql(editor.value.trim(), resultArea, false, [], panelOptions, resolveMaxRecords(), resolveOnLimitReached()).then((r) => {
      if (r) panelLastResult = r;
    });
  });

  const explainBtn = el("button", "ksql-explain-btn", { id: "ksql-explain-btn" });
  explainBtn.textContent = "EXPLAIN";
  explainBtn.addEventListener("click", () => {
    const sql = editor.value.trim();
    if (sql) {
      // バッチ入力は EXPLAIN を前置せず、プラン表示モードで渡す
      //（前置すると2文目以降が実行されてしまうため）
      const isBatch = isMultiStatementSql(sql);
      void runSql(isBatch ? sql : "EXPLAIN " + sql, resultArea, true, [], panelOptions, resolveMaxRecords(), resolveOnLimitReached(), isBatch).then((r) => {
        if (r) panelLastResult = r;
      });
    }
  });

  const clearBtn = el("button", "ksql-clear-btn");
  clearBtn.textContent = "クリア";
  clearBtn.addEventListener("click", () => {
    resultArea.innerHTML = "";
    editor.focus();
  });

  // 履歴ボタン
  const histBtn = el("button", "ksql-hist-btn", { id: "ksql-hist-btn" });
  histBtn.textContent = "履歴 ▼";
  histBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHistoryDropdown(
      editor,
      histBtn,
      panelOptions,
      resolveMaxRecords(),
      resolveOnLimitReached(),
      (r) => { panelLastResult = r; }
    );
  });

  // オプションボタン
  const optBtn = el("button", "ksql-opt-btn", { id: "ksql-opt-btn" });
  optBtn.textContent = "⚙ オプション ▼";
  const optSummary = el("span", "ksql-opt-summary");
  const refreshOptSummary = (): void => {
    const mode = resolveOnLimitReached() === "truncate" ? "打ち切り" : "エラー";
    optSummary.textContent = `取得: ${resolveMaxRecords()} / ${mode}`;
  };
  refreshOptSummary();

  buttonRow.append(runBtn, explainBtn, clearBtn, histBtn, optBtn, optSummary);

  // 履歴ドロップダウン（初期非表示）
  const histDropdown = el("div", "ksql-hist-dropdown", { id: "ksql-hist-dropdown" });
  histDropdown.style.display = "none";
  histDropdown.addEventListener("click", (e) => e.stopPropagation());

  // ポップオーバー内: 表示オプション
  const optDisplayPanel = buildOptionsPanel(panelOptions, () => {
    latestPanelDisplayOptions = { ...panelOptions };
    if (panelLastResult) {
      resultArea.innerHTML = renderResult(panelLastResult, panelOptions);
      bindResultTableFeatures(resultArea);
    }
  });
  const optFetchPanel = buildFetchOptionsPanel(
    panelMaxRecordsState,
    panelOnLimitState,
    (maxRecords, mode) => {
      panelMaxRecordsState = maxRecords;
      panelOnLimitState = mode;
      latestPanelMaxRecords = maxRecords;
      latestPanelOnLimit = mode;
      // 一覧ページ（initialMaxRecords 未指定）は設定を localStorage に永続化する
      if (options.initialMaxRecords === undefined) {
        saveFetchOptions(FETCH_OPTIONS_KEY, maxRecords, mode);
      }
      refreshOptSummary();
    }
  );
  const optSavedPanelHost = el("div", "ksql-opt-saved-host");
  const renderSavedPanel = (targetRecords: KintoneUiRecord[]): void => {
    optSavedPanelHost.innerHTML = "";
    optSavedPanelHost.appendChild(buildSavedSqlSidebar(targetRecords, editor, resultArea, (r) => {
      panelLastResult = r;
    }));
  };
  renderSavedPanel(records.length > 0 ? [records[0]] : records);
  const optFieldPanel = buildFieldSidebar(editor);
  const optAppPanel = buildAppListPanel(editor);

  const popoverTabs = [
    { key: "display", label: "表示", content: optDisplayPanel },
    { key: "fetch", label: "取得", content: optFetchPanel },
    { key: "saved", label: "保存SQL", content: optSavedPanelHost },
    { key: "field", label: "フィールド", content: optFieldPanel },
    { key: "app", label: "アプリ", content: optAppPanel },
  ] as const;
  let closeOptionPopover = (): void => {};
  const optPopover = buildOptionPopover(popoverTabs, TAB_KEY, () => closeOptionPopover());
  optPopover.style.display = "none";

  closeOptionPopover = (): void => {
    optPopover.style.display = "none";
    optBtn.textContent = "⚙ オプション ▼";
  };
  const openOptionPopover = (): void => {
    optPopover.style.display = "";
    optBtn.textContent = "⚙ オプション ▲";
  };
  optBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (optPopover.style.display === "none") openOptionPopover();
    else closeOptionPopover();
  });
  optPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOptionPopover();
  });

  editorCol.append(editor, buttonRow, optPopover, histDropdown);

  editorRow.append(editorCol);
  body.append(editorRow, resultArea);
  panel.append(header, body);

  // ドロップダウン外クリックで閉じる
  document.addEventListener("click", () => closeHistoryDropdown());

  panel.addEventListener("ksql:select-record", (e) => {
    const ce = e as CustomEvent<KintoneUiRecord>;
    const rec = ce.detail;
    if (rec) renderSavedPanel([rec]);
  });

  return panel;
}

function buildIndexRecordPane(records: KintoneUiRecord[], panel: HTMLElement): HTMLElement | null {
  const activeRecords = records;
  if (activeRecords.length === 0) return null;

  const side = el("div", "ksql-index-record-pane", { id: "ksql-index-record-pane" });
  const sideHeader = el("div", "ksql-index-record-pane-header");
  const sideTitle = el("span", "ksql-index-record-pane-title");
  sideTitle.textContent = "レコード一覧";
  const sideToggle = el("button", "ksql-side-toggle-btn") as HTMLButtonElement;
  sideToggle.textContent = "▶";
  sideHeader.append(sideTitle, sideToggle);

  const sideBody = el("div", "ksql-index-record-pane-body");
  const filterRow = el("div", "ksql-index-record-filter-row");
  const filterInput = el("input", "ksql-index-record-filter", {
    type: "text",
    placeholder: "フィルター...",
  }) as HTMLInputElement;
  const appFilterInput = el("input", "ksql-index-record-app-filter", {
    type: "text",
    inputmode: "numeric",
    placeholder: "アプリID",
  }) as HTMLInputElement;
  filterRow.append(filterInput, appFilterInput);
  const list = el("div", "ksql-index-record-list");
  sideBody.append(filterRow, list);
  side.append(sideHeader, sideBody);
  let collapsed = false;
  const syncCollapsed = (): void => {
    side.classList.toggle("is-collapsed", collapsed);
    sideToggle.textContent = collapsed ? "◀" : "▶";
    sideToggle.title = collapsed ? "展開" : "右に折りたたむ";
  };
  sideToggle.addEventListener("click", () => {
    collapsed = !collapsed;
    syncCollapsed();
  });
  syncCollapsed();

  const editor = panel.querySelector("#ksql-editor") as HTMLTextAreaElement | null;

  const setChecked = (name: string, value: string): void => {
    const radios = panel.querySelectorAll(`input[name="${name}"]`) as NodeListOf<HTMLInputElement>;
    let target: HTMLInputElement | null = null;
    radios.forEach((r) => {
      const hit = r.value === value;
      r.checked = hit;
      if (hit) target = r;
    });
    target?.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const applyRecordConfig = (record: KintoneUiRecord): void => {
    if (editor) editor.value = getFieldText(record, "SQL");

    const nextDisplay = parseDisplayOptionsFromRecord(record);
    setChecked("ksql-user-fmt", nextDisplay.userFormat ?? "full");
    setChecked("ksql-arr-fmt", nextDisplay.arrayFormat ?? "full");
    setChecked("ksql-tbl-fmt", nextDisplay.tableFormat ?? "full");
    setChecked("ksql-date-fmt", nextDisplay.dateFormat ?? "full");
    setChecked("ksql-file-fmt", nextDisplay.attachmentFormat ?? "full");

    const maxInput = panel.querySelector("#ksql-max-records-input") as HTMLInputElement | null;
    if (maxInput) {
      maxInput.value = String(parseMaxRecordsFromRecord(record));
      maxInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const mode = parseOnLimitReachedFromRecord(record);
    setChecked("ksql-limit-mode", mode);

    panel.dispatchEvent(new CustomEvent<KintoneUiRecord>("ksql:select-record", { detail: record }));
  };

  let selected = 0;
  const renderSideList = (): void => {
    list.innerHTML = "";
    const word = filterInput.value.trim().toLowerCase();
    const filtered = activeRecords
      .map((rec, index) => ({ rec, index }))
      .filter(({ rec }) => {
        const appWord = appFilterInput.value.trim();
        const appCsv = getFieldText(rec, "対象アプリ");
        const hitText = !word || getFieldText(rec, "SQLID").toLowerCase().includes(word) || getFieldText(rec, "タイトル").toLowerCase().includes(word);
        const hitApp = !appWord || containsAppId(appCsv, appWord);
        if (!hitText || !hitApp) return false;
        const id = getFieldText(rec, "SQLID").toLowerCase();
        const title = getFieldText(rec, "タイトル").toLowerCase();
        return !word || id.includes(word) || title.includes(word);
      });

    for (const { rec, index } of filtered) {
      const row = el("div", index === selected ? "ksql-index-record-item is-active" : "ksql-index-record-item");
      const text = el("div", "ksql-index-record-text");
      const idText = getFieldText(rec, "SQLID") || "-";
      const titleText = getFieldText(rec, "タイトル") || "(no title)";
      text.textContent = `${idText}  ${titleText}`;
      const appText = el("div", "ksql-index-record-apps");
      appText.textContent = `APP: ${formatAppIdCsvForDisplay(getFieldText(rec, "対象アプリ"))}`;
      const left = el("div", "ksql-index-record-item-main");
      left.append(text, appText);

      const recId = getFieldText(rec, "$id");
      const link = el("a", "ksql-index-record-link", {
        href: recordShowUrl(kintone.app.getId()!, recId),
        target: "_blank",
        rel: "noopener noreferrer",
        title: "レコード詳細を新規タブで開く",
      }) as HTMLAnchorElement;
      link.textContent = "↗";
      link.addEventListener("click", (e) => e.stopPropagation());

      row.append(left, link);
      row.addEventListener("click", () => {
        selected = index;
        renderSideList();
        applyRecordConfig(rec);
      });
      list.appendChild(row);
    }

    if (filtered.length === 0) {
      const empty = el("div", "ksql-index-record-empty");
      empty.textContent = "該当なし";
      list.appendChild(empty);
    }
  };

  filterInput.addEventListener("input", renderSideList);
  appFilterInput.addEventListener("input", renderSideList);
  renderSideList();
  applyRecordConfig(activeRecords[0]);
  return side;
}

function isSqlCustomView(event: IndexShowEvent): boolean {
  const viewType = String(event.viewType ?? "").toLowerCase();
  if (viewType !== "custom") return false;

  return !!document.getElementById("rex0220-ksql-main");
}

interface OptionTabItem {
  key: string;
  label: string;
  content: HTMLElement;
}

function buildOptionPopover(
  tabs: readonly OptionTabItem[],
  tabStorageKey: string,
  onClose: () => void
): HTMLElement {
  const pop = el("div", "ksql-opt-popover");
  const popHeader = el("div", "ksql-opt-popover-header");
  const popTitle = el("span", "ksql-opt-popover-title");
  popTitle.textContent = "オプション";
  const closeBtn = el("button", "ksql-opt-popover-close", {
    type: "button",
    "aria-label": "オプションを閉じる",
    title: "閉じる",
  }) as HTMLButtonElement;
  closeBtn.textContent = "×";
  const tabHead = el("div", "ksql-opt-tabs");
  const tabBody = el("div", "ksql-opt-tab-body");

  let active = loadLastOptionTab(tabStorageKey, tabs.map((t) => t.key)) ?? tabs[0].key;

  const render = (): void => {
    tabHead.innerHTML = "";
    tabBody.innerHTML = "";

    for (const tab of tabs) {
      const btn = el("button", tab.key === active ? "ksql-opt-tab is-active" : "ksql-opt-tab") as HTMLButtonElement;
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        active = tab.key;
        saveLastOptionTab(tabStorageKey, active);
        render();
      });
      tabHead.appendChild(btn);
    }

    const current = tabs.find((t) => t.key === active) ?? tabs[0];
    tabBody.appendChild(current.content);
  };

  render();
  closeBtn.addEventListener("click", () => onClose());
  popHeader.append(popTitle, closeBtn);
  pop.append(popHeader, tabHead, tabBody);
  return pop;
}

interface StoredFetchOptions {
  maxRecords: number;
  onLimitReached: "error" | "truncate";
}

function loadFetchOptions(storageKey: string): StoredFetchOptions | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const { maxRecords, onLimitReached } = obj as Record<string, unknown>;
    if (typeof maxRecords !== "number" || maxRecords <= 0) return null;
    if (onLimitReached !== "error" && onLimitReached !== "truncate") return null;
    return { maxRecords, onLimitReached };
  } catch {
    return null;
  }
}

function saveFetchOptions(storageKey: string, maxRecords: number, onLimitReached: "error" | "truncate"): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ maxRecords, onLimitReached }));
  } catch {
    // noop
  }
}

function loadLastOptionTab(storageKey: string, keys: string[]): string | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return keys.includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveLastOptionTab(storageKey: string, key: string): void {
  try {
    localStorage.setItem(storageKey, key);
  } catch {
    // noop
  }
}

function buildFetchOptionsPanel(
  initialMaxRecords: number,
  initialMode: "error" | "truncate",
  onChange: (maxRecords: number, mode: "error" | "truncate") => void
): HTMLElement {
  const panel = el("div", "ksql-fetch-panel");

  const maxRow = el("div", "ksql-fetch-row");
  const maxLabel = el("label", "ksql-fetch-label");
  maxLabel.textContent = "最大取得件数:";
  const maxInput = el("input", "ksql-fetch-input", {
    type: "number",
    min: "1",
    step: "100",
    value: String(initialMaxRecords),
    id: "ksql-max-records-input",
  }) as HTMLInputElement;
  maxRow.append(maxLabel, maxInput);

  const modeRow = el("div", "ksql-fetch-row");
  const modeLabel = el("span", "ksql-fetch-label");
  modeLabel.textContent = "上限到達時:";
  modeRow.appendChild(modeLabel);

  const modes: Array<{ value: "error" | "truncate"; label: string }> = [
    { value: "error", label: "エラー" },
    { value: "truncate", label: "打ち切って続行" },
  ];
  for (const m of modes) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type: "radio",
      name: "ksql-limit-mode",
      value: m.value,
    }) as HTMLInputElement;
    radio.checked = m.value === initialMode;
    lbl.append(radio, document.createTextNode(m.label));
    modeRow.appendChild(lbl);
  }

  let lastMaxValue = sanitizeMaxRecords(maxInput.value);

  const sync = (): void => {
    const max = sanitizeMaxRecords(maxInput.value);
    lastMaxValue = max;
    maxInput.value = String(max);
    const mode = readCheckedRadio(panel, "ksql-limit-mode") === "truncate" ? "truncate" : "error";
    onChange(max, mode);
  };

  // 一部ブラウザで number スピナーが 1 刻みになるため、100 刻みに補正する
  maxInput.addEventListener("input", () => {
    const raw = maxInput.value.trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      let next = n;
      const diff = n - lastMaxValue;
      if (Math.abs(diff) === 1) {
        next = lastMaxValue + Math.sign(diff) * 100;
      }
      lastMaxValue = sanitizeMaxRecords(String(next));
      maxInput.value = String(lastMaxValue);
    }
    sync();
  });
  maxInput.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? 1 : -1;
    const base = sanitizeMaxRecords(maxInput.value);
    const next = Math.max(1, base + dir * 100);
    maxInput.value = String(next);
    sync();
  });
  maxInput.addEventListener("blur", sync);

  panel.append(maxRow, modeRow);
  panel.addEventListener("change", sync);
  sync();

  return panel;
}

interface SavedSqlItem {
  sqlId: string;
  title: string;
  category: string;
  sql: string;
  maxRecords: number;
  onLimitReached: "error" | "truncate";
  resultOptions: DisplayOptions;
}

function buildSavedSqlSidebar(
  records: KintoneUiRecord[],
  editor: HTMLTextAreaElement,
  resultArea: HTMLElement,
  onExecuted?: (result: ExecuteResult) => void
): HTMLElement {
  const sidebar = el("div", "ksql-saved-sidebar");

  const header = el("div", "ksql-saved-sidebar-header");
  const title = el("span", "ksql-saved-sidebar-title");
  title.textContent = "保存SQL";
  const toggleBtn = el("button", "ksql-side-toggle-btn") as HTMLButtonElement;
  toggleBtn.textContent = "▲";
  header.append(title, toggleBtn);
  sidebar.appendChild(header);

  const body = el("div", "ksql-saved-sidebar-body");

  const list = el("div", "ksql-saved-list");
  const items = records
    .map(toSavedSqlItem)
    .filter((item) => item.sql.trim() !== "");

  if (items.length === 0) {
    const empty = el("div", "ksql-saved-empty");
    empty.textContent = "保存SQLがありません";
    list.appendChild(empty);
    body.appendChild(list);
    sidebar.appendChild(body);
    toggleBtn.addEventListener("click", () => toggleBody(body, toggleBtn));
    return sidebar;
  }

  for (const item of items) {
    const row = el("div", "ksql-saved-item");

    const meta = el("div", "ksql-saved-meta");
    const title = el("div", "ksql-saved-title");
    title.textContent = item.title || item.sqlId || "(タイトルなし)";
    const sub = el("div", "ksql-saved-sub");
    sub.textContent = [item.sqlId, item.category].filter(Boolean).join(" / ");
    meta.append(title, sub);

    const sqlPreview = el("pre", "ksql-saved-preview");
    sqlPreview.textContent = item.sql.length > 160 ? item.sql.slice(0, 160) + "..." : item.sql;

    const btnRow = el("div", "ksql-saved-btn-row");
    const loadBtn = el("button", "ksql-saved-btn");
    loadBtn.textContent = "読込";
    const runBtn = el("button", "ksql-saved-btn ksql-saved-btn-run");
    runBtn.textContent = "実行";
    const explainBtn = el("button", "ksql-saved-btn");
    explainBtn.textContent = "EXPLAIN";

    const executable = isRecordExecutable(item);
    runBtn.disabled = !executable;
    explainBtn.disabled = !executable;
    if (!executable) {
      runBtn.title = "区分=有効 のSQLのみ実行できます";
      explainBtn.title = "区分=有効 のSQLのみ実行できます";
    }

    loadBtn.addEventListener("click", () => {
      editor.value = item.sql;
      editor.focus();
    });
    runBtn.addEventListener("click", () => {
      void runSql(item.sql, resultArea, false, [runBtn, explainBtn], item.resultOptions, item.maxRecords, item.onLimitReached).then((r) => {
        if (r && onExecuted) onExecuted(r);
      });
    });
    explainBtn.addEventListener("click", () => {
      // バッチ入力は EXPLAIN を前置せず、プラン表示モードで渡す
      const isBatch = isMultiStatementSql(item.sql);
      void runSql(isBatch ? item.sql : `EXPLAIN ${item.sql}`, resultArea, true, [runBtn, explainBtn], item.resultOptions, item.maxRecords, item.onLimitReached, isBatch).then((r) => {
        if (r && onExecuted) onExecuted(r);
      });
    });

    btnRow.append(loadBtn, runBtn, explainBtn);
    row.append(meta, sqlPreview, btnRow);
    list.appendChild(row);
  }

  body.appendChild(list);
  sidebar.appendChild(body);
  toggleBtn.addEventListener("click", () => toggleBody(body, toggleBtn));
  return sidebar;
}

function toSavedSqlItem(record: KintoneUiRecord): SavedSqlItem {
  return {
    sqlId: getFieldText(record, "SQLID"),
    title: getFieldText(record, "タイトル"),
    category: getFieldText(record, "区分"),
    sql: getFieldText(record, "SQL"),
    maxRecords: parseMaxRecordsFromRecord(record),
    onLimitReached: parseOnLimitReachedFromRecord(record),
    resultOptions: parseDisplayOptionsFromRecord(record),
  };
}

function parseMaxRecordsFromRecord(record: KintoneUiRecord): number {
  const raw = getFieldText(record, "最大取得件数").trim();
  return sanitizeMaxRecords(raw);
}

function parseOnLimitReachedFromRecord(record: KintoneUiRecord): "error" | "truncate" {
  const raw = getFieldText(record, "上限到達時の動作");
  return (raw.includes("打ち切") || raw.includes("続行")) ? "truncate" : "error";
}

function sanitizeMaxRecords(raw: string): number {
  const n = parseInt(String(raw).replace(/,/g, "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 3000;
  return n;
}

function parseDisplayOptionsFromRecord(record: KintoneUiRecord): DisplayOptions {
  const userRaw = getFieldText(record, "ユーザー");
  const arrayRaw = getFieldText(record, "配列");
  const tableRaw = getFieldText(record, "テーブル");
  const dateRaw = getFieldText(record, "日時");
  const fileRaw = getFieldText(record, "ファイル");

  const userFormat = userRaw === "名前"
    ? "name"
    : userRaw === "コード"
      ? "code"
      : "full";

  const arrayFormat = arrayRaw === "カンマ区切り" ? "join" : "full";
  const tableFormat = tableRaw === "行数のみ" ? "count" : "full";
  const dateFormat = dateRaw === "ローカル形式" ? "local" : "full";
  const attachmentFormat = fileRaw === "ファイル名"
    || fileRaw === "名前"
    ? "name"
    : fileRaw === "fileKey"
      ? "fileKey"
      : "full";

  return { userFormat, arrayFormat, tableFormat, dateFormat, attachmentFormat };
}

function isRecordExecutable(item: SavedSqlItem): boolean {
  return item.category !== "無効" && item.sql.trim() !== "";
}

function getFieldText(record: KintoneUiRecord, code: string): string {
  const v = record[code]?.value;
  return typeof v === "string" ? v : String(v ?? "");
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err !== "object" || err === null) return String(err);

  const obj = err as {
    message?: unknown;
    code?: unknown;
    errors?: Record<string, { messages?: unknown }>;
  };

  const base = typeof obj.message === "string"
    ? obj.message
    : (typeof obj.code === "string" ? `エラー: ${obj.code}` : "取得に失敗しました。");

  if (!obj.errors || typeof obj.errors !== "object") return base;

  const details: string[] = [];
  for (const [field, detail] of Object.entries(obj.errors)) {
    const msgs = Array.isArray(detail?.messages)
      ? detail.messages.filter((m): m is string => typeof m === "string")
      : [];
    for (const m of msgs) details.push(`${field}: ${m}`);
  }
  return details.length > 0 ? `${base} ${details.join(" / ")}` : base;
}

function mountRecordRunner(event: RecordShowEvent): void {
  mountRecordPanel(event);
}

function mountRecordPanel(event: RecordShowEvent): void {
  const space = kintone.app.record.getSpaceElement("SP1");
  if (!space) return;
  space.style.maxWidth = "calc(100vw - 40px)";

  latestRecordForForm = event.record ?? latestRecordForForm;
  const current = latestRecordForForm;
  const records = current ? [current] : [];
  const initialSql = current ? getFieldText(current, "SQL") : "";
  const initialDisplayOptions = current ? parseDisplayOptionsFromRecord(current) : undefined;
  const initialMaxRecords = current ? parseMaxRecordsFromRecord(current) : 3000;
  const initialOnLimitReached = current ? parseOnLimitReachedFromRecord(current) : "error";

  space.innerHTML = "";
  const panel = buildPanel(records, {
    initialSql,
    initialDisplayOptions,
    initialMaxRecords,
    initialOnLimitReached,
    resolveMaxRecords: () => {
      const rec = latestRecordForForm;
      return rec ? parseMaxRecordsFromRecord(rec) : initialMaxRecords;
    },
    resolveOnLimitReached: () => {
      const rec = latestRecordForForm;
      return rec ? parseOnLimitReachedFromRecord(rec) : initialOnLimitReached;
    },
    panelId: "ksql-record-panel",
  });
  space.appendChild(panel);
}

function syncRecordFieldsFromSpacePanel(event: RecordShowEvent): void {
  const record = event.record;
  if (!record) return;

  const panel = document.getElementById("ksql-record-panel");
  if (!panel) return;

  const editor = panel.querySelector("#ksql-editor") as HTMLTextAreaElement | null;
  if (editor && record["SQL"]) {
    record["SQL"].value = editor.value;
  }
  if (editor && record["対象アプリ"]) {
    record["対象アプリ"].value = extractTargetAppIdsFromSql(editor.value);
  }

  const user = latestPanelDisplayOptions.userFormat ?? "full";
  const array = latestPanelDisplayOptions.arrayFormat ?? "full";
  const table = latestPanelDisplayOptions.tableFormat ?? "full";
  const date = latestPanelDisplayOptions.dateFormat ?? "full";
  const file = latestPanelDisplayOptions.attachmentFormat ?? "full";

  if (record["ユーザー"]) record["ユーザー"].value = mapUserFormatToLabel(user);
  if (record["配列"]) record["配列"].value = mapArrayFormatToLabel(array);
  if (record["テーブル"]) record["テーブル"].value = mapTableFormatToLabel(table);
  if (record["日時"]) record["日時"].value = mapDateFormatToLabel(date);
  if (record["ファイル"]) record["ファイル"].value = mapAttachmentFormatToLabel(file);
  if (record["最大取得件数"]) record["最大取得件数"].value = String(latestPanelMaxRecords);
  if (record["上限到達時の動作"]) record["上限到達時の動作"].value = mapLimitModeToLabel(latestPanelOnLimit);
}

function lockSqlIdOnEdit(event: RecordShowEvent): void {
  const record = event.record;
  if (!record) return;
  if (record["SQLID"]) record["SQLID"].disabled = true;
  if (record["識別"]) record["識別"].disabled = true;
}

function lockSqlIdOnCreate(event: RecordShowEvent): void {
  const record = event.record;
  if (!record) return;
  if (record["SQLID"]) {
    record["SQLID"].value = "";
    record["SQLID"].disabled = true;
  }
}

function escapeKintoneQueryValue(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
}

function escapeRegExp(raw: string): string {
  return String(raw ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assignSqlIdOnCreate(event: RecordShowEvent): Promise<void> {
  const record = event.record;
  if (!record) return;
  if (!record["SQLID"] || !record["識別"]) return;

  const prefix = getFieldText(record, "識別").trim();
  if (!prefix) {
    event.error = "識別を選択してください。";
    return;
  }

  const next = await generateSqlIdByPrefix(prefix);
  record["SQLID"].value = next;
}

async function generateSqlIdByPrefix(prefix: string): Promise<string> {
  const appId = kintone.app.getId();
  if (!appId) return `${prefix}-1`;

  const PAGE = 500;
  const LIMIT = 2000;
  let offset = 0;
  let maxNo = 0;
  const escapedPrefix = escapeKintoneQueryValue(prefix);

  const prefixRe = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);

  while (offset < LIMIT) {
    const query = `SQLID like "${escapedPrefix}-%" order by $id desc limit ${PAGE} offset ${offset}`;
    const res = await kintone.api(apiUrl("/k/v1/records.json"), "GET", {
      app: appId,
      query,
      fields: ["SQLID"],
    }) as { records: KintoneUiRecord[] };

    const records = Array.isArray(res.records) ? res.records : [];
    for (const r of records) {
      const sqlId = getFieldText(r, "SQLID");
      const m = prefixRe.exec(sqlId);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxNo) maxNo = n;
    }

    if (records.length < PAGE) break;
    offset += records.length;
  }

  return `${prefix}-${formatSqlIdSequence(maxNo + 1)}`;
}

function formatSqlIdSequence(num: number): string {
  const n = Math.max(1, Math.floor(num));
  return n >= 1000 ? String(n) : String(n).padStart(3, "0");
}

function readCheckedRadio(panel: HTMLElement, name: string): string {
  const checked = panel.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null;
  return checked?.value ?? "";
}

function mapUserFormatToLabel(v: string): string {
  if (v === "name") return "名前";
  if (v === "code") return "コード";
  return "そのまま";
}

function mapArrayFormatToLabel(v: string): string {
  return v === "join" ? "カンマ区切り" : "そのまま";
}

function mapTableFormatToLabel(v: string): string {
  return v === "count" ? "行数のみ" : "そのまま";
}

function mapDateFormatToLabel(v: string): string {
  return v === "local" ? "ローカル形式" : "そのまま";
}

function mapAttachmentFormatToLabel(v: string): string {
  if (v === "name") return "名前";
  if (v === "fileKey") return "fileKey";
  return "そのまま";
}

function mapLimitModeToLabel(v: string): string {
  return v === "truncate" ? "打ち切って続行" : "エラー";
}

// ============================================================
// フィールド一覧サイドバー
// ============================================================

function buildFieldSidebar(editor: HTMLTextAreaElement): HTMLElement {
  const sidebar = el("div", "ksql-field-sidebar");

  // ヘッダー
  const sidebarHeader = el("div", "ksql-field-sidebar-header");
  const sidebarTitle = el("span", "ksql-field-sidebar-title");
  sidebarTitle.textContent = "フィールド一覧";
  const toggleBtn = el("button", "ksql-side-toggle-btn") as HTMLButtonElement;
  toggleBtn.textContent = "▲";
  sidebarHeader.append(sidebarTitle, toggleBtn);

  const body = el("div", "ksql-field-sidebar-body");

  // アプリID入力行
  const inputRow = el("div", "ksql-field-input-row");
  const appInput = el("input", "ksql-field-app-input", {
    type:        "number",
    placeholder: "アプリID",
    id:          "ksql-field-app-input",
    min:         "1",
  }) as HTMLInputElement;

  const fetchBtn = el("button", "ksql-field-fetch-btn") as HTMLButtonElement;
  fetchBtn.textContent = "取得";

  const searchInput = el("input", "ksql-field-search", {
    type:        "text",
    placeholder: "フィルタ...",
  }) as HTMLInputElement;
  searchInput.disabled = true;

  inputRow.append(appInput, fetchBtn, searchInput);

  // フィールドリスト領域
  const listArea = el("div", "ksql-field-list-area", { id: "ksql-field-list-area" });
  listArea.textContent = "アプリIDを入力して取得";
  let currentFields: FieldInfo[] = [];

  const renderCurrent = (): void => {
    renderFieldList(listArea, currentFields, editor, searchInput.value);
  };

  // 取得ボタン押下
  const doFetch = (): void => {
    const appId = parseInt(appInput.value.trim(), 10);
    if (isNaN(appId) || appId <= 0) {
      listArea.textContent = "アプリIDを入力してください";
      return;
    }
    listArea.textContent = "取得中...";
    fetchBtn.disabled = true;

    fetchFields(appId)
      .then((fields) => {
        currentFields = fields;
        searchInput.disabled = false;
        renderCurrent();
      })
      .catch((err: unknown) => {
        currentFields = [];
        searchInput.disabled = true;
        listArea.textContent = formatErrorMessage(err);
      })
      .finally(() => {
        fetchBtn.disabled = false;
      });
  };

  fetchBtn.addEventListener("click", doFetch);
  appInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doFetch();
  });
  searchInput.addEventListener("input", renderCurrent);

  body.append(inputRow, listArea);
  sidebar.append(sidebarHeader, body);
  toggleBtn.addEventListener("click", () => toggleBody(body, toggleBtn));
  return sidebar;
}

function buildAppListPanel(editor: HTMLTextAreaElement): HTMLElement {
  const panel = el("div", "ksql-app-panel");
  const controlRow = el("div", "ksql-app-control-row");
  const fetchBtn = el("button", "ksql-app-fetch-btn") as HTMLButtonElement;
  fetchBtn.textContent = "一覧取得";

  const searchInput = el("input", "ksql-app-search", {
    type: "text",
    placeholder: "アプリ名 / APP番号 で検索",
  }) as HTMLInputElement;
  const insertMode = el("div", "ksql-app-insert-mode");
  const appModeLabel = el("label", "ksql-opt-radio-label");
  const appModeRadio = el("input", "", {
    type: "radio",
    name: "ksql-app-insert-mode",
    value: "app",
  }) as HTMLInputElement;
  appModeRadio.checked = true;
  appModeLabel.append(appModeRadio, document.createTextNode("APP"));
  const selectModeLabel = el("label", "ksql-opt-radio-label");
  const selectModeRadio = el("input", "", {
    type: "radio",
    name: "ksql-app-insert-mode",
    value: "select",
  }) as HTMLInputElement;
  selectModeLabel.append(selectModeRadio, document.createTextNode("SELECT"));
  insertMode.append(appModeLabel, selectModeLabel);

  controlRow.append(fetchBtn, searchInput, insertMode);

  const status = el("div", "ksql-app-status");
  status.textContent = "「一覧取得」でアプリ一覧を読み込みます";

  const list = el("ul", "ksql-app-list");
  panel.append(controlRow, status, list);

  let apps: KintoneAppInfo[] = [];

  const render = (): void => {
    list.innerHTML = "";
    const word = searchInput.value.trim().toLowerCase();
    const filtered = word
      ? apps.filter((a) =>
          String(a.appId).includes(word) ||
          a.name.toLowerCase().includes(word) ||
          String(a.description ?? "").toLowerCase().includes(word)
        )
      : apps;

    status.textContent = `${filtered.length}件 / 全${apps.length}件`;

    if (filtered.length === 0) {
      const empty = el("li", "ksql-app-empty");
      empty.textContent = apps.length === 0 ? "アプリがありません" : "該当なし";
      list.appendChild(empty);
      return;
    }

    for (const app of filtered) {
      const item = el("li", "ksql-app-item");
      item.title = app.description || "";

      const left = el("div", "ksql-app-item-main");
      const code = el("span", "ksql-app-code");
      code.textContent = `APP${app.appId}`;
      const name = el("span", "ksql-app-name");
      name.textContent = app.name || `(APP${app.appId})`;
      left.append(code, name);

      item.append(left);
      item.addEventListener("click", () => {
        const mode = readCheckedRadio(panel, "ksql-app-insert-mode");
        const token = mode === "select"
          ? `SELECT * FROM APP${app.appId}`
          : `APP${app.appId}`;
        insertAtCursor(editor, token);
      });
      list.appendChild(item);
    }
  };

  const load = (force = false): void => {
    if (force) appListCache = null;
    fetchBtn.disabled = true;
    status.textContent = "読み込み中...";

    void fetchApps()
      .then((res) => {
        apps = res;
        render();
      })
      .catch((err: unknown) => {
        apps = [];
        list.innerHTML = "";
        status.textContent = formatErrorMessage(err);
      })
      .finally(() => {
        fetchBtn.disabled = false;
      });
  };

  fetchBtn.addEventListener("click", () => load(true));
  searchInput.addEventListener("input", render);

  if (appListCache && appListCache.length > 0) {
    apps = appListCache;
    render();
  }

  return panel;
}

function renderFieldList(
  listArea: HTMLElement,
  fields: FieldInfo[],
  editor: HTMLTextAreaElement,
  filterWord = ""
): void {
  listArea.innerHTML = "";

  if (fields.length === 0) {
    listArea.textContent = "フィールドがありません";
    return;
  }

  const table = el("div", "ksql-field-table");
  const head = el("div", "ksql-field-head");
  const headCode = el("span", "ksql-field-code");
  headCode.textContent = "フィールドコード";
  const headLabel = el("span", "ksql-field-label");
  headLabel.textContent = "ラベル";
  const headType = el("span", "ksql-field-type");
  headType.textContent = "タイプ";
  const headChoices = el("span", "ksql-field-choices");
  headChoices.textContent = "選択肢";
  head.append(headCode, headLabel, headType, headChoices);

  const list = el("div", "ksql-field-list");
  const lower = filterWord.trim().toLowerCase();

  const buildItems = (): void => {
    list.innerHTML = "";
    const filtered = lower
      ? fields.filter(
        (f) =>
          f.code.toLowerCase().includes(lower) ||
          f.label.toLowerCase().includes(lower) ||
          f.fieldType.toLowerCase().includes(lower) ||
          (f.choices ?? []).some((c) => c.toLowerCase().includes(lower))
      )
      : fields;

    for (const f of filtered) {
      const li = el("button", "ksql-field-item", { type: "button" }) as HTMLButtonElement;
      li.title = `${f.label} (${f.fieldType})`;

      const codeSpan = el("span", "ksql-field-code");
      codeSpan.textContent = f.code;

      const labelSpan = el("span", "ksql-field-label");
      labelSpan.textContent = f.label !== f.code ? f.label : "";
      const typeSpan = el("span", "ksql-field-type");
      typeSpan.textContent = f.fieldType;
      const choicesSpan = el("span", "ksql-field-choices");
      choicesSpan.textContent = (f.choices && f.choices.length > 0) ? f.choices.join(", ") : "-";

      li.append(codeSpan, labelSpan, typeSpan, choicesSpan);
      li.addEventListener("click", () => insertAtCursor(editor, f.code));
      list.appendChild(li);
    }

    if (list.children.length === 0) {
      const empty = el("div", "ksql-field-empty");
      empty.textContent = "該当なし";
      list.appendChild(empty);
    }
  };

  buildItems();
  table.append(head, list);
  listArea.append(table);
}

/** テキストエリアのカーソル位置にテキストを挿入する */
function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end   = ta.selectionEnd   ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
}

// ============================================================
// 履歴ドロップダウン
// ============================================================

function toggleHistoryDropdown(
  editor: HTMLTextAreaElement,
  btn: HTMLElement,
  resultOptions?: DisplayOptions,
  maxRecords = 3000,
  onLimitReached: "error" | "truncate" = "error",
  onExecuted?: (result: ExecuteResult) => void
): void {
  const dropdown = document.getElementById("ksql-hist-dropdown");
  if (!dropdown) return;

  if (dropdown.style.display !== "none") {
    closeHistoryDropdown();
    return;
  }

  // 履歴リストを描画
  const history = loadHistory();
  if (history.length === 0) {
    dropdown.innerHTML = `<div class="ksql-hist-empty">履歴がありません</div>`;
  } else {
    dropdown.innerHTML = `
      <div class="ksql-hist-header">
        <span>履歴（最新 ${history.length} 件）</span>
        <button class="ksql-hist-clear-all" id="ksql-hist-clear-all">すべて削除</button>
      </div>
      <div class="ksql-hist-filter-row">
        <input class="ksql-hist-filter" id="ksql-hist-filter" type="text" placeholder="履歴をフィルター..." />
      </div>
      <ul class="ksql-hist-list" id="ksql-hist-list"></ul>
    `;

    const ul = dropdown.querySelector("#ksql-hist-list")!;
    const filterInput = dropdown.querySelector("#ksql-hist-filter") as HTMLInputElement | null;
    history.forEach((item, i) => {
      const sql = item.sql;
      const li = document.createElement("li");
      li.className = "ksql-hist-item";
      li.title = sql;
      li.setAttribute("data-filter", sql.toLowerCase());

      const preview = el("span", "ksql-hist-preview");
      preview.textContent = sql.length > 80 ? sql.slice(0, 80) + "…" : sql;

      const runHistBtn = el("button", "ksql-hist-run");
      runHistBtn.textContent = "実行";
      runHistBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        editor.value = sql;
        closeHistoryDropdown();
        const resultArea = document.getElementById("ksql-result");
        if (resultArea) {
          const histOptions = item.displayOptions ?? resultOptions;
          const histMax = sanitizeMaxRecords(String(item.maxRecords ?? maxRecords));
          const histMode = item.onLimitReached === "truncate" ? "truncate" : onLimitReached;
          void runSql(sql, resultArea, false, [], histOptions, histMax, histMode).then((r) => {
            if (r && onExecuted) onExecuted(r);
          });
        }
      });

      li.addEventListener("click", () => {
        editor.value = sql;
        closeHistoryDropdown();
        editor.focus();
      });

      li.append(preview, runHistBtn);
      ul.appendChild(li);
    });

    const applyFilter = (): void => {
      if (!filterInput) return;
      const word = filterInput.value.trim().toLowerCase();
      const items = Array.from(ul.querySelectorAll(".ksql-hist-item")) as HTMLElement[];
      for (const it of items) {
        const hay = (it.getAttribute("data-filter") ?? "").toLowerCase();
        const hit = word === "" || hay.includes(word);
        it.style.display = hit ? "" : "none";
      }
    };
    filterInput?.addEventListener("input", applyFilter);
    applyFilter();

    document.getElementById("ksql-hist-clear-all")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void showConfirmDialog("履歴をすべて削除しますか？").then((ok) => {
        if (ok) {
          localStorage.removeItem(HISTORY_KEY);
          closeHistoryDropdown();
        }
      });
    });
  }

  dropdown.style.display = "";
  btn.textContent = "履歴 ▲";
}

function closeHistoryDropdown(): void {
  const dropdown = document.getElementById("ksql-hist-dropdown");
  const btn      = document.getElementById("ksql-hist-btn");
  if (dropdown) dropdown.style.display = "none";
  if (btn) btn.textContent = "履歴 ▼";
}

// ============================================================
// SQL 実行
// ============================================================

/** 複文（バッチ）入力かどうか（パース不能な入力は false = 従来経路でエラー表示） */
function isMultiStatementSql(sql: string): boolean {
  try {
    return parseSqlStatements(sql).length > 1;
  } catch {
    return false;
  }
}

/** バッチ EXPLAIN のプランを既存のテーブル描画に載せるための SelectResult を組む */
function batchPlansToSelectResult(sql: string): SelectResult {
  const plans = buildBatchExplainPlans(sql);
  const rows: Array<{ plan: string }> = [];
  plans.statements.forEach((p) => {
    if (p.index > 0) rows.push({ plan: "" });
    rows.push({ plan: `[${p.index + 1}] ${p.type}` });
    p.plan.forEach((line) => rows.push({ plan: line }));
  });
  return { type: "SELECT", columns: ["plan"], rows, rowCount: rows.length };
}

/** バッチ実行の表示用結果（result = 最終結果セット、note = 情報行、dmlSummary = success した DML の影響件数） */
interface BatchRunOutcome {
  result: SelectResult | null;
  note: string | null;
  dmlSummary: string[];
  /** 確認ダイアログでキャンセルされた（履歴保存をスキップし note を情報表示する） */
  cancelled: boolean;
}

/** バッチ内 DML の確認ダイアログ見出し（"UPSERT_SELECT INTO APP4149" 等の SQL 風表記） */
function dmlDialogHead(statementType: string, targetAppId: number | null): string {
  const app = targetAppId !== null ? `APP${targetAppId}` : "";
  if (statementType === "UPDATE" || statementType === "REORDER") return `${statementType} ${app}`;
  if (statementType === "DELETE") return `DELETE FROM ${app}`;
  return `${statementType} INTO ${app}`;
}

/** バッチ内 DML の実行時確認（文番号・書き込み先付き。confirm フックの文コンテキストを使用） */
async function batchConfirmDialog(
  count: number,
  operation: "UPDATE" | "DELETE" | "INSERT",
  context?: DmlConfirmContext
): Promise<boolean> {
  if (!context) return confirmDialog(count, operation);
  const label = context.statementType.startsWith("UPSERT")
    ? "登録/更新"
    : operation === "UPDATE" ? "更新"
    : operation === "DELETE" ? "削除"
    : "登録";
  return showConfirmDialog(
    `[${context.statementIndex + 1}/${context.statementCount}] ${dmlDialogHead(context.statementType, context.targetAppId)}\n`
    + `${count} 件のレコードを${label}します。よろしいですか？\nこの操作は元に戻せません。`,
    true
  );
}

/** success した DML 文の影響件数サマリ（"[2] UPSERT_SELECT: inserted=1 updated=1" 等） */
function buildDmlSummary(batch: BatchExecuteResult): string[] {
  const lines: string[] = [];
  for (const s of batch.statements) {
    if (s.status !== "success" || !s.result) continue;
    const r = s.result;
    let detail: string | null = null;
    if (r.type === "INSERT") detail = `inserted=${r.insertedCount}`;
    else if (r.type === "UPDATE") detail = `updated=${r.updatedCount}`;
    else if (r.type === "DELETE") detail = `deleted=${r.deletedCount}`;
    else if (r.type === "UPSERT") detail = `inserted=${r.insertedCount} updated=${r.updatedCount}`;
    else if (r.type === "REORDER") detail = `reordered=${r.reorderedParentCount}`;
    if (detail) lines.push(`[${s.index + 1}] ${s.type}: ${detail}`);
  }
  return lines;
}

/**
 * 複文バッチを実行し、表示用の結果を返す（最終の結果セットのみ表示。仕様 §8.4）。
 * - DML を含むバッチは文ごとの確認ダイアログ付きで実行（v1.9.0 仕様
 *   docs/internal/ksql_plugin_dml_batch_spec.md）
 * - INSERT VALUES は confirm 非経由（コア実態）のため、静的確定件数で実行前に確認する
 * - 先頭文が EXPLAIN のバッチは全文プラン表示（実行しない）
 */
async function runBatchSql(
  sql: string,
  client: Parameters<typeof executeBatch>[1],
  options: { maxRecords: number; onLimitReached: "error" | "truncate" },
  explainOnly: boolean
): Promise<BatchRunOutcome> {
  const statements = parseSqlStatements(sql);
  const analysis = analyzeBatch(statements);

  // EXPLAIN ボタン経由、または先頭文が EXPLAIN のバッチ
  // → バッチ全体のプラン表示（kintone アクセスなし。2文目以降も実行しない）
  if (explainOnly || statements[0].type === "EXPLAIN") {
    return { result: batchPlansToSelectResult(sql), note: null, dmlSummary: [], cancelled: false };
  }

  // INSERT VALUES の実行前静的確認（仕様 §3.3。件数は静的に正確。
  // キャンセル時は1文も実行しない）
  for (const s of analysis.statements) {
    if (s.insertValuesCount === null) continue;
    const ok = await showConfirmDialog(
      `[${s.index + 1}/${analysis.statementCount}] ${dmlDialogHead(s.statementType, s.targetAppId)}\n`
      + `${s.insertValuesCount} 件のレコードを登録します。よろしいですか？\nこの操作は元に戻せません。`,
      true
    );
    if (!ok) {
      return {
        result: null,
        note: `キャンセルしました（文 [${s.index + 1}/${analysis.statementCount}] の実行前確認。バッチは実行されていません）`,
        dmlSummary: [],
        cancelled: true,
      };
    }
  }

  const batch = await executeBatch(sql, client, {
    maxRecords: options.maxRecords,
    // DML を含むバッチでは常に error（truncate だと SELECT-based DML のソース
    // 読み取りが黙って切り捨てられ、切り捨て後の件数で confirm → 部分書き込みに
    // なるため。MCP の ksql_mutate と同じ固定。仕様 §3.6）
    onLimitReached: analysis.containsDml ? "error" : options.onLimitReached,
    fetchParallel: FETCH_PARALLEL_DEFAULT,
    confirm: analysis.containsDml ? batchConfirmDialog : undefined,
  });

  const dmlSummary = buildDmlSummary(batch);

  if (!batch.ok) {
    const failed = batch.statements.find((s) => s.status === "error");
    // 実行時確認のキャンセル: エラーではなく情報表示（先行文は反映済み。仕様 §3.4）
    if (failed?.error?.code === "OperationCancelledError") {
      const pos = `[${failed.index + 1}/${batch.statementCount}]`;
      const note = failed.index === 0
        ? `キャンセルしました（文 ${pos} で中断。実行された文はありません）`
        : `キャンセルしました（文 ${pos} で中断。[${failed.index}] までの実行結果は反映済みです）`;
      return { result: null, note, dmlSummary, cancelled: true };
    }
    throw new Error(
      failed?.error
        ? `[${failed.index + 1}] ${failed.error.message}`
        : "バッチ実行に失敗しました"
    );
  }

  // 最後に結果セットを返した文（通常は最終 SELECT）のみ表示する。
  // 途中の SELECT 結果は表示しない（最終結果のみ、が本 UI の契約）
  const lastSelect = [...batch.statements].reverse().find((s) => s.result?.type === "SELECT");
  if (lastSelect?.result?.type === "SELECT") {
    return {
      result: lastSelect.result,
      note: dmlSummary.length > 0 ? `バッチ ${batch.statementCount} 文を実行しました。` : null,
      dmlSummary,
      cancelled: false,
    };
  }
  return {
    result: null,
    note: `バッチ ${batch.statementCount} 文を実行しました（結果セットなし）。`,
    dmlSummary,
    cancelled: false,
  };
}

async function runSql(
  sql: string,
  resultArea: HTMLElement,
  skipHistory = false,
  extraButtons: HTMLButtonElement[] = [],
  resultOptions?: DisplayOptions,
  maxRecords = 3000,
  onLimitReached: "error" | "truncate" = "error",
  /** バッチ入力を実行せずプラン表示する（EXPLAIN ボタン経由。単文には影響しない） */
  batchExplainOnly = false
): Promise<ExecuteResult | null> {
  if (!sql) {
    resultArea.innerHTML = `<div class="ksql-info">SQL が空のため実行できません。</div>`;
    return null;
  }

  const runBtn = document.getElementById("ksql-run-btn") as HTMLButtonElement | null;
  const explainBtn = document.getElementById("ksql-explain-btn") as HTMLButtonElement | null;
  const buttons = [runBtn, explainBtn, ...extraButtons]
    .filter((b): b is HTMLButtonElement => !!b);
  const panel = resultArea.closest(".ksql-panel") as HTMLElement | null;
  const editor = panel?.querySelector("#ksql-editor") as HTMLTextAreaElement | null;
  const snapshotOptions = normalizeDisplayOptions(resultOptions ?? displayOptions);
  const runtimeFetch = resolveRuntimeFetchOptions(resultArea, maxRecords, onLimitReached);
  const snapshotMax = runtimeFetch.maxRecords;
  const snapshotMode = runtimeFetch.onLimitReached;

  try {
    buttons.forEach((b) => { b.disabled = true; });
    if (editor) editor.readOnly = true;
    resultArea.innerHTML = renderLoading();

    const client = createKintoneClient();
    const resolvedOptions = resultOptions ?? displayOptions;

    // 複文バッチ: 最終結果のみ表示（仕様 §8.4）。DML を含むバッチは
    // 文ごとの確認ダイアログ付きで実行（v1.9.0）
    if (isMultiStatementSql(sql)) {
      const { result: batchResult, note, dmlSummary, cancelled } = await runBatchSql(sql, client, {
        maxRecords: runtimeFetch.maxRecords,
        onLimitReached: runtimeFetch.onLimitReached,
      }, batchExplainOnly);
      // キャンセル時は単文 DML キャンセルと同様、履歴に保存しない
      if (!skipHistory && !cancelled) saveHistory(sql, snapshotOptions, snapshotMax, snapshotMode);
      const infoParts = [note, ...dmlSummary].filter((s): s is string => !!s);
      const infoHtml = infoParts.length > 0
        ? `<div class="ksql-info">${infoParts.join("<br>")}</div>`
        : "";
      if (batchResult) {
        lastResult = batchResult;
        resultArea.innerHTML = infoHtml + renderResult(batchResult, resolvedOptions);
        bindResultTableFeatures(resultArea);
        return batchResult;
      }
      resultArea.innerHTML = infoHtml || `<div class="ksql-info"></div>`;
      return null;
    }

    // 単文 INSERT VALUES: コアの confirm を通らないため、静的確定件数で実行前に確認する
    //（v1.9.0 仕様 §3.3。パース不能な入力はそのまま execute のエラー表示に任せる）
    let insertValuesConfirm: { count: number; appId: number | null } | null = null;
    let isDmlSql = false;
    try {
      const stmt = parseSqlStatement(sql);
      isDmlSql = isDmlType(getStatementType(stmt));
      const count = getInsertValuesCount(stmt);
      if (count !== null) {
        const appId = (stmt as { appId?: unknown }).appId;
        insertValuesConfirm = { count, appId: typeof appId === "number" ? appId : null };
      }
    } catch { /* 単文として不正な入力は execute に任せる */ }
    if (insertValuesConfirm) {
      const app = insertValuesConfirm.appId !== null ? `APP${insertValuesConfirm.appId}` : "";
      const ok = await showConfirmDialog(
        `INSERT INTO ${app}\n${insertValuesConfirm.count} 件のレコードを登録します。よろしいですか？\nこの操作は元に戻せません。`,
        true
      );
      if (!ok) {
        resultArea.innerHTML = `<div class="ksql-info">キャンセルしました（対象: ${insertValuesConfirm.count} 件）</div>`;
        return null;
      }
    }

    const result = await execute(sql, client, {
      confirm: confirmDialog,
      maxRecords: runtimeFetch.maxRecords,
      // DML では常に error（truncate だと SELECT-based DML のソース読み取りが
      // 黙って切り捨てられ部分書き込みになるため。バッチ側と同じ固定。仕様 §3.6）
      onLimitReached: isDmlSql ? "error" : runtimeFetch.onLimitReached,
      fetchParallel: FETCH_PARALLEL_DEFAULT,
    });

    lastResult = result;
    if (!skipHistory) saveHistory(sql, snapshotOptions, snapshotMax, snapshotMode);
    resultArea.innerHTML = renderResult(result, resolvedOptions);
    bindResultTableFeatures(resultArea);
    return result;
  } catch (e) {
    if (e instanceof OperationCancelledError) {
      resultArea.innerHTML = `<div class="ksql-info">キャンセルしました（対象: ${e.affectedCount} 件）</div>`;
    } else {
      if (!skipHistory) saveHistory(sql, snapshotOptions, snapshotMax, snapshotMode); // エラー時も履歴に保存
      resultArea.innerHTML = renderError(e);
    }
    return null;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    if (editor) editor.readOnly = false;
  }
}

function resolveRuntimeFetchOptions(
  resultArea: HTMLElement,
  fallbackMax: number,
  fallbackMode: "error" | "truncate"
): { maxRecords: number; onLimitReached: "error" | "truncate" } {
  const panel = resultArea.closest(".ksql-panel") as HTMLElement | null;
  const maxInput = panel?.querySelector("#ksql-max-records-input") as HTMLInputElement | null;

  // "取得" タブが非表示の場合（タブ切り替えで DOM から除去済み）または panel が存在しない場合は
  // 呼び出し元から渡された値（panelMaxRecordsState 等）をそのまま使用する
  if (maxInput === null) {
    return {
      maxRecords: sanitizeMaxRecords(String(fallbackMax)),
      onLimitReached: fallbackMode,
    };
  }

  // "取得" タブが表示中 → DOM の現在値を読み取る
  const mode = readCheckedRadio(panel!, "ksql-limit-mode");
  return {
    maxRecords: sanitizeMaxRecords(maxInput.value),
    onLimitReached: mode === "truncate" ? "truncate" : "error",
  };
}

function bindResultTableFeatures(resultArea: HTMLElement): void {
  const fullBtn = resultArea.querySelector(".ksql-result-full-btn") as HTMLButtonElement | null;
  const panelBody = resultArea.closest(".ksql-panel-body") as HTMLElement | null;
  const editorRow = panelBody?.querySelector(".ksql-editor-row") as HTMLElement | null;
  const input = resultArea.querySelector(".ksql-result-filter-input") as HTMLInputElement | null;
  const table = resultArea.querySelector(".ksql-table") as HTMLTableElement | null;
  const tbody = resultArea.querySelector(".ksql-table tbody") as HTMLTableSectionElement | null;
  const countEl = resultArea.querySelector(".ksql-result-count") as HTMLElement | null;
  if (!fullBtn || !input || !table || !tbody) return;

  const heads = Array.from(table.querySelectorAll("thead th.ksql-sortable-th")) as HTMLTableCellElement[];
  const getRows = (): HTMLTableRowElement[] => Array.from(tbody.querySelectorAll("tr")) as HTMLTableRowElement[];
  const total = getRows().length;
  let sortCol = -1;
  let sortDir: 1 | -1 = 1;
  let isFullscreen = false;
  let prevBodyOverflow = "";

  const setFullBtnState = (): void => {
    fullBtn.textContent = isFullscreen ? "⤡" : "⤢";
    fullBtn.title = isFullscreen ? "全画面を解除（Esc）" : "全画面表示";
    fullBtn.setAttribute("aria-label", fullBtn.title);
  };

  const toolbarBottom = (): number => {
    const selectors = [
      "#header",
      ".gaia-header",
      ".gaia-argoui-app-toolbar",
      ".gaia-argoui-app-index-toolbar",
      ".gaia-argoui-app-breadcrumbs",
    ];
    let max = 0;
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        if (r.bottom > 0 && r.bottom < 260) {
          max = Math.max(max, Math.ceil(r.bottom));
        }
      }
    }
    return max > 0 ? max : 48;
  };

  const updateFullscreenRect = (): void => {
    if (!isFullscreen) return;
    const top = toolbarBottom();
    resultArea.style.top = `${top}px`;
    resultArea.style.height = `calc(100vh - ${top}px)`;
  };

  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") exitFullscreen();
  };
  const onWindow = (): void => updateFullscreenRect();

  const enterFullscreen = (): void => {
    if (isFullscreen) return;
    isFullscreen = true;
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    resultArea.classList.add("ksql-result-fullscreen");
    if (panelBody) panelBody.classList.add("ksql-panel-fullscreen");
    if (editorRow) editorRow.style.display = "none";
    updateFullscreenRect();
    window.addEventListener("resize", onWindow);
    window.addEventListener("scroll", onWindow, true);
    document.addEventListener("keydown", onEsc);
    setFullBtnState();
  };

  const exitFullscreen = (): void => {
    if (!isFullscreen) return;
    isFullscreen = false;
    resultArea.classList.remove("ksql-result-fullscreen");
    if (panelBody) panelBody.classList.remove("ksql-panel-fullscreen");
    resultArea.style.top = "";
    resultArea.style.height = "";
    if (editorRow) editorRow.style.display = "";
    document.body.style.overflow = prevBodyOverflow;
    window.removeEventListener("resize", onWindow);
    window.removeEventListener("scroll", onWindow, true);
    document.removeEventListener("keydown", onEsc);
    setFullBtnState();
  };

  fullBtn.addEventListener("click", () => {
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  });
  setFullBtnState();

  const parseNum = (raw: string): number | null => {
    const cleaned = raw.replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const apply = (): void => {
    const word = input.value.trim().toLowerCase();
    let visible = 0;
    let rowNo = 1;
    for (const tr of getRows()) {
      const text = (tr.dataset.search ?? "").toLowerCase();
      const hit = word === "" || text.includes(word);
      tr.style.display = hit ? "" : "none";
      const noCell = tr.querySelector(".ksql-rowno-td") as HTMLTableCellElement | null;
      if (noCell) noCell.textContent = hit ? String(rowNo++) : "";
      if (hit) visible += 1;
    }
    if (countEl) {
      countEl.textContent = word === "" ? String(visible) : `${visible} / ${total}`;
    }
    input.title = word === "" ? "" : `${visible} / ${total} 件表示`;
  };

  const sortBy = (colIndex: number): void => {
    const rows = getRows();
    rows.sort((a, b) => {
      const aText = (a.children[colIndex + 1] as HTMLTableCellElement | undefined)?.textContent?.trim() ?? "";
      const bText = (b.children[colIndex + 1] as HTMLTableCellElement | undefined)?.textContent?.trim() ?? "";
      const an = parseNum(aText);
      const bn = parseNum(bText);
      if (an !== null && bn !== null) return (an - bn) * sortDir;
      return aText.localeCompare(bText, "ja", { numeric: true, sensitivity: "base" }) * sortDir;
    });
    tbody.innerHTML = "";
    for (const tr of rows) tbody.appendChild(tr);
    apply();
  };

  for (const th of heads) {
    th.addEventListener("click", () => {
      const idx = parseInt(th.dataset.colIndex ?? "", 10);
      if (!Number.isFinite(idx)) return;
      if (sortCol === idx) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortCol = idx;
        sortDir = 1;
      }

      for (const h of heads) h.classList.remove("is-sort-asc", "is-sort-desc");
      th.classList.add(sortDir === 1 ? "is-sort-asc" : "is-sort-desc");
      sortBy(idx);
    });
  }

  const host = resultArea as HTMLElement & {
    __ksqlSubtblClickHandler?: (e: Event) => void;
  };
  if (host.__ksqlSubtblClickHandler) {
    resultArea.removeEventListener("click", host.__ksqlSubtblClickHandler);
  }
  const onSubtableClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest(".ksql-subtbl-count") as HTMLButtonElement | null;
    if (!btn) return;
    e.preventDefault();
    const raw = btn.getAttribute("data-ksql-subtbl") ?? "[]";
    const total = parseInt(btn.getAttribute("data-ksql-subtbl-total") ?? "0", 10);
    const fieldCode = btn.getAttribute("data-ksql-subtbl-field") ?? "";
    let rows: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        rows = parsed.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null);
      }
    } catch {
      rows = [];
    }
    showSubtablePopup(rows, Number.isFinite(total) ? total : rows.length, fieldCode);
  };
  host.__ksqlSubtblClickHandler = onSubtableClick;
  resultArea.addEventListener("click", onSubtableClick);

  input.addEventListener("input", apply);
  apply();
}

function showSubtablePopup(rows: Array<Record<string, unknown>>, total: number, fieldCode = ""): void {
  const overlay = el("div", "ksql-subtbl-overlay");
  const modal = el("div", "ksql-subtbl-modal");
  const header = el("div", "ksql-subtbl-header");
  const title = el("span", "ksql-subtbl-title");
  title.textContent = fieldCode
    ? `テーブル内容: ${fieldCode}（${total} 行）`
    : `テーブル内容（${total} 行）`;
  const closeBtn = el("button", "ksql-subtbl-close", { type: "button" }) as HTMLButtonElement;
  closeBtn.textContent = "閉じる";
  header.append(title, closeBtn);

  const body = el("div", "ksql-subtbl-body");
  if (rows.length === 0) {
    const empty = el("div", "ksql-subtbl-empty");
    empty.textContent = "表示できません";
    body.appendChild(empty);
  } else {
    const filterRow = el("div", "ksql-subtbl-filter-row");
    const filterInput = el("input", "ksql-subtbl-filter", {
      type: "text",
      placeholder: "フィルター...",
    }) as HTMLInputElement;
    const countInfo = el("span", "ksql-subtbl-count-info");
    filterRow.append(filterInput, countInfo);
    const cols: string[] = [];
    for (const r of rows) {
      for (const key of Object.keys(r)) {
        if (!cols.includes(key)) cols.push(key);
      }
    }
    const wrap = el("div", "ksql-subtbl-table-wrap");
    const table = document.createElement("table");
    table.className = "ksql-subtbl-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const rowNoHead = document.createElement("th");
    rowNoHead.textContent = "#";
    rowNoHead.className = "ksql-subtbl-rowno-th";
    hr.appendChild(rowNoHead);
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c;
      th.className = "ksql-subtbl-sortable-th";
      th.setAttribute("data-col", c);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");

    type PopupRow = { raw: Record<string, unknown>; values: Record<string, string>; search: string };
    const allRows: PopupRow[] = rows.map((r) => {
      const values: Record<string, string> = {};
      for (const c of cols) values[c] = formatPopupCell(r[c]);
      return {
        raw: r,
        values,
        search: cols.map((c) => values[c]).join(" ").toLowerCase(),
      };
    });
    let sorted = [...allRows];
    let sortCol = "";
    let sortDir: 1 | -1 = 1;

    const parseNum = (raw: string): number | null => {
      const cleaned = raw.replace(/,/g, "").trim();
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    };

    const renderBody = (): void => {
      tbody.innerHTML = "";
      for (const row of sorted) {
        const tr = document.createElement("tr");
        tr.setAttribute("data-filter", row.search);
        const no = document.createElement("td");
        no.className = "ksql-subtbl-rowno-td";
        no.textContent = "";
        tr.appendChild(no);
        for (const c of cols) {
          const td = document.createElement("td");
          td.textContent = row.values[c];
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    };

    const applyFilter = (): void => {
      const word = filterInput.value.trim().toLowerCase();
      const trs = Array.from(tbody.querySelectorAll("tr")) as HTMLTableRowElement[];
      let visible = 0;
      let rowNo = 1;
      for (const tr of trs) {
        const hit = word === "" || (tr.getAttribute("data-filter") ?? "").includes(word);
        tr.style.display = hit ? "" : "none";
        const no = tr.querySelector(".ksql-subtbl-rowno-td") as HTMLTableCellElement | null;
        if (no) no.textContent = hit ? String(rowNo++) : "";
        if (hit) visible += 1;
      }
      countInfo.textContent = word === "" ? `${visible} 件` : `${visible} / ${allRows.length}`;
    };

    const sortBy = (col: string): void => {
      if (!col) return;
      sorted = [...sorted].sort((a, b) => {
        const av = a.values[col] ?? "";
        const bv = b.values[col] ?? "";
        const an = parseNum(av);
        const bn = parseNum(bv);
        if (an !== null && bn !== null) return (an - bn) * sortDir;
        return av.localeCompare(bv, "ja", { numeric: true, sensitivity: "base" }) * sortDir;
      });
      renderBody();
      applyFilter();
    };

    const heads = Array.from(thead.querySelectorAll(".ksql-subtbl-sortable-th")) as HTMLTableCellElement[];
    for (const th of heads) {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-col") ?? "";
        if (!col) return;
        if (sortCol === col) sortDir = sortDir === 1 ? -1 : 1;
        else {
          sortCol = col;
          sortDir = 1;
        }
        for (const h of heads) h.classList.remove("is-sort-asc", "is-sort-desc");
        th.classList.add(sortDir === 1 ? "is-sort-asc" : "is-sort-desc");
        sortBy(col);
      });
    }

    renderBody();
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.append(filterRow, wrap);

    filterInput.addEventListener("input", applyFilter);
    applyFilter();

    if (total > rows.length) {
      const note = el("div", "ksql-subtbl-note");
      note.textContent = `先頭 ${rows.length} 行のみ表示（全 ${total} 行）`;
      body.appendChild(note);
    }
  }

  modal.append(header, body);
  overlay.appendChild(modal);

  const close = (): void => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  };
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
}

function formatPopupCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ============================================================
// 表示オプションパネル
// ============================================================

function buildOptionsPanel(opts: DisplayOptions, onChange: () => void): HTMLElement {
  const panel = el("div", "ksql-opt-panel");

  // ユーザーフィールド行
  const userRow = el("div", "ksql-opt-row");
  const userLabel = el("span", "ksql-opt-label");
  userLabel.textContent = "ユーザー:";
  userRow.appendChild(userLabel);

  const userChoices: Array<{ value: DisplayOptions["userFormat"]; label: string }> = [
    { value: "full", label: "そのまま" },
    { value: "name", label: "名前" },
    { value: "code", label: "コード" },
  ];
  for (const { value, label } of userChoices) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type:  "radio",
      name:  "ksql-user-fmt",
      value: value!,
    }) as HTMLInputElement;
    radio.checked = (opts.userFormat ?? "full") === value;
    radio.addEventListener("change", () => {
      opts.userFormat = value;
      onChange();
    });
    lbl.append(radio, document.createTextNode(label));
    userRow.appendChild(lbl);
  }

  // 配列フィールド行
  const arrRow = el("div", "ksql-opt-row");
  const arrLabel = el("span", "ksql-opt-label");
  arrLabel.textContent = "配列:";
  arrRow.appendChild(arrLabel);

  const arrChoices: Array<{ value: DisplayOptions["arrayFormat"]; label: string }> = [
    { value: "full", label: "そのまま" },
    { value: "join", label: "カンマ区切り" },
  ];
  for (const { value, label } of arrChoices) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type:  "radio",
      name:  "ksql-arr-fmt",
      value: value!,
    }) as HTMLInputElement;
    radio.checked = (opts.arrayFormat ?? "full") === value;
    radio.addEventListener("change", () => {
      opts.arrayFormat = value;
      onChange();
    });
    lbl.append(radio, document.createTextNode(label));
    arrRow.appendChild(lbl);
  }

  // サブテーブル行
  const tblRow = el("div", "ksql-opt-row");
  const tblLabel = el("span", "ksql-opt-label");
  tblLabel.textContent = "テーブル:";
  tblRow.appendChild(tblLabel);

  const tblChoices: Array<{ value: DisplayOptions["tableFormat"]; label: string }> = [
    { value: "full",  label: "そのまま" },
    { value: "count", label: "行数のみ" },
  ];
  for (const { value, label } of tblChoices) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type:  "radio",
      name:  "ksql-tbl-fmt",
      value: value!,
    }) as HTMLInputElement;
    radio.checked = (opts.tableFormat ?? "full") === value;
    radio.addEventListener("change", () => {
      opts.tableFormat = value;
      onChange();
    });
    lbl.append(radio, document.createTextNode(label));
    tblRow.appendChild(lbl);
  }

  // 日付・日時行
  const dateRow = el("div", "ksql-opt-row");
  const dateLabel = el("span", "ksql-opt-label");
  dateLabel.textContent = "日時:";
  dateRow.appendChild(dateLabel);

  const dateChoices: Array<{ value: DisplayOptions["dateFormat"]; label: string }> = [
    { value: "full",  label: "そのまま" },
    { value: "local", label: "ローカル形式" },
  ];
  for (const { value, label } of dateChoices) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type:  "radio",
      name:  "ksql-date-fmt",
      value: value!,
    }) as HTMLInputElement;
    radio.checked = (opts.dateFormat ?? "full") === value;
    radio.addEventListener("change", () => {
      opts.dateFormat = value;
      onChange();
    });
    lbl.append(radio, document.createTextNode(label));
    dateRow.appendChild(lbl);
  }

  // 添付ファイル行
  const fileRow = el("div", "ksql-opt-row");
  const fileLabel = el("span", "ksql-opt-label");
  fileLabel.textContent = "ファイル:";
  fileRow.appendChild(fileLabel);

  const fileChoices: Array<{ value: DisplayOptions["attachmentFormat"]; label: string }> = [
    { value: "full", label: "そのまま" },
    { value: "name", label: "名前" },
    { value: "fileKey", label: "fileKey" },
  ];
  for (const { value, label } of fileChoices) {
    const lbl = el("label", "ksql-opt-radio-label");
    const radio = el("input", "", {
      type:  "radio",
      name:  "ksql-file-fmt",
      value: value!,
    }) as HTMLInputElement;
    radio.checked = (opts.attachmentFormat ?? "full") === value;
    radio.addEventListener("change", () => {
      opts.attachmentFormat = value;
      onChange();
    });
    lbl.append(radio, document.createTextNode(label));
    fileRow.appendChild(lbl);
  }

  panel.append(userRow, arrRow, fileRow, dateRow, tblRow);
  return panel;
}

// ============================================================
// カスタム確認ダイアログ
// ============================================================

/**
 * Promise ベースのカスタム確認ダイアログを表示する。
 * resolve(true) = OK、resolve(false) = キャンセル。
 */
function showConfirmDialog(message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    // オーバーレイ
    const overlay = el("div", "ksql-dialog-overlay");

    // ダイアログ本体
    const dialog = el("div", "ksql-dialog");

    const msgEl = el("div", "ksql-dialog-message");
    msgEl.textContent = message;

    const btnRow = el("div", "ksql-dialog-btn-row");

    const okBtn = el("button", danger ? "ksql-dialog-ok ksql-dialog-ok--danger" : "ksql-dialog-ok");
    okBtn.textContent = "OK";

    const cancelBtn = el("button", "ksql-dialog-cancel");
    cancelBtn.textContent = "キャンセル";

    const close = (result: boolean): void => {
      document.body.removeChild(overlay);
      resolve(result);
    };

    okBtn.addEventListener("click",     () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    overlay.addEventListener("click",   (e) => { if (e.target === overlay) close(false); });

    btnRow.append(cancelBtn, okBtn);
    dialog.append(msgEl, btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

// ============================================================
// DML 確認ダイアログ（UPDATE / DELETE / INSERT_SELECT の登録）
// ============================================================

async function confirmDialog(
  count: number,
  operation: "UPDATE" | "DELETE" | "INSERT"
): Promise<boolean> {
  const label =
    operation === "UPDATE" ? "更新"
    : operation === "DELETE" ? "削除"
    : "登録"; // INSERT ... SELECT（書き込み前に件数確定）
  return showConfirmDialog(
    `${count} 件のレコードを${label}します。よろしいですか？\nこの操作は元に戻せません。`,
    true
  );
}

// ============================================================
// パネル折りたたみ
// ============================================================

function toggleBody(body: HTMLElement, btn: HTMLElement): void {
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "" : "none";
  btn.textContent = collapsed ? "▲ 折りたたむ" : "▼ 展開";
}

// ============================================================
// DOM ヘルパー
// ============================================================

function el(
  tag: string,
  className?: string,
  attrs?: Record<string, string>
): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      e.setAttribute(k, v);
    }
  }
  return e;
}
