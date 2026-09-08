/** Shared ~4-chars/token estimate used across the memory pipeline for soft token budgets -
 * not exact tokenization, just good enough to keep injected context bounded. */
const CHARS_PER_TOKEN = 4;

export function tokenBudgetToChars(tokenBudget: number): number {
  return tokenBudget * CHARS_PER_TOKEN;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudgetToChars(tokenBudget);
  return text.length <= charBudget ? text : text.slice(0, charBudget);
}
