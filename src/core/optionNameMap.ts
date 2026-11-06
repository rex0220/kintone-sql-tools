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
  /**
   * プロセス管理のステータスの対応（`fields` にも項目コードで入っているが、
   * **順序表の正本を切り替える**ときは項目コードを知らずに引きたいので別に持つ）。
   * プロセス管理が無効なアプリでは `undefined`。
   */
  readonly status?: FieldOptionNames;
  /**
   * ステータスの順序表（**既定名** → 画面の並び）。`status` と**同じ 1 枚のスナップショット**から作る。
   *
   * 2 回目の実装レビューの MAJOR: `getProcessStatuses`（同じ endpoint の**別の取得**）と
   * 突き合わせていたので、取得の間に設定が変わると正しい応答同士で落ちた。
   * 正本をこの 1 枚に決めて、突き合わせをやめた。
   */
  readonly statusOrder?: ReadonlyMap<string, number>;
}

/** 表示名の取得で使う生のメタデータ（クライアントが返す形）。 */
export interface OptionNameSource {
  readonly appId: number;
  /** `form/fields`（`lang: "user"`）を平坦化したもの */
  readonly fields: readonly KintoneFieldInfo[];
  /**
   * プロセス管理が有効か（`app/status.json` の `enable`）。
   *
   * **`form/fields` の `STATUS` 項目はプロセス管理が無効でも返る**（`enabled: false`。
   * 2026-11-06 にアプリ 4392 で確認＝`enable: false` / `states: null` でも項目は返る）。
   * `flattenFormFieldProperties` は `enabled` を落とすので、**項目の有無で判定してはいけない**。
   * ステータスの対応表が要るかどうかは必ずこの値で決める（2 回目の実装レビューの BLOCKER）。
   */
  readonly processEnabled: boolean;
  /** `app/status.json`（`lang: "user"`）。キー（既定名）と `name`（表示名）の対。プロセス管理が無ければ null */
  readonly statusStates: readonly OptionNamePair[] | null;
}

/** `app/status.json`（`lang: "user"`）の生の形。**キーが既定名・`name` が表示名**。 */
export interface RawLocalizedStatusStates {
  /** プロセス管理が有効か。無効なら `states` は見ない */
  readonly enable?: unknown;
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
  // プロセス管理が無効なら状態は見ない（無効でも `states` を返す面があるため）
  const processEnabled = status?.enable === true;
  const rawStates = processEnabled ? status?.states ?? null : null;
  const statusStates = rawStates === null
    ? null
    : Object.entries(rawStates).map(([canonical, state]) => {
        const index = Number(state?.index);
        if (!Number.isSafeInteger(index) || index < 0) {
          throw new OptionNameMapError(
            `process status "${canonical}" has an invalid index (${String(state?.index)}).`
          );
        }
        // 表示名が無い・文字列でないときに既定名で埋めない（実装レビューの MAJOR）。
        // `app/status.json` は lang を付ければ必ず name を返す（言語ごとの名称が未設定でも
        // 設定済みの別の言語名か既定名が入る）。空や非文字列は「嘘のメタデータ」なので、
        // 既定名で埋めて**空の表示名を拒む検査を迂回させない**。
        if (typeof state?.name !== "string" || state.name === "") {
          throw new OptionNameMapError(
            `process status "${canonical}" has no usable localized name (${String(state?.name)}).`
          );
        }
        return { canonical, display: state.name, index };
      });
  return { appId, fields: userFields, processEnabled, statusStates };
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
  const indexes = new Set<number>();
  for (const { canonical, index } of pairs) {
    // `index` の検査（実装レビューの MAJOR）。選択肢は `namesByIndex` で**位置で対にする**ため
    // 0 から連番であることまで要るが、ステータスは**キーが既定名**なので対にするのに index は要らない
    // （並べ替えにだけ使う）。そこで共通の契約は「非負の整数で重複しない」までとし、連番性は
    // 選択肢の側（`namesByIndex`）だけで求める。嘘のメタデータで並びが決まらない形は止める。
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new OptionNameMapError(
        `field ${fieldCode}: option "${canonical}" has an invalid index (${String(index)}).`
      );
    }
    if (indexes.has(index)) {
      throw new OptionNameMapError(`field ${fieldCode}: duplicate option index ${index}.`);
    }
    indexes.add(index);
  }
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
  // 項目コードの重複を黙って後勝ちにしない（実装レビューの MAJOR）。
  const displayByCode = new Map<string, KintoneFieldInfo>();
  for (const field of source.fields) {
    if (displayByCode.has(field.code)) {
      throw new OptionNameMapError(
        `field ${field.code}: the user-language form describes this field more than once; `
        + "the mapping would depend on which one wins."
      );
    }
    displayByCode.set(field.code, field);
  }
  const fields = new Map<string, FieldOptionNames>();
  let status: FieldOptionNames | undefined;
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
    // 同じコードで型が違う＝別のアプリか嘘のメタデータ。値の意味が変わるので止める。
    if (display.fieldType !== field.fieldType) {
      throw new OptionNameMapError(
        `field ${field.code}: the user-language form reports type ${display.fieldType} but `
        + `getFields reports ${field.fieldType}; the client must describe the same app.`
      );
    }
    const pairs = pairsFromOrders(field.code, field.optionOrder, display.optionOrder);
    if (pairs.some((pair) => pair.canonical !== pair.display)) identity = false;
    fields.set(field.code, fieldOptionNamesFrom(field.code, pairs));
  }

  // **プロセス管理が有効かは `app/status.json` の `enable` で決める**（`form/fields` の STATUS 項目は
  // 無効でも返るため。`OptionNameSource.processEnabled` の説明＝2 回目のレビューの BLOCKER）。
  // 有効なのに対応が無ければ「ステータスだけ表示名のまま」になるので止める。
  const statusField = canonicalFields.find((field) => field.fieldType === STATUS_FIELD_TYPE);
  let statusOrder: ReadonlyMap<string, number> | undefined;
  if (source.processEnabled && statusField !== undefined) {
    if (source.statusStates === null || source.statusStates.length === 0) {
      throw new OptionNameMapError(
        `field ${statusField.code}: the app has process management enabled but the client returned `
        + "no localized status names."
      );
    }
    const pairs = [...source.statusStates].sort((a, b) => a.index - b.index);
    if (pairs.some((pair) => pair.canonical !== pair.display)) identity = false;
    status = fieldOptionNamesFrom(statusField.code, pairs);
    fields.set(statusField.code, status);
    // 順序表も**この 1 枚から**作る（既定名 → 並び）。別の取得と突き合わせない。
    statusOrder = new Map(pairs.map((pair) => [pair.canonical, pair.index]));
  }

  return {
    appId, identity, fields,
    ...(status === undefined ? {} : { status }),
    ...(statusOrder === undefined ? {} : { statusOrder }),
  };
}

/** 対応表から「既定名 → 表示名」の変換関数を作る（知らない項目・値はそのまま）。 */
export function toDisplayTranslate(map: AppOptionNameMap): OptionValueTranslate {
  return (fieldCode, value) => map.fields.get(fieldCode)?.toDisplay.get(value) ?? value;
}

/** 対応表から「表示名 → 既定名」の変換関数を作る（知らない項目・値はそのまま）。 */
export function toCanonicalTranslate(map: AppOptionNameMap): OptionValueTranslate {
  return (fieldCode, value) => map.fields.get(fieldCode)?.toCanonical.get(value) ?? value;
}
