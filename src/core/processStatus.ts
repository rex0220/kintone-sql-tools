export interface ProcessStatusState {
  readonly name: string;
  readonly index: number;
}

export interface RawProcessStatusState {
  readonly name: string;
  readonly index: string | number;
}

/** status.json の文字列 index を有限非負整数へ正規化し、states=null は保持する。 */
export function normalizeProcessStatusStates(
  states: Readonly<Record<string, RawProcessStatusState>> | null
): ProcessStatusState[] | null {
  if (states === null) return null;
  return Object.values(states).map((state) => {
    const index = Number(state.index);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error(`ArgumentError: invalid process status index: ${String(state.index)}`);
    }
    return { name: state.name, index };
  });
}
