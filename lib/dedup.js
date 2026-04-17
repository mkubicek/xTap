/**
 * Tweet deduplication logic.
 *
 * Extracted so both background.js and tests can use the same code path.
 */

/**
 * Check whether a tweet is new and track it in seenIds.
 *
 * Returns true  → tweet is new, should be enqueued.
 * Returns false → tweet is a duplicate, should be skipped.
 *
 * - Tweets without an id are always new (and not tracked).
 * - Article tweets bypass dedup — they enrich a previously captured stub.
 */
export function dedupTweet(tweet, seenIds) {
  if (tweet.id && seenIds.has(tweet.id) && !tweet.is_article) {
    return false;
  }
  if (tweet.id) seenIds.add(tweet.id);
  return true;
}
