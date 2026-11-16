// List prices in US dollars per million tokens (input, output), for cost estimates and the cost record.
const PRICE = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

/** The cost of one model call, or 0 for a model without a listed price. */
export function costOf(model, inputTokens, outputTokens) {
  const [input, output] = PRICE[model] ?? [0, 0];
  return (inputTokens * input + outputTokens * output) / 1e6;
}
