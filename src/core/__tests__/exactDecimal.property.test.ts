import { compareDecimal } from "../exactDecimal";

const SEED = 0x0b09_2026;

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function decimalCases(): string[] {
  const next = generator(SEED);
  const result = ["0", "-0", "1", "1.0", "1e0", "9007199254740992", "9007199254740993"];
  for (let index = 0; index < 120; index++) {
    const digits = Array.from({ length: 1 + next() % 30 }, () => String(next() % 10)).join("");
    const scale = next() % 11;
    const sign = next() % 3 === 0 ? "-" : next() % 3 === 1 ? "+" : "";
    const padded = digits.padStart(scale + 1, "0");
    const plain = scale === 0 ? padded : `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
    result.push(`${sign}${plain}`, `${sign}${plain}0`, `${sign}${digits}e-${scale}`);
  }
  return result;
}

test(`exact decimal ordering properties (seed=${SEED})`, () => {
  const values = decimalCases();
  const next = generator(SEED ^ 0x5eed);
  for (let index = 0; index < 2000; index++) {
    const a = values[next() % values.length];
    const b = values[next() % values.length];
    const c = values[next() % values.length];
    const ab = compareDecimal(a, b);
    const ba = compareDecimal(b, a);
    expect(compareDecimal(a, a)).toBe(0);
    expect(ab).toBe(ba === 0 ? 0 : -ba);
    const bc = compareDecimal(b, c);
    if (ab <= 0 && bc <= 0) expect(compareDecimal(a, c)).toBeLessThanOrEqual(0);
    if (ab === 0 && bc === 0) expect(compareDecimal(a, c)).toBe(0);
  }
});
