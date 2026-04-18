# Fixture Pack Conventions

## Directory layout

```
tests/fixtures/
  private-raw/           ← gitignored, local-only raw captures
  sanitized/             ← committed, anonymized fixture packs
    <scenario>/
      manifest.json      ← scenario metadata
      fixture.json       ← sanitized GraphQL response
      expected.jsonl     ← golden parser output (one tweet per line)
      README.md          ← scenario description
  tools/
    sanitize.mjs         ← raw → sanitized anonymization tool
```

## Fixture pack contents

### manifest.json

```json
{
  "scenario": "timeline-basic",
  "endpoint": "HomeTimeline",
  "description": "...",
  "files": {
    "fixture": "fixture.json",
    "expected": "expected.jsonl"
  },
  "notes": "..."
}
```

### fixture.json

The sanitized GraphQL response, ready to be fed to `extractTweets(endpoint, data)`.
Contains the `data` field from the raw response (the GraphQL payload, not the envelope).

### expected.jsonl

One normalized tweet object per line, in the order `extractTweets` returns them.
This is the golden output — tests compare parser output against this file.

## Anonymization rules

The sanitization tool replaces **all prose and identifiers**, not just handles.

| Category | Transformation |
|----------|---------------|
| Tweet IDs | Deterministic hash remap (19-digit decimal) |
| User IDs | Deterministic hash remap (12-digit decimal) |
| Screen names | `user_<hash>` |
| Display names | `User <hash>` |
| Tweet text (`full_text`, note_tweet `text`) | Replaced with deterministic synthetic prose |
| User bios / descriptions | Replaced with synthetic prose |
| Card titles, descriptions, alt text | Replaced with synthetic prose |
| Article titles, preview_text | Replaced with synthetic prose |
| Affiliate / business-label org names | `Organization <hash>` |
| Cashtag company names | `Company <hash>` |
| All pbs.twimg.com / video.twimg.com URLs | `*/sanitized/<hash>.*` |
| t.co URLs | `https://t.co/SAN_<hash>` |
| Expanded URLs | `https://example.com/sanitized/<hash>` |
| twitter.com / x.com handle URLs | Handles remapped in-place |
| Birdwatch destination URLs | Redacted |
| Feedback action URLs, prompts | Redacted |
| controllerData, action_metadata | Redacted |
| Base64 node IDs | `SANITIZED_<hash>` |

Transformations are **deterministic** — the same raw input always produces the
same sanitized output. This preserves internal consistency: reply chains, quote
references, conversation threads, and author linkage all remain valid.

Fields preserved as-is: metrics, timestamps, hashtag **text** (not user PII),
language codes, cursor values, structural type annotations, entity indices,
media dimensions, platform `source` attribution.

## Adding a new fixture pack

1. Capture a raw response and place it in `private-raw/`
2. Run: `node tests/fixtures/tools/sanitize.mjs private-raw/<file>.json <scenario>`
3. Review the sanitized output for any remaining PII
4. Commit the sanitized pack under `sanitized/<scenario>/`
