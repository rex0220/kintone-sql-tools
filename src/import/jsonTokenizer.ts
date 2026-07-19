import { ImportSourceError } from "./sourceLoader";

export type JsonToken =
  | { kind: "punct"; value: "{" | "}" | "[" | "]" | ":" | ","; offset: number; line: number; column: number }
  | { kind: "string"; value: string; offset: number; line: number; column: number }
  | { kind: "number"; lexeme: string; offset: number; line: number; column: number }
  | { kind: "literal"; value: true | false | null; offset: number; line: number; column: number }
  | { kind: "eof"; offset: number; line: number; column: number };

function fail(message: string, offset: number, line: number, column: number): never {
  throw new ImportSourceError(`JSON ${message} (offset=${offset}, line=${line}, column=${column}).`);
}

export function decodeUtf8Json(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportSourceError("JSON source is not valid UTF-8.");
  }
}

/** Strict JSON tokenizer. Number tokens retain their exact source lexeme. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0, line = 1, column = 1;
  const advance = (): string => {
    const ch = text[i++];
    if (ch === "\n") { line++; column = 1; } else column++;
    return ch;
  };
  const position = () => ({ offset: i, line, column });
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { advance(); continue; }
    const start = position();
    if ("{}[]:,".includes(ch)) {
      advance();
      tokens.push({ kind: "punct", value: ch as "{" | "}" | "[" | "]" | ":" | ",", ...start });
      continue;
    }
    if (ch === '"') {
      advance();
      let value = "";
      let closed = false;
      while (i < text.length) {
        const c = advance();
        if (c === '"') { closed = true; break; }
        if (c.charCodeAt(0) < 0x20) fail("string contains an unescaped control character", start.offset, start.line, start.column);
        if (c !== "\\") { value += c; continue; }
        if (i >= text.length) fail("string has an unterminated escape", start.offset, start.line, start.column);
        const esc = advance();
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (esc in simple) { value += simple[esc]; continue; }
        if (esc !== "u") fail(`has invalid escape \\${esc}`, i - 2, line, Math.max(1, column - 2));
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("has invalid unicode escape", i, line, column);
        for (let n = 0; n < 4; n++) advance();
        const code = Number.parseInt(hex, 16);
        if (code >= 0xd800 && code <= 0xdbff) {
          if (text.slice(i, i + 2) !== "\\u" || !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("has an unpaired high surrogate", i, line, column);
          advance(); advance();
          const lowHex = text.slice(i, i + 4);
          for (let n = 0; n < 4; n++) advance();
          const low = Number.parseInt(lowHex, 16);
          if (low < 0xdc00 || low > 0xdfff) fail("has an invalid surrogate pair", i - 4, line, Math.max(1, column - 4));
          value += String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + low - 0xdc00);
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          fail("has an unpaired low surrogate", i - 4, line, Math.max(1, column - 4));
        } else value += String.fromCharCode(code);
      }
      if (!closed) fail("string is unterminated", start.offset, start.line, start.column);
      tokens.push({ kind: "string", value, ...start });
      continue;
    }
    const rest = text.slice(i);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    if (number) {
      for (let n = 0; n < number.length; n++) advance();
      tokens.push({ kind: "number", lexeme: number, ...start });
      continue;
    }
    const literal = /^(true|false|null)/.exec(rest)?.[0];
    if (literal) {
      for (let n = 0; n < literal.length; n++) advance();
      tokens.push({ kind: "literal", value: literal === "true" ? true : literal === "false" ? false : null, ...start });
      continue;
    }
    fail(`has an unexpected token ${JSON.stringify(ch)}`, start.offset, start.line, start.column);
  }
  tokens.push({ kind: "eof", offset: i, line, column });
  return tokens;
}
