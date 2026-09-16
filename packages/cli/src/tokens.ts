/**
 * Token substitution: a fixed string-replace table, not a template engine --
 * the CLI has zero runtime dependencies it can avoid, and a `__TOKEN__`
 * literal replace is all `templates/core` needs.
 */
export type TokenTable = Record<string, string>;

/**
 * Replaces every `__KEY__` occurrence in `content` with `tokens[KEY]`, for
 * every key in `tokens`. Unmatched `__KEY__`-shaped text that isn't a known
 * token is left untouched.
 */
export function applyTokens(content: string, tokens: TokenTable): string {
  let result = content;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.split(`__${key}__`).join(value);
  }
  return result;
}
