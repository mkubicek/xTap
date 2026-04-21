# user-articles

## Scenario

Basic timeline capture from a `UserArticlesTweets` response exercising the core
xTap tweet parsing pipeline.

## What it covers

- Timeline instruction parsing (TimelineAddEntries)
- Single tweet items (TimelineTimelineItem)
- Conversation modules (TimelineTimelineModule)
- Tweet normalization (author, text, metrics, media, URLs, mentions)
- Reply chains, quote tweets, retweets
- Note tweets (long-form posts)
- Article stubs
- Card embeds
- Cursor entries (skipped by parser)

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
  exactly 12 tweets matching `expected.jsonl`
- All `in_reply_to`, `quoted_tweet_id`, and `conversation_id` values that
  reference tweets in the fixture use the same remapped IDs
- Author IDs and handles are consistent across all tweets by the same user
- No original handles, display names, tweet IDs, or searchable prose remain
