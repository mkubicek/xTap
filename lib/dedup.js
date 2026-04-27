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
 * - When `options.imageBackfill` is set and the tweet has photo media,
 *   a duplicate is also let through once per session (tracked in
 *   `options.imageCheckedIds`) so the daemon can download images that
 *   were skipped when image-download was off at original capture time.
 *   The downloader's per-file `os.path.exists` check makes repeats cheap.
 */
export function dedupTweet(tweet, seenIds, options = {}) {
  const { imageBackfill = false, imageCheckedIds = null } = options;

  const isDup = !!(tweet.id && seenIds.has(tweet.id));
  const isArticle = !!tweet.is_article;
  const wantsImageBackfill = (
    imageBackfill &&
    !!tweet.id &&
    imageCheckedIds &&
    !imageCheckedIds.has(tweet.id) &&
    hasPhotoMedia(tweet)
  );

  if (isDup && !isArticle && !wantsImageBackfill) {
    return false;
  }

  if (tweet.id) seenIds.add(tweet.id);
  if (wantsImageBackfill) imageCheckedIds.add(tweet.id);

  return true;
}

function hasPhotoMedia(tweet) {
  const media = tweet.media;
  if (!Array.isArray(media)) return false;
  for (const m of media) {
    if (m && m.type === 'photo') return true;
  }
  return false;
}
