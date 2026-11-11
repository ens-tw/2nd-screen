# Source Acquisition Queue

Track per-citation fetch progress for entries in `../references.bib`. This is the *queue* (what's still to do, why blocked, which Wayback snapshot was used). What is *currently local* lives in `README.md` (Active Source Retention).

When using the `robust-web-fetch` skill (if available in your agent), the four tiers escalate: curl-cffi → Wayback → Chromium print → camoufox. Record which tier succeeded in Notes, so a future re-fetch can skip dead ends.

## Status

- `queued`: not yet attempted.
- `in-progress`: currently fetching (write today's date into `Last attempt`).
- `saved-md`: stored as `<unit>/refs/<key>.md`.
- `saved-pdf`: stored as `<unit>/refs/<key>.pdf`.
- `blocked`: cannot be retrieved (paywall, geo-block, 404, requires login, interactive CAPTCHA, IP reputation). Record the reason in Notes and set `README.md` status to `Inaccessible`.
- `superseded`: source was replaced or removed from the active bibliography. Note the replacement key.

Update `Last attempt` (YYYY-MM-DD) every time the status changes.

## Landing page vs. direct asset URL

Think-tank citations (CSIS, RAND, CNAS, FDD, etc.) usually point to a **landing page** (HTML abstract + download button), not the report PDF. Before queueing a fetch:

1. Decide whether the claim needs the report body or just the landing page. An abstract rarely supports substantive claims.
1. **Parse the landing-page DOM for the underlying asset URL** (typical: `csis-website-prod.s3.amazonaws.com/.../<slug>.pdf`, `s3.us-east-1.amazonaws.com/files.cnas.org/.../<slug>.pdf`, `rand.org/content/dam/rand/pubs/.../<slug>.pdf`). Use *that* URL with `robust-web-fetch`. S3-hosted PDFs typically clear tier 1 (curl-cffi); landing pages often need Wayback or camoufox.
1. Record both URLs: citation URL (landing page) in the bib `url =`; direct asset URL as a `% Direct report PDF: <url>` comment line above the bib entry and in this file's Notes column. In `README.md`, distinguish `Landing page markdown` from `Full text markdown`.

## Job Queue

| Citation key | Source URL | Target | Status | Last attempt | Notes |
|---|---|---|---|---|---|
| `[citation_key]` | `[url]` | `.md` / `.pdf` | `[status]` | `YYYY-MM-DD` | `[tier used, snapshot ID, blocker, direct asset URL if applicable]` |

## When a job completes

1. Update this file's row: `Status` + `Last attempt`.
1. Save the artifact to `<unit>/refs/<citation_key>.md` or `.pdf`.
1. Update `README.md`'s *Active Source Retention* row to match (`Full text markdown` / `PDF saved` / `Landing page markdown` / `Landing page markdown + PDF` / `Inaccessible`).
1. If blocked, write the reason in Notes here and set `README.md` to `Inaccessible`.
