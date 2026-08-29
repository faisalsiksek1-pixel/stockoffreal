/**
 * The AI's fixed starting allocation — shared so a "1v1 the AI" duel and the
 * seed script build the identical AI book, rather than two copies that could
 * quietly drift apart.
 *
 * Picks are [symbol, percent of starting cash], not share counts: prices move
 * daily, so a fixed share count that fit inside the starting balance today
 * would silently fail once prices moved.
 */
export const AI_PICKS: [string, number][] = [
  ["NVDA", 30],
  ["MSFT", 15],
  ["AVGO", 20],
  ["AMZN", 12],
  ["META", 10],
  ["QQQ", 12],
];

export const AI_NOTE =
  "Diversified aggressive growth: concentrated in AI infrastructure and mega-cap " +
  "technology, with an index ETF sleeve for breadth. Fixed allocation, rebalanced " +
  "only by an administrator.";
