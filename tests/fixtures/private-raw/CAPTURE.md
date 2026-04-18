# Raw Capture Acquisition — `timeline-basic`

## What to capture

A single **HomeTimeline** or **HomeLatestTimeline** GraphQL response from a
normal X/Twitter browsing session.

## How to capture

1. Open Chrome DevTools → Network tab
2. Browse your X home timeline (scroll enough to populate ~10-30 tweets)
3. Filter network requests by `graphql`
4. Find a request to `HomeTimeline` or `HomeLatestTimeline`
5. Right-click the request → **Copy** → **Copy response**
6. Save the JSON to this directory as `timeline-basic.json`

Wrap the raw response in an envelope so the sanitizer knows the endpoint:

```json
{
  "endpoint": "HomeTimeline",
  "data": <paste the copied response here>
}
```

## Minimum qualities

- At least 5 tweets (10+ preferred)
- At least one retweet (`retweeted_status_result` present)
- At least one reply (`in_reply_to_status_id_str` non-null)
- At least one tweet with media (photo or video)
- At least one tweet with a URL entity
- Ideally a quote tweet (`quoted_status_id_str` non-null)

Richer captures make better test fixtures. A single scroll through a busy
timeline usually covers all of these.

## Where to place it

```
tests/fixtures/private-raw/timeline-basic.json
```

## Important

- This directory is **gitignored** — raw captures must never be committed
- The sanitization tool (`tests/fixtures/tools/sanitize.mjs`) will read from
  here, anonymize all identifying data, and write the sanitized fixture pack
- Only sanitized fixture packs go into version control
