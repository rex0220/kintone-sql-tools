export const SEARCH_ABORTED_HEADER_VALUE =
  "Filter aborted because of too many search results";

export function isSearchAbortedWarning(value: string | null | undefined): boolean {
  return value?.includes(SEARCH_ABORTED_HEADER_VALUE) === true;
}
