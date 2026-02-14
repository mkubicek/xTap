// xTap — Tweet parser
// Extracts and normalizes tweets from X/Twitter GraphQL API responses.

/**
 * Main entry point. Given an endpoint name and the raw GraphQL response data,
 * returns an array of normalized tweet objects.
 */
export function extractTweets(endpoint, data) {
  if (!data) return [];

  const instructions = findInstructions(endpoint, data);
  if (!instructions || !Array.isArray(instructions)) {
    // Log top-level keys so we can find where instructions moved
    const topKeys = data?.data ? Object.keys(data.data) : Object.keys(data || {});
    console.warn(`[xTap:parser] No instructions found for ${endpoint} | top-level keys: [${topKeys.join(', ')}]`);
    return [];
  }

  const tweets = [];
  let skippedEntries = 0;
  const skippedTypes = {};

  for (const instruction of instructions) {
    const entries = instruction.entries || instruction.moduleItems || [];

    for (const entry of entries) {
      const extracted = extractTweetsFromEntry(entry, skippedTypes);
      tweets.push(...extracted);
      if (extracted.length === 0 && !entry.content?.cursorType && !entry.content?.entryType?.includes('Cursor')) {
        skippedEntries++;
      }
    }

    if (instruction.entry) {
      tweets.push(...extractTweetsFromEntry(instruction.entry, skippedTypes));
    }
  }

  if (skippedEntries > 0 || Object.keys(skippedTypes).length > 0) {
    console.log(`[xTap:parser] ${endpoint}: ${tweets.length} tweets extracted, ${skippedEntries} entries skipped | skipped types: ${JSON.stringify(skippedTypes)}`);
  }

  return tweets;
}

// --- Known instruction paths per endpoint ---
const INSTRUCTION_PATHS = {
  HomeTimeline: ['data', 'home', 'home_timeline_urt', 'instructions'],
  HomeLatestTimeline: ['data', 'home', 'home_timeline_urt', 'instructions'],
  UserTweets: ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'],
  UserTweetsAndReplies: ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'],
  UserMedia: ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'],
  UserLikes: ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'],
  TweetDetail: ['data', 'threaded_conversation_with_injections_v2', 'instructions'],
  SearchTimeline: ['data', 'search_by_raw_query', 'search_timeline', 'timeline', 'instructions'],
  ListLatestTweetsTimeline: ['data', 'list', 'tweets_timeline', 'timeline', 'instructions'],
  Bookmarks: ['data', 'bookmark_timeline_v2', 'timeline', 'instructions'],
  Likes: ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'],
  CommunityTweetsTimeline: ['data', 'communityResults', 'result', 'ranked_community_timeline', 'timeline', 'instructions'],
};

/**
 * Navigate to the instructions[] array. Different endpoints nest it at different paths.
 */
function findInstructions(endpoint, data) {
  const path = INSTRUCTION_PATHS[endpoint];
  if (path) {
    const result = navigatePath(data, path);
    if (result) return result;
    // Known endpoint but path failed — log where it broke and what's there instead
    let current = data;
    for (let i = 0; i < path.length; i++) {
      if (current == null || typeof current !== 'object') {
        const parent = navigatePath(data, path.slice(0, i));
        console.warn(`[xTap:parser] Path broke for ${endpoint} at step ${i} ("${path[i]}") | value is: ${typeof current} | parent keys: [${Object.keys(parent || {}).join(', ')}]`);
        break;
      }
      if (current[path[i]] === undefined) {
        console.warn(`[xTap:parser] Path broke for ${endpoint} at step ${i} ("${path[i]}") | key not found | available keys: [${Object.keys(current).join(', ')}]`);
        break;
      }
      current = current[path[i]];
    }
  } else {
    console.log(`[xTap:parser] Unknown endpoint "${endpoint}", using recursive fallback`);
  }

  // Generic fallback: recursively search for an instructions array
  const fallback = findInstructionsRecursive(data, 5);
  if (fallback) {
    console.log(`[xTap:parser] Recursive fallback found instructions for ${endpoint}`);
  }
  return fallback;
}

function navigatePath(obj, path) {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function findInstructionsRecursive(obj, maxDepth) {
  if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return null;

  if (Array.isArray(obj.instructions)) {
    const hasEntries = obj.instructions.some(i =>
      i.type === 'TimelineAddEntries' || i.entries || i.type === 'TimelineAddToModule'
    );
    if (hasEntries) return obj.instructions;
  }

  for (const key of Object.keys(obj)) {
    if (key === 'instructions') continue;
    const result = findInstructionsRecursive(obj[key], maxDepth - 1);
    if (result) return result;
  }

  return null;
}

/**
 * Extract tweets from a single timeline entry.
 */
function extractTweetsFromEntry(entry, skippedTypes) {
  const tweets = [];
  const content = entry.content || entry;

  // Cursor entries — skip silently
  if (content.entryType === 'TimelineTimelineCursor' || content.cursorType) {
    return tweets;
  }

  // Single tweet item
  if (content.entryType === 'TimelineTimelineItem' || content.__typename === 'TimelineTimelineItem') {
    const tweet = extractFromItemContent(content.itemContent);
    if (tweet) tweets.push(tweet);
    return tweets;
  }

  // Thread / conversation module
  if (content.entryType === 'TimelineTimelineModule' || content.__typename === 'TimelineTimelineModule') {
    const items = content.items || [];
    for (const item of items) {
      const itemContent = item.item?.itemContent || item.itemContent;
      const tweet = extractFromItemContent(itemContent);
      if (tweet) tweets.push(tweet);
    }
    return tweets;
  }

  // Fallback: try itemContent directly
  if (content.itemContent) {
    const tweet = extractFromItemContent(content.itemContent);
    if (tweet) tweets.push(tweet);
    return tweets;
  }

  // Unknown entry type — log it so we can add support
  const entryType = content.entryType || content.__typename || 'no_type';
  skippedTypes[entryType] = (skippedTypes[entryType] || 0) + 1;
  if (!skippedTypes['_logged_' + entryType]) {
    skippedTypes['_logged_' + entryType] = true;
    console.warn(`[xTap:parser] Unknown entry type: "${entryType}" | keys: [${Object.keys(content).join(', ')}]`);
  }

  return tweets;
}

function extractFromItemContent(itemContent) {
  if (!itemContent) return null;

  // Track non-tweet item types we encounter
  if (itemContent.itemType !== 'TimelineTweet' && itemContent.__typename !== 'TimelineTweet') {
    const itemType = itemContent.itemType || itemContent.__typename || 'unknown';
    if (!extractFromItemContent._seenTypes) extractFromItemContent._seenTypes = new Set();
    if (!extractFromItemContent._seenTypes.has(itemType)) {
      extractFromItemContent._seenTypes.add(itemType);
      console.log(`[xTap:parser] Skipping non-tweet itemType: "${itemType}"`);
    }
    return null;
  }

  const tweetResults = itemContent.tweet_results;
  if (!tweetResults?.result) {
    console.warn('[xTap:parser] TimelineTweet has no tweet_results.result | keys:', Object.keys(itemContent).join(', '));
    return null;
  }

  const raw = unwrapTweetResult(tweetResults.result);
  if (!raw) return null;

  return normalizeTweet(raw);
}

/**
 * Unwrap tweet result — handles Tweet, TweetWithVisibilityResults, tombstones.
 */
function unwrapTweetResult(result) {
  if (!result) return null;

  const typename = result.__typename;

  if (typename === 'Tweet') return result;

  if (typename === 'TweetWithVisibilityResults') {
    const tweet = result.tweet;
    if (!tweet) return null;
    tweet._visibilityResults = result.tweetInterstitial || result.visibility_results || null;
    return tweet;
  }

  // Tombstones, unavailable tweets — skip silently
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
    return null;
  }

  // Unknown type but has legacy data — try anyway
  if (result.legacy && result.core) {
    console.warn(`[xTap:parser] Unknown tweet __typename "${typename}", attempting extraction (has legacy+core)`);
    return result;
  }

  console.warn(`[xTap:parser] Unhandled tweet result __typename: "${typename}" | keys: [${Object.keys(result).join(', ')}]`);
  return null;
}

/**
 * Normalize a raw tweet into our output schema.
 */
function normalizeTweet(raw) {
  const legacy = raw.legacy;
  if (!legacy) {
    console.warn('[xTap:parser] Tweet missing legacy | keys:', Object.keys(raw).join(', '));
    return null;
  }

  const userResult = raw.core?.user_results?.result;
  const userCore = userResult?.core;      // X nests name/screen_name here
  const userLegacy = userResult?.legacy;  // follower_count, verified, etc.

  // Warn if user data paths have changed
  if (!userResult) {
    console.warn(`[xTap:parser] No user data at raw.core.user_results.result | raw.core keys: [${Object.keys(raw.core || {}).join(', ')}]`);
  } else if (!userCore?.screen_name && !userLegacy?.screen_name) {
    console.warn(`[xTap:parser] No screen_name found | userResult keys: [${Object.keys(userResult).join(', ')}] | userResult.core keys: [${Object.keys(userCore || {}).join(', ')}] | userResult.legacy keys: [${Object.keys(userLegacy || {}).join(', ')}]`);
  }

  const text = extractFullText(raw);
  const media = extractMedia(legacy);
  const urls = extractUrls(legacy);

  const tweet = {
    id: legacy.id_str || raw.rest_id,
    created_at: legacy.created_at,
    author: {
      id: userResult?.rest_id || legacy.user_id_str,
      username: userCore?.screen_name || userLegacy?.screen_name,
      display_name: userCore?.name || userLegacy?.name,
      verified: userLegacy?.verified || false,
      is_blue_verified: userResult?.is_blue_verified || false,
      follower_count: userLegacy?.followers_count
    },
    text,
    lang: legacy.lang,
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      views: parseInt(raw.views?.count, 10) || null,
      bookmarks: legacy.bookmark_count || 0,
      quotes: legacy.quote_count || 0
    },
    media,
    urls,
    hashtags: (legacy.entities?.hashtags || []).map(h => h.text),
    mentions: (legacy.entities?.user_mentions || []).map(m => ({
      id: m.id_str,
      username: m.screen_name
    })),
    in_reply_to: legacy.in_reply_to_status_id_str || null,
    quoted_tweet_id: legacy.quoted_status_id_str || null,
    conversation_id: legacy.conversation_id_str || null,
    is_retweet: !!legacy.retweeted_status_result,
    retweeted_tweet_id: legacy.retweeted_status_result?.result?.legacy?.id_str || null,
    is_subscriber_only: !!(raw.exclusive_tweet_control || raw.exclusiveTweetControl),
    source_endpoint: null, // Set by caller
    captured_at: new Date().toISOString()
  };

  // Clean up temporary property from unwrapTweetResult
  delete raw._visibilityResults;

  // If this is a retweet, also normalize the retweeted tweet
  // (the text of a retweet is often truncated with "RT @user:")
  if (legacy.retweeted_status_result?.result) {
    const rtRaw = unwrapTweetResult(legacy.retweeted_status_result.result);
    if (rtRaw) {
      tweet.text = extractFullText(rtRaw);
    }
  }

  return tweet;
}

/**
 * Extract full text, preferring note_tweet (long-form) over legacy.full_text.
 */
function extractFullText(raw) {
  const noteText = raw.note_tweet?.note_tweet_results?.result?.text;
  if (noteText) return noteText;
  return raw.legacy?.full_text || '';
}

/**
 * Extract media from extended_entities.
 */
function extractMedia(legacy) {
  const mediaList = legacy.extended_entities?.media || legacy.entities?.media || [];
  return mediaList.map(m => {
    const item = {
      type: m.type, // photo, video, animated_gif
      url: null,
      alt_text: m.ext_alt_text || null
    };

    if (m.type === 'photo') {
      item.url = m.media_url_https ? m.media_url_https + ':orig' : m.media_url_https;
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = m.video_info?.variants || [];
      const mp4s = variants
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      item.url = mp4s[0]?.url || null;
      if (m.type === 'video') {
        item.duration_ms = m.video_info?.duration_millis || null;
      }
    } else {
      console.warn(`[xTap:parser] Unknown media type: "${m.type}" | keys: [${Object.keys(m).join(', ')}]`);
    }

    return item;
  });
}

/**
 * Extract URLs from entities.
 */
function extractUrls(legacy) {
  const urlList = legacy.entities?.urls || [];
  return urlList.map(u => ({
    display: u.display_url,
    expanded: u.expanded_url,
    shortened: u.url
  }));
}
