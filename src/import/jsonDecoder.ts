import { ImportSourceError } from "./sourceLoader";
import { decodeUtf8Json, tokenizeJson, type JsonToken } from "./jsonTokenizer";

export interface JsonNumberValue { readonly kind: "number"; readonly lexeme: string }
export type DecodedJsonValue = string | boolean | null | JsonNumberValue | DecodedJsonValue[] | DecodedJsonObject;
export type DecodedJsonObject = Map<string, DecodedJsonValue>;

function describe(token: JsonToken): string {
  return token.kind === "eof" ? "end of input" : token.kind === "punct" ? token.value : token.kind;
}

export function decodeJsonRecords(bytes: Uint8Array): DecodedJsonObject[] {
  if (bytes.byteLength === 0) throw new ImportSourceError("JSON source is empty.");
  const tokens = tokenizeJson(decodeUtf8Json(bytes));
  let index = 0;
  const fail = (message: string, token = tokens[index]): never => {
    throw new ImportSourceError(`JSON ${message} (offset=${token.offset}, line=${token.line}, column=${token.column}).`);
  };
  const isPunct = (token: JsonToken, value: string): boolean => token.kind === "punct" && token.value === value;
  const punct = (value: string): void => {
    const token = tokens[index];
    if (token.kind !== "punct" || token.value !== value) fail(`expected ${value}; found ${describe(token)}`, token);
    index++;
  };
  const parseValue = (): DecodedJsonValue => {
    const token = tokens[index++];
    if (token.kind === "string") return token.value;
    if (token.kind === "number") return { kind: "number", lexeme: token.lexeme };
    if (token.kind === "literal") return token.value;
    if (token.kind === "punct" && token.value === "{") {
      const object: DecodedJsonObject = new Map();
      if (isPunct(tokens[index], "}")) { index++; return object; }
      while (true) {
        const key = tokens[index++];
        if (key.kind !== "string") return fail(`object key must be a string; found ${describe(key)}`, key);
        const keyValue = key.value;
        if (object.has(keyValue)) fail(`duplicate key ${JSON.stringify(keyValue)}`, key);
        punct(":");
        object.set(keyValue, parseValue());
        const separator = tokens[index];
        if (isPunct(separator, "}")) { index++; break; }
        punct(",");
      }
      return object;
    }
    if (token.kind === "punct" && token.value === "[") {
      const array: DecodedJsonValue[] = [];
      if (isPunct(tokens[index], "]")) { index++; return array; }
      while (true) {
        array.push(parseValue());
        const separator = tokens[index];
        if (isPunct(separator, "]")) { index++; break; }
        punct(",");
      }
      return array;
    }
    return fail(`expected a value; found ${describe(token)}`, token);
  };
  const root = parseValue();
  if (tokens[index].kind !== "eof") fail(`has trailing data; found ${describe(tokens[index])}`);
  const records = root instanceof Map ? [root] : Array.isArray(root) ? root : fail("root must be an object or array.", tokens[0]);
  if (records.length === 0) throw new ImportSourceError("JSON source contains no records.");
  records.forEach((record, i) => { if (!(record instanceof Map)) throw new ImportSourceError(`JSON record ${i + 1} must be an object.`); });
  return records as DecodedJsonObject[];
}
