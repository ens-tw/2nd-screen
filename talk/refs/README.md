# Reference File Status

Track local source material for entries in `../references.bib`.

Use this file to show whether each active citation key has enough local material to support precise claims and locators. Markdown full text is preferred for repeated lookup. PDFs may be saved here and converted separately when paragraph or page locators are needed.

Acquisition queue (what's still to fetch and why each blocked entry is blocked) lives in `DOWNLOADS.md`, separately from this retention table.

## Status Legend

- `Full text markdown`: source is saved as `<unit>/refs/<citation_key>.md` and the body of the article/report is actually present (not just an abstract).
- `Landing page markdown`: the saved `.md` is the landing-page HTML (abstract + download button), not the report body. **Insufficient for substantive claims** — fetch the underlying PDF asset and upgrade to `Landing page markdown + PDF` or `Full text markdown`. See the **source-kit** skill (*Landing page vs. direct asset URL*).
- `Landing page markdown + PDF`: landing page saved as `<key>.md` *and* report body saved as `<key>.pdf`.
- `PDF saved`: source is saved as `<unit>/refs/<citation_key>.pdf`; convert or inspect before adding precise `p.` locators.
- `Source-role note only`: source metadata and claim support are noted, but full text is not local.
- `Inaccessible`: source could not be fetched; record title, URL/DOI, date checked, and any abstract or metadata available.
- `Deprecated`: key is no longer active in the manuscript and should not support new claims.

## Active Source Retention

| Citation key | Local status | Claim role / locator note |
|---|---|---|
| `[citation_key]` | `[status]` | `[what this source supports; note p./para. readiness]` |

## Deprecated Notes

[List superseded source notes or keys here when a bibliography is rewritten.]
