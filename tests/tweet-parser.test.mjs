/**
 * Tests for lib/tweet-parser.js
 * Run with: node --test tests/tweet-parser.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractTweets, normalizeTweet, extractMedia, extractArticle } from '../lib/tweet-parser.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRawTweet(overrides = {}) {
  const base = {
    __typename: 'Tweet',
    rest_id: '100',
    core: {
      user_results: {
        result: {
          rest_id: 'u1',
          core: { screen_name: 'testuser', name: 'Test User' },
          legacy: { followers_count: 42, verified: false },
          is_blue_verified: true,
        },
      },
    },
    legacy: {
      id_str: '100',
      user_id_str: 'u1',
      full_text: 'Hello world',
      created_at: 'Mon Jan 15 12:00:00 +0000 2024',
      lang: 'en',
      favorite_count: 10,
      retweet_count: 5,
      reply_count: 2,
      bookmark_count: 1,
      quote_count: 0,
      entities: {
        hashtags: [{ text: 'test' }],
        user_mentions: [{ id_str: 'm1', screen_name: 'mentionuser' }],
        urls: [],
      },
      in_reply_to_status_id_str: null,
      quoted_status_id_str: null,
      conversation_id_str: '100',
    },
    views: { count: '1000' },
  };

  // Apply overrides with deep merge for nested objects
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function makeTimelineResponse(rawTweet) {
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                {
                  content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: {
                      itemType: 'TimelineTweet',
                      __typename: 'TimelineTweet',
                      tweet_results: { result: rawTweet },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeTweet
// ---------------------------------------------------------------------------

describe('normalizeTweet', () => {
  it('returns all required fields', () => {
    const raw = makeRawTweet();
    const t = normalizeTweet(raw);
    assert.ok(t);
    assert.equal(t.id, '100');
    assert.ok(t.url.includes('/testuser/status/100'));
    assert.equal(t.author.username, 'testuser');
    assert.equal(t.author.display_name, 'Test User');
    assert.equal(t.author.verified, false);
    assert.equal(t.author.is_blue_verified, true);
    assert.equal(t.author.follower_count, 42);
    assert.equal(t.text, 'Hello world');
    assert.equal(t.lang, 'en');
    assert.equal(t.metrics.likes, 10);
    assert.equal(t.metrics.retweets, 5);
    assert.equal(t.metrics.replies, 2);
    assert.equal(t.metrics.bookmarks, 1);
    assert.equal(t.metrics.quotes, 0);
    assert.equal(t.conversation_id, '100');
    assert.equal(t.is_retweet, false);
    assert.equal(t.retweeted_tweet_id, null);
    assert.ok(t.created_at);
    assert.ok(t.captured_at);
  });

  it('gets username from core.screen_name', () => {
    const raw = makeRawTweet();
    const t = normalizeTweet(raw);
    assert.equal(t.author.username, 'testuser');
  });

  it('falls back to legacy.screen_name', () => {
    const raw = makeRawTweet();
    // Wipe core.screen_name so it falls back to legacy
    raw.core.user_results.result.core = {};
    raw.core.user_results.result.legacy = { screen_name: 'legacyuser', name: 'Legacy', followers_count: 1, verified: false };
    const t = normalizeTweet(raw);
    assert.equal(t.author.username, 'legacyuser');
  });

  it('parses views count from string to int', () => {
    const raw = makeRawTweet({ views: { count: '5000' } });
    const t = normalizeTweet(raw);
    assert.equal(t.metrics.views, 5000);
  });

  it('views is null when missing', () => {
    const raw = makeRawTweet();
    delete raw.views;
    const t = normalizeTweet(raw);
    assert.equal(t.metrics.views, null);
  });

  it('returns null when legacy is missing', () => {
    const raw = makeRawTweet();
    delete raw.legacy;
    const t = normalizeTweet(raw);
    assert.equal(t, null);
  });

  it('prefers note_tweet text over legacy full_text', () => {
    const raw = makeRawTweet({
      note_tweet: {
        note_tweet_results: { result: { text: 'Long note tweet text here' } },
      },
    });
    const t = normalizeTweet(raw);
    assert.equal(t.text, 'Long note tweet text here');
  });

  it('uses retweeted tweet full text for retweets', () => {
    const raw = makeRawTweet({
      legacy: {
        id_str: '100',
        user_id_str: 'u1',
        full_text: 'RT @other: truncated...',
        created_at: 'Mon Jan 15 12:00:00 +0000 2024',
        lang: 'en',
        favorite_count: 0,
        retweet_count: 0,
        reply_count: 0,
        bookmark_count: 0,
        quote_count: 0,
        entities: { hashtags: [], user_mentions: [], urls: [] },
        conversation_id_str: '100',
        retweeted_status_result: {
          result: {
            __typename: 'Tweet',
            legacy: {
              id_str: '200',
              full_text: 'The full original retweet text',
            },
            core: {},
          },
        },
      },
    });
    const t = normalizeTweet(raw);
    assert.equal(t.text, 'The full original retweet text');
    assert.equal(t.is_retweet, true);
    assert.equal(t.retweeted_tweet_id, '200');
  });

  it('article overlay sets is_article and replaces text', () => {
    const raw = makeRawTweet({
      article: {
        article_results: {
          result: {
            title: 'My Article',
            content_state: {
              blocks: [{ text: 'Article body', type: 'unstyled' }],
              entityMap: [],
            },
            media_entities: [],
          },
        },
      },
    });
    const t = normalizeTweet(raw);
    assert.equal(t.is_article, true);
    assert.equal(t.text, 'Article body');
    assert.equal(t.article.title, 'My Article');
  });

  it('converts created_at to ISO format', () => {
    const raw = makeRawTweet();
    const t = normalizeTweet(raw);
    // Should be valid ISO string
    assert.ok(t.created_at.includes('2024'));
    assert.ok(t.created_at.includes('T'));
  });

  it('extracts hashtags from entities', () => {
    const raw = makeRawTweet();
    const t = normalizeTweet(raw);
    assert.deepStrictEqual(t.hashtags, ['test']);
  });

  it('extracts mentions from entities', () => {
    const raw = makeRawTweet();
    const t = normalizeTweet(raw);
    assert.deepStrictEqual(t.mentions, [{ id: 'm1', username: 'mentionuser' }]);
  });

  it('handles missing user_results gracefully', () => {
    const raw = makeRawTweet();
    raw.core = {};
    const t = normalizeTweet(raw);
    assert.ok(t);
    assert.equal(t.author.username, undefined);
  });

  it('handles user_results with no screen_name anywhere', () => {
    const raw = makeRawTweet();
    raw.core.user_results.result.core = {};
    raw.core.user_results.result.legacy = { followers_count: 0, verified: false };
    const t = normalizeTweet(raw);
    assert.ok(t);
    assert.equal(t.author.username, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractMedia
// ---------------------------------------------------------------------------

describe('extractMedia', () => {
  it('returns empty array when no extended_entities', () => {
    const result = extractMedia({ entities: {} });
    assert.deepStrictEqual(result, []);
  });

  it('photo gets :orig suffix', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/media/abc.jpg',
            ext_alt_text: null,
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'photo');
    assert.equal(result[0].url, 'https://pbs.twimg.com/media/abc.jpg:orig');
  });

  it('video selects highest bitrate mp4', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'video',
            ext_alt_text: null,
            video_info: {
              duration_millis: 30000,
              variants: [
                { content_type: 'video/mp4', bitrate: 832000, url: 'https://vid.com/low.mp4' },
                { content_type: 'video/mp4', bitrate: 2176000, url: 'https://vid.com/high.mp4' },
                { content_type: 'application/x-mpegURL', url: 'https://vid.com/stream.m3u8' },
              ],
            },
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result[0].url, 'https://vid.com/high.mp4');
    assert.equal(result[0].duration_ms, 30000);
  });

  it('animated_gif treated like video', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'animated_gif',
            ext_alt_text: null,
            video_info: {
              variants: [
                { content_type: 'video/mp4', bitrate: 0, url: 'https://vid.com/gif.mp4' },
              ],
            },
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result[0].type, 'animated_gif');
    assert.equal(result[0].url, 'https://vid.com/gif.mp4');
    assert.equal(result[0].duration_ms, undefined);
  });

  it('duration_ms on video, absent on photo', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'video',
            ext_alt_text: null,
            video_info: {
              duration_millis: 5000,
              variants: [{ content_type: 'video/mp4', bitrate: 100, url: 'https://v.com/v.mp4' }],
            },
          },
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/img.jpg',
            ext_alt_text: null,
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result[0].duration_ms, 5000);
    assert.equal(result[1].duration_ms, undefined);
  });

  it('preserves alt_text', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/img.jpg',
            ext_alt_text: 'A description of the image',
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result[0].alt_text, 'A description of the image');
  });

  it('falls back to entities.media', () => {
    const legacy = {
      entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/fallback.jpg',
            ext_alt_text: null,
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://pbs.twimg.com/fallback.jpg:orig');
  });
});

// ---------------------------------------------------------------------------
// extractArticle
// ---------------------------------------------------------------------------

describe('extractArticle', () => {
  it('returns null when no article field', () => {
    assert.equal(extractArticle({}), null);
  });

  it('returns null for article stub without content_state', () => {
    const raw = {
      article: {
        article_results: {
          result: { title: 'Stub only' },
        },
      },
    };
    assert.equal(extractArticle(raw), null);
  });

  it('returns null when blocks is empty', () => {
    const raw = {
      article: {
        article_results: {
          result: {
            title: 'Empty',
            content_state: { blocks: [], entityMap: [] },
          },
        },
      },
    };
    assert.equal(extractArticle(raw), null);
  });

  it('handles unstyled blocks as plain text', () => {
    const raw = makeArticleRaw([{ text: 'Hello', type: 'unstyled' }]);
    const article = extractArticle(raw);
    assert.equal(article.text, 'Hello');
  });

  it('renders header-one as # prefix', () => {
    const raw = makeArticleRaw([{ text: 'Title', type: 'header-one' }]);
    assert.equal(extractArticle(raw).text, '# Title');
  });

  it('renders header-two as ## prefix', () => {
    const raw = makeArticleRaw([{ text: 'Sub', type: 'header-two' }]);
    assert.equal(extractArticle(raw).text, '## Sub');
  });

  it('renders header-three as ### prefix', () => {
    const raw = makeArticleRaw([{ text: 'Sub2', type: 'header-three' }]);
    assert.equal(extractArticle(raw).text, '### Sub2');
  });

  it('renders ordered-list-item as 1. prefix', () => {
    const raw = makeArticleRaw([{ text: 'First', type: 'ordered-list-item' }]);
    assert.equal(extractArticle(raw).text, '1. First');
  });

  it('renders unordered-list-item as - prefix', () => {
    const raw = makeArticleRaw([{ text: 'Bullet', type: 'unordered-list-item' }]);
    assert.equal(extractArticle(raw).text, '- Bullet');
  });

  it('renders blockquote as > prefix', () => {
    const raw = makeArticleRaw([{ text: 'Quote', type: 'blockquote' }]);
    assert.equal(extractArticle(raw).text, '> Quote');
  });

  it('renders atomic block as image reference via entity-media chain', () => {
    const raw = {
      rest_id: '500',
      legacy: { id_str: '500' },
      article: {
        article_results: {
          result: {
            title: 'With Image',
            content_state: {
              blocks: [
                { text: ' ', type: 'atomic', entityRanges: [{ key: 0 }] },
              ],
              entityMap: [
                { key: '0', value: { data: { mediaItems: [{ mediaId: 'mid1' }] } } },
              ],
            },
            media_entities: [
              {
                media_id: 'mid1',
                media_info: {
                  original_img_url: 'https://pbs.twimg.com/media/photo.png',
                  original_img_width: 1200,
                  original_img_height: 800,
                },
              },
            ],
          },
        },
      },
    };
    const article = extractArticle(raw);
    assert.equal(article.text, '![photo.png](media/500/photo.png)');
    assert.equal(article.media.length, 1);
    assert.equal(article.media[0].id, 'mid1');
    assert.equal(article.media[0].url, 'https://pbs.twimg.com/media/photo.png');
    assert.equal(article.media[0].filename, 'photo.png');
    assert.equal(article.media[0].local_path, 'media/500/photo.png');
    assert.equal(article.media[0].width, 1200);
    assert.equal(article.media[0].height, 800);
  });
});

function makeArticleRaw(blocks) {
  return {
    rest_id: '500',
    legacy: { id_str: '500' },
    article: {
      article_results: {
        result: {
          title: 'Test',
          content_state: { blocks, entityMap: [] },
          media_entities: [],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// extractTweets (integration)
// ---------------------------------------------------------------------------

describe('extractTweets', () => {
  it('returns empty array for null data', () => {
    assert.deepStrictEqual(extractTweets('HomeTimeline', null), []);
  });

  it('extracts tweet from HomeTimeline response', () => {
    const raw = makeRawTweet();
    const data = makeTimelineResponse(raw);
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].id, '100');
    assert.equal(tweets[0].author.username, 'testuser');
  });

  it('TweetResultByRestId without article returns regular tweet', () => {
    const raw = makeRawTweet();
    const data = {
      data: { tweetResult: { result: raw } },
    };
    const tweets = extractTweets('TweetResultByRestId', data);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].is_article, undefined);
  });

  it('TweetResultByRestId with article returns tweet', () => {
    const raw = makeRawTweet({
      article: {
        article_results: {
          result: {
            title: 'Article',
            content_state: {
              blocks: [{ text: 'Body', type: 'unstyled' }],
              entityMap: [],
            },
            media_entities: [],
          },
        },
      },
    });
    const data = {
      data: { tweetResult: { result: raw } },
    };
    const tweets = extractTweets('TweetResultByRestId', data);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].is_article, true);
  });

  it('skips cursor entries', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: 'cursor123',
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('tombstone entries produce no tweet', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        __typename: 'TimelineTweet',
                        tweet_results: {
                          result: { __typename: 'TweetTombstone' },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('module entries (threads) yield multiple tweets', () => {
    const raw1 = makeRawTweet({ rest_id: '1', legacy: { id_str: '1', user_id_str: 'u1', full_text: 'a', created_at: 'Mon Jan 15 12:00:00 +0000 2024', lang: 'en', favorite_count: 0, retweet_count: 0, reply_count: 0, bookmark_count: 0, quote_count: 0, entities: { hashtags: [], user_mentions: [], urls: [] }, conversation_id_str: '1' } });
    const raw2 = makeRawTweet({ rest_id: '2', legacy: { id_str: '2', user_id_str: 'u1', full_text: 'b', created_at: 'Mon Jan 15 12:00:00 +0000 2024', lang: 'en', favorite_count: 0, retweet_count: 0, reply_count: 0, bookmark_count: 0, quote_count: 0, entities: { hashtags: [], user_mentions: [], urls: [] }, conversation_id_str: '1' } });
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineModule',
                      items: [
                        {
                          item: {
                            itemContent: {
                              itemType: 'TimelineTweet',
                              __typename: 'TimelineTweet',
                              tweet_results: { result: raw1 },
                            },
                          },
                        },
                        {
                          item: {
                            itemContent: {
                              itemType: 'TimelineTweet',
                              __typename: 'TimelineTweet',
                              tweet_results: { result: raw2 },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 2);
    assert.equal(tweets[0].id, '1');
    assert.equal(tweets[1].id, '2');
  });

  it('returns empty when known endpoint has wrong data structure', () => {
    // HomeTimeline with missing nested path — triggers path-broke warning
    const data = { data: { home: { home_timeline_urt: { wrong_key: true } } } };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('returns empty when known endpoint path hits non-object', () => {
    // Path traversal hits a string instead of object — triggers "value is" warning
    const data = { data: { home: 'not_an_object' } };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('unknown endpoint uses recursive fallback', () => {
    // An endpoint not in INSTRUCTION_PATHS — triggers recursive search
    const raw = makeRawTweet();
    const data = {
      data: {
        something: {
          nested: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        __typename: 'TimelineTweet',
                        tweet_results: { result: raw },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('SomeNewEndpoint', data);
    assert.equal(tweets.length, 1);
  });

  it('instruction.entry single-entry path', () => {
    const raw = makeRawTweet();
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddToModule',
                entry: {
                  content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: {
                      itemType: 'TimelineTweet',
                      __typename: 'TimelineTweet',
                      tweet_results: { result: raw },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 1);
  });

  it('entry with direct itemContent fallback', () => {
    const raw = makeRawTweet();
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      itemContent: {
                        itemType: 'TimelineTweet',
                        __typename: 'TimelineTweet',
                        tweet_results: { result: raw },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 1);
  });

  it('unknown entry type is skipped', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineUnknownType',
                      someData: true,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('non-tweet item type is skipped', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelinePromotedTweet',
                        __typename: 'TimelinePromotedTweet',
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('TimelineTweet with missing tweet_results.result', () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        __typename: 'TimelineTweet',
                        tweet_results: {},
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });

  it('TweetWithVisibilityResults unwrapped', () => {
    const innerTweet = makeRawTweet();
    const wrapped = {
      __typename: 'TweetWithVisibilityResults',
      tweet: innerTweet,
      tweetInterstitial: { text: 'some warning' },
    };
    const data = makeTimelineResponse(wrapped);
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].id, '100');
  });

  it('unknown typename with legacy+core still extracts', () => {
    const raw = makeRawTweet({ __typename: 'TweetFuture' });
    const data = makeTimelineResponse(raw);
    const tweets = extractTweets('HomeTimeline', data);
    assert.equal(tweets.length, 1);
  });

  it('unknown typename without legacy+core is skipped', () => {
    const data = makeTimelineResponse({
      __typename: 'SomethingElse',
      id: '999',
    });
    const tweets = extractTweets('HomeTimeline', data);
    assert.deepStrictEqual(tweets, []);
  });
});

// ---------------------------------------------------------------------------
// extractMedia — edge cases
// ---------------------------------------------------------------------------

describe('extractMedia edge cases', () => {
  it('unknown media type triggers warning', () => {
    const legacy = {
      extended_entities: {
        media: [
          {
            type: 'unknown_type',
            ext_alt_text: null,
          },
        ],
      },
    };
    const result = extractMedia(legacy);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'unknown_type');
    assert.equal(result[0].url, null);
  });
});

// ---------------------------------------------------------------------------
// extractTweets — extractUrls coverage (via normalizeTweet)
// ---------------------------------------------------------------------------

describe('normalizeTweet URLs', () => {
  it('extracts URLs from entities', () => {
    const raw = makeRawTweet({
      legacy: {
        id_str: '100',
        user_id_str: 'u1',
        full_text: 'Check this out https://t.co/abc',
        created_at: 'Mon Jan 15 12:00:00 +0000 2024',
        lang: 'en',
        favorite_count: 0,
        retweet_count: 0,
        reply_count: 0,
        bookmark_count: 0,
        quote_count: 0,
        entities: {
          hashtags: [],
          user_mentions: [],
          urls: [
            {
              display_url: 'example.com',
              expanded_url: 'https://example.com',
              url: 'https://t.co/abc',
            },
          ],
        },
        conversation_id_str: '100',
      },
    });
    const t = normalizeTweet(raw);
    assert.equal(t.urls.length, 1);
    assert.equal(t.urls[0].display, 'example.com');
    assert.equal(t.urls[0].expanded, 'https://example.com');
    assert.equal(t.urls[0].shortened, 'https://t.co/abc');
  });
});
