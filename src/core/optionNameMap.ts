import type { KintoneFieldInfo } from "../execute";
import type { OptionValueTranslate } from "./recordOptionValues";

/**
 * B205 段階 1: 選択肢とステータスの「既定の名称 ⇄ 利用者の表示言語の名称」の対応表。
 *
 * **正本は既定の名称**（管理者が項目の設定画面で見ている値。言語によらず 1 つに決まる唯一の値）。
 * kintone との境目で表示名へ／から変換する。
 *
 * ## 作り方
 *
 * | 対象 | 取り方 |
 * |---|---|
 * | 選択肢 | `form/fields` を **`lang` なし**（既定名）と **`lang: "user"`**（表示名）の 2 回取り、**`index` で突き合わせる** |
 * | ステータス | `app/status.json` を `lang: "user"` で 1 回。**キーが既定名・`name` が表示名**（`index` つき） |
 *
 * ## 一意に決まらない表は受け取らない（fail-closed）
 *
 * 黙って取り違えるより、**レコードを 1 件も読む前に止める**。拒む形は `assertUsableOptionNamePairs` を参照。
 * とくに**表示名の重複**（`A→X` と `B→X`）は、読み戻しが多対一になるので必ず拒む。
 * **既定名と表示名の交差**（`A→B` と `B→A` の交換・循環・`A→A` と `B→A`）も拒む。
 * 理由は「向きが決まらない」ではなく、**言語ごとの表示名を設定する前に入った生の値と表示名を
 * 区別できなくなる**から（知らない値はそのまま通す、という約束を守るため）。
 */

/** 選択肢の型（ステータスは別に扱う）。 */
export const OPTION_NAME_FIELD_TYPES: ReadonlySet<string> = new Set([
  "RADIO_BUTTON", "DROP_DOWN", "CHECK_BOX", "MULTI_SELECT",
]);

/** 1 項目ぶんの対応（既定名・表示名・画面の並び順）。 */
export interface OptionNamePair {
  readonly canonical: string;
  readonly display: string;
  readonly index: number;
}

/** 項目ごとの対応表（`fieldCode` → 両方向）。 */
export interface FieldOptionNames {
  readonly fieldCode: string;
  /** 既定名 → 表示名（kintone へ送るとき） */
  readonly toDisplay: ReadonlyMap<string, string>;
  /** 表示名 → 既定名（kintone から読んだとき） */
  readonly toCanonical: ReadonlyMap<string, string>;
}

/** アプリ 1 つぶんの対応表。 */
export interface AppOptionNameMap {
  readonly appId: number;
  /** 言語ごとの表示名が 1 つも無い（＝変換が恒等）なら true。包み自体を通さない判断に使う。 */
  readonly identity: boolean;
  readonly fields: ReadonlyMap<string, FieldOptionNames>;
}

/** 表示名の取得で使う生のメタデータ（クライアントが返す形）。 */
export interface OptionNameSource {
  readonly appId: number;
  /** `form/fields`（`lang: "user"`）を平坦化したもの */
  readonly fields: readonly KintoneFieldInfo[];
  /** `app/status.json`（`lang: "user"`）。キー（既定名）と `name`（表示名）の対。プロセス管理が無ければ null */
  readonly statusStates: readonly OptionNamePair[] | null;
}

/** `app/status.json`（`lang: "user"`）の生の形。**キーが既定名・`name` が表示名**。 */
export interface RawLocalizedStatusStates {
  readonly states: Readonly<Record<string, { readonly name?: unknown; readonly index?: unknown }>> | null;
}

/**
 * クライアントが `getOptionNames` で返す生のメタデータを組み立てる助け
 * （内製クライアント 4 つが同じ正規化を使うため。写すとずれる）。
 *
 * - `userFields`: `form/fields`（**`lang: "user"`**）を `flattenFormFieldProperties` で平坦化したもの
 * - `status`: `app/status.json`（**`lang: "user"`**）の本体。プロセス管理が無ければ `states: null`
 */
export function optionNameSourceFrom(
  appId: number,
  userFields: readonly KintoneFieldInfo[],
  status: RawLocalizedStatusStates | null
): OptionNameSource {
  const rawStates = status?.states ?? null;
  const statusStates = rawStates === null
    ? null
    : Object.entries(rawStates).map(([canonical, state]) => {
        const index = Number(state?.index);
        if (!Number.isSafeInteger(index) || index < 0) {
          throw new OptionNameMapError(
            `process status "${canonical}" has an invalid index (${String(state?.index)}).`
          );
        }
        const display = typeof state?.name === "string" && state.name !== "" ? state.name : canonical;
        return { canonical, display, index };
      });
  return { appId, fields: userFields, statusStates };
}

export class OptionNameMapError extends Error {
  constructor(message: string) {
    super(`ArgumentError: ${message}`);
    this.name = "OptionNameMapError";
  }
}

/** `optionOrder`（名前 → index）を index 順の名前の並びにする。 */
function namesByIndex(fieldCode: string, order: Record<string, number>, label: string): string[] {
  const entries = Object.entries(order);
  const seen = new Set<number>();
  for (const [name, index] of entries) {
    if (name === "") {
      throw new OptionNameMapError(`field ${fieldCode}: ${label} has an empty option name.`);
    }
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new OptionNameMapError(
        `field ${fieldCode}: ${label} option "${name}" has an invalid index (${String(index)}).`
      );
    }
    if (seen.has(index)) {
      throw new OptionNameMapError(`field ${fieldCode}: ${label} has duplicate option index ${index}.`);
    }
    seen.add(index);
  }
  const names: string[] = [];
  for (const [name, index] of entries) names[index] = name;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === undefined) {
      throw new OptionNameMapError(`field ${fieldCode}: ${label} is missing option index ${i}.`);
    }
  }
  return names;
}

/**
 * 1 項目ぶんの対応が使える形かを確かめる。使えない形は投げる（レコードは 1 件も読まない）。
 *
 * 拒むもの: 既定名・表示名が空／`index` の欠落・重複・両側で不一致／選択肢の数が違う／
 * **表示名の重複**（逆変換が多対一）／**既定名と表示名の交差**（交換・循環・identity と別選択肢の衝突）。
 */
export function assertUsableOptionNamePairs(
  fieldCode: string,
  pairs: readonly OptionNamePair[]
): void {
  const canonicals = new Set<string>();
  const displays = new Set<string>();
  for (const { canonical, display } of pairs) {
    if (canonical === "") throw new OptionNameMapError(`field ${fieldCode}: an option has an empty default name.`);
    if (display === "") {
      throw new OptionNameMapError(
        `field ${fieldCode}: option "${canonical}" has an empty display name; `
        + "set every language-specific name or none."
      );
    }
    if (canonicals.has(canonical)) {
      throw new OptionNameMapError(`field ${fieldCode}: duplicate default name "${canonical}".`);
    }
    if (displays.has(display)) {
      throw new OptionNameMapError(
        `field ${fieldCode}: display name "${display}" is used by more than one option; `
        + "reading it back would be ambiguous."
      );
    }
    canonicals.add(canonical);
    displays.add(display);
  }
  // 既定名と表示名の交差（identity は除く）。生の値と表示名を区別できなくなるため拒む。
  for (const { canonical, display } of pairs) {
    if (canonical === display) continue;
    if (canonicals.has(display)) {
      throw new OptionNameMapError(
        `field ${fieldCode}: display name "${display}" (of option "${canonical}") is also the default name `
        + "of another option; values stored before the language-specific names were set could not be told apart."
      );
    }
    if (displays.has(canonical)) {
      throw new OptionNameMapError(
        `field ${fieldCode}: default name "${canonical}" is also the display name of another option; `
        + "values stored before the language-specific names were set could not be told apart."
      );
    }
  }
}

function pairsFromOrders(
  fieldCode: string,
  canonicalOrder: Record<string, number>,
  displayOrder: Record<string, number>
): OptionNamePair[] {
  const canonicalNames = namesByIndex(fieldCode, canonicalOrder, "default-language form");
  const displayNames = namesByIndex(fieldCode, displayOrder, "user-language form");
  if (canonicalNames.length !== displayNames.length) {
    throw new OptionNameMapError(
      `field ${fieldCode}: the default-language form has ${canonicalNames.length} options but the `
      + `user-language form has ${displayNames.length}; the mapping cannot be paired by index.`
    );
  }
  return canonicalNames.map((canonical, index) => ({ canonical, display: displayNames[index], index }));
}

function fieldOptionNamesFrom(fieldCode: string, pairs: readonly OptionNamePair[]): FieldOptionNames {
  assertUsableOptionNamePairs(fieldCode, pairs);
  return {
    fieldCode,
    toDisplay: new Map(pairs.map(({ canonical, display }) => [canonical, display])),
    toCanonical: new Map(pairs.map(({ canonical, display }) => [display, canonical])),
  };
}

/** ステータスの対応（`app/status.json` はキーが既定名・`name` が表示名）。 */
export const STATUS_FIELD_TYPE = "STATUS";

/**
 * 既定名の側（コアが既に取っている `getFields`）と、表示名の側（クライアントの生のメタデータ）から
 * アプリ 1 つぶんの対応表を作る。**一意に決まらない形はここで投げる。**
 */
export function buildAppOptionNameMap(
  appId: number,
  canonicalFields: readonly KintoneFieldInfo[],
  source: OptionNameSource
): AppOptionNameMap {
  if (source.appId !== appId) {
    throw new OptionNameMapError(
      `option names were fetched for app ${source.appId} but app ${appId} was requested.`
    );
  }
  const displayByCode = new Map(source.fields.map((field) => [field.code, field]));
  const fields = new Map<string, FieldOptionNames>();
  let identity = true;

  for (const field of canonicalFields) {
    if (!OPTION_NAME_FIELD_TYPES.has(field.fieldType) || field.optionOrder === undefined) continue;
    const display = displayByCode.get(field.code);
    if (display?.optionOrder === undefined) {
      throw new OptionNameMapError(
        `field ${field.code}: the user-language form does not describe this choice field; `
        + "the client must return the same fields as getFields."
      );
    }
    const pairs = pairsFromOrders(field.code, field.optionOrder, display.optionOrder);
    if (pairs.some((pair) => pair.canonical !== pair.display)) identity = false;
    fields.set(field.code, fieldOptionNamesFrom(field.code, pairs));
  }

  if (source.statusStates !== null && source.statusStates.length > 0) {
    const statusField = canonicalFields.find((field) => field.fieldType === STATUS_FIELD_TYPE);
    if (statusField !== undefined) {
      const pairs = [...source.statusStates].sort((a, b) => a.index - b.index);
      if (pairs.some((pair) => pair.canonical !== pair.display)) identity = false;
      fields.set(statusField.code, fieldOptionNamesFrom(statusField.code, pairs));
    }
  }

  return { appId, identity, fields };
}

/** 対応表から「既定名 → 表示名」の変換関数を作る（知らない項目・値はそのまま）。 */
export function toDisplayTranslate(map: AppOptionNameMap): OptionValueTranslate {
  return (fieldCode, value) => map.fields.get(fieldCode)?.toDisplay.get(value) ?? value;
}

/** 対応表から「表示名 → 既定名」の変換関数を作る（知らない項目・値はそのまま）。 */
export function toCanonicalTranslate(map: AppOptionNameMap): OptionValueTranslate {
  return (fieldCode, value) => map.fields.get(fieldCode)?.toCanonical.get(value) ?? value;
}
