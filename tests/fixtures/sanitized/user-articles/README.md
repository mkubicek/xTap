# user-articles

## Scenario

Timeline capture from a `UserArticlesTweets` response where every tweet is an
article stub without full body content.

## What it covers

- Timeline instruction parsing (TimelineAddEntries)
- Single tweet items (TimelineTimelineItem)
- Conversation modules (TimelineTimelineModule)
- Article stubs skipped when full content is unavailable
- Empty parser output when no complete tweets remain

## Raw input

Generated from a real passive `UserArticlesTweets` capture placed in
`tests/fixtures/private-raw/`. The raw capture is gitignored and not
included in the repository.

## Anonymization

All content is fully anonymized, not just pseudonymized:

- 29 tweet IDs deterministically remapped
- 26 user IDs deterministically remapped
- 1 screen names / handles remapped to `user_<hash>`
- 2 display names remapped to `User <hash>`
- All tweet text and note-tweet text replaced with synthetic prose
- All user bios / descriptions replaced with synthetic prose
- All card titles, descriptions, and alt text replaced with synthetic prose
- All article titles and preview text replaced with synthetic prose
- All pbs.twimg.com and video.twimg.com URLs replaced with placeholder URLs
- All twitter.com and x.com URLs have handles and status IDs remapped
- Affiliate / business-label org names replaced with `Organization <hash>`
- Birdwatch URLs, feedback URLs, controller data, base64 IDs all redacted

Anonymization preserves graph relationships: reply-to, quote, conversation,
and author references remain internally consistent.

## Invariants

- `fixture.json` fed to `extractTweets("UserArticlesTweets", data)` must produce
  exactly 0 tweets matching `expected.jsonl`
- All `in_reply_to`, `quoted_tweet_id`, and `conversation_id` values that
  reference tweets in the fixture use the same remapped IDs
- Author IDs and handles are consistent across all tweets by the same user
- No original handles, display names, tweet IDs, or searchable prose remain
