import {
  KSQL_FUNCTION_CATALOG,
} from "./docsResources";
import {
  STATEMENT_SYNTAX_CATALOG,
  STATEMENT_SYNTAX_CHECKS,
  STATEMENT_SYNTAX_CONTROL,
} from "./statementSyntaxCatalog";

/**
 * B81: MCP instructions の語数予算。
 *
 * 総語数だけを見ると、抑えたいもの（散文の冗長さ）と抑えてはいけないもの
 * （カタログ列挙の規模）が同じ枠を奪い合う。カタログは空白区切りで数えるため
 * 関数を1つ足すと1語増え、機能追加に比例して必ず増える。しかもカタログ列挙は
 * 「一覧は完全で IFNULL のような他方言の関数は存在しない」と明示して捏造を防ぐ、
 * instructions の中で最も効いている部分である。
 *
 * そこで予算を分けて計上する。散文は厳しく抑え、カタログは別枠にし、
 * 総量にも上限を残して青天井を防ぐ。
 */
export interface InstructionsWordBudget {
  /** instructions 全体の語数 */
  readonly total: number;
  /** カタログ由来（機能追加に比例して増える）語数 */
  readonly catalog: number;
  /** 手書きの説明文の語数。抑制対象はこちら。 */
  readonly prose: number;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** カタログ「データ」が寄与する語数。文面ではなく元データから数える。 */
export function countCatalogWords(): number {
  const functionWords = Object.values(KSQL_FUNCTION_CATALOG)
    .reduce((sum, list) => sum + countWords([...list].join(" ")), 0);
  const templateWords = Object.values(STATEMENT_SYNTAX_CATALOG)
    .reduce((sum, entry) => sum + countWords(entry.template), 0);
  return (
    functionWords
    + templateWords
    + countWords(STATEMENT_SYNTAX_CHECKS)
    + countWords(STATEMENT_SYNTAX_CONTROL)
  );
}

export function measureInstructionsWordBudget(
  instructions: string
): InstructionsWordBudget {
  const total = countWords(instructions);
  const catalog = countCatalogWords();
  return { total, catalog, prose: total - catalog };
}
