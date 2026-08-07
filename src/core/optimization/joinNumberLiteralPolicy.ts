import type { NumberLiteral } from "../../types/ast";
import { numberLiteralText } from "../../types/ast";
import { formatPlainDecimal, parseExactDecimal } from "../exactDecimal";

/**
 * B151 Phase 1 の JOIN NUMBER prefilter に使用できる有限10進 literal。
 * 巨大な指数は plain decimal へ展開する前に桁数で拒否する。
 */
export function isJoinNumberLiteralSupported(literal: NumberLiteral): boolean {
  const source = literal.raw ?? String(literal.value);
  const decimal = parseExactDecimal(source);
  if (decimal === null) return false;
  if (decimal.sign === 0) return numberLiteralText(literal) === "0";

  const fractionDigits = Math.max(decimal.scale, 0);
  const integerDigits = Math.max(decimal.coefficient.length - decimal.scale, 0);
  if (
    fractionDigits > 10
    || integerDigits + fractionDigits > 30
  ) {
    return false;
  }

  const canonical = formatPlainDecimal(decimal);
  return numberLiteralText(literal) === canonical;
}

