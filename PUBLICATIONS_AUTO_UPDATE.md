# Publications Auto-Update System

## Overview

The publications page now automatically fetches publication data from ORCID, arXiv, and **Semantic Scholar author-level search**, with additional metadata enrichment from Semantic Scholar, OpenAlex, and Crossref APIs. This provides **complete author lists and venue information**, eliminating the need for manual updates when new papers are published.

## How It Works

### Data Sources

1. **Semantic Scholar API** (Primary Source - Author Search)
   - Fetches **all publications** directly from Semantic Scholar by author
   - Automatically searches and matches author by name
   - Endpoint: `https://api.semanticscholar.org/graph/v1/author/{authorId}/papers`
   - Provides: **complete author lists**, venue information, DOIs, arXiv IDs
   - Rate limit: 100 requests per 5 minutes (no API key required)
   - **Most comprehensive source** - discovers publications not in ORCID

2. **ORCID API** (Secondary Source)
   - Fetches publication metadata from your ORCID profile
   - ORCID ID: `0000-0001-8318-7269`
   - Endpoints:
     - Summary: `https://pub.orcid.org/v3.0/{ORCID-ID}/works`
     - Details: `https://pub.orcid.org/v3.0/{ORCID-ID}/work/{PUT-CODE}`
   - No authentication required for public profiles
   - Returns: titles, publication types, years, DOIs, URLs, **authors**, venues

3. **arXiv API** (Preprints)
   - Fetches preprints from arXiv
   - Search by author name: "Riccardo Polvara"
   - Endpoint: `http://export.arxiv.org/api/query`
   - Returns: titles, **full author lists**, years, abstracts, arXiv IDs
   - **All arXiv publications are automatically categorized as Preprints**

### Metadata Enrichment Sources

4. **Semantic Scholar API** (Enrichment - Primary)
   - Enriches publications with missing metadata
   - Endpoint: `https://api.semanticscholar.org/graph/v1/paper/{identifier}`
   - Works with: DOI, arXiv ID, or title search
   - Provides: **complete author lists**, venue information
   - **Tried first** for enrichment

5. **Crossref API** (Enrichment - Secondary)
   - Enriches publications with DOIs
   - Endpoint: `https://api.crossref.org/works/{DOI}`
   - Provides: **complete author lists**, journal/conference names, publication details
   - Fills in missing metadata when Semantic Scholar doesn't have it

6. **OpenAlex API** (Enrichment - Fallback)
   - Open scholarly metadata source
   - Endpoint: `https://api.openalex.org/works/{DOI}`
   - Provides: **complete author lists**, venue/journal names
   - No rate limits, completely free

### Why Not ResearchGate?

**ResearchGate cannot be used** for the following reasons:
- ❌ **No public API available** - ResearchGate discontinued their API in 2018
- ❌ **Scraping violates Terms of Service** - Automated data collection is explicitly prohibited
- ❌ **CORS restrictions** - Cannot be accessed from client-side JavaScript
- ❌ **Anti-scraping measures** - Rate limiting, CAPTCHAs, and IP blocking prevent automated access
- ✅ **Better alternatives**: Semantic Scholar and OpenAlex provide similar or better coverage, are completely legal, and work reliably from the browser

### Features

- **Complete Bibliography**: Full author lists and publication venues (journals/conferences)
- **Author Highlighting**: Automatically highlights "Polvara" in author lists with `<strong>` tags
- **Smart Author Formatting**: Long author lists show first few, target author, and last few with "..."
- **Automatic Updates**: Publications are fetched automatically on page load
- **Smart Caching**: Results are cached for 24 hours to reduce API calls and improve performance
- **Metadata Cache**: Crossref/BibTeX metadata cached per DOI (30 days) to keep author/venue consistent across reloads
- **Manual Refresh**: Click the "Refresh" button to force fetch latest publications
- **Fallback Content**: Static HTML content is preserved as fallback if API fails
- **Deduplication**: Automatically merges and deduplicates publications from multiple sources
- **Filtering**: Filter publications by type (Journal, Conference, Preprints)
- **Loading States**: Shows loading spinner while fetching data
- **Error Handling**: Gracefully handles API failures and network issues

### Data Enrichment Flow (Waterfall Approach)

```
Publication Sources (Parallel):
  ├─ ORCID Publications → ORCID Details (authors)
  ├─ arXiv Publications → Extract authors + DOI (if present)
  └─ Semantic Scholar Author Search → All author's papers
                    ↓
              Merge & Deduplicate
              (arXiv publications always marked as Preprints)
                    ↓
          Waterfall Enrichment (for incomplete metadata):
                    ↓
          1. Semantic Scholar (arXiv ID or DOI) ← FIRST
                    ↓
          2. Crossref (DOI)
                    ↓
          3. OpenAlex (DOI)
                    ↓
          4. Semantic Scholar (title search - last resort)
                    ↓
          Complete Metadata (authors + venue)
```

**Key Changes:**
- **Semantic Scholar author search** now fetches all publications by the author
- **Semantic Scholar is tried first** for enrichment (before Crossref)
- **arXiv publications always remain as Preprints** even after enrichment
- The system combines multiple sources for maximum coverage

### Author List Formatting

- **Short lists** (≤15 authors): Show all authors
- **Long lists** (>15 authors): Show "First 3, ..., [Target Author & neighbors], ..., Last 2"
- **Target author** ("Polvara"): Always highlighted with `<strong>` tags
- **Multiple name formats**: Handles "Polvara R", "R Polvara", "Riccardo Polvara", etc.

### Caching

- Publications are cached in browser's `localStorage`
- Cache expires after 24 hours
- DOI-level metadata (authors/venue) from Crossref/BibTeX is cached separately for 30 days to stabilize author lists
- When cached publications are missing authors/venues, a background enrichment run refreshes them and updates the cache
- Cache is automatically cleared on manual refresh
- If API fails, expired cache is used as fallback

## Configuration

The system can be configured in `/publications.html` (line ~633):

```javascript
pubManager = new PublicationsManager({
  orcidId: '0000-0001-8318-7269',        // Your ORCID ID
  authorName: 'Riccardo Polvara',        // Author name for arXiv and Semantic Scholar search
  cacheExpiration: 24 * 60 * 60 * 1000   // Cache duration in milliseconds
});
```

### Disable Dynamic Loading

To temporarily disable dynamic loading and use only static HTML:

In `publications.html` (line ~596), change:
```javascript
let useDynamicLoading = true;
```
to:
```javascript
let useDynamicLoading = false;
```

## Files

- **`/js/publications.js`**: Core PublicationsManager class
  - Fetches data from ORCID and arXiv APIs
  - Parses and normalizes data
  - Handles caching and deduplication
  - Renders publications to HTML

- **`/publications.html`**: Publications page
  - Loads and initializes PublicationsManager
  - Contains fallback static HTML content
  - Implements filter and refresh functionality

- **`/css/academic.css`**: Styling
  - Publication list styles
  - Filter button styles
  - Refresh button styles

## API Response Examples

### ORCID API Response Structure
```json
{
  "group": [
    {
      "work-summary": [
        {
          "title": { "title": { "value": "Paper Title" } },
          "publication-date": { "year": { "value": "2024" } },
          "type": "journal-article",
          "journal-title": { "value": "Journal Name" },
          "external-ids": {
            "external-id": [
              {
                "external-id-type": "doi",
                "external-id-value": "10.xxxx/xxxxx"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

### arXiv API Response (Atom XML)
```xml
<entry>
  <title>Paper Title</title>
  <published>2024-01-15</published>
  <id>http://arxiv.org/abs/2401.12345</id>
  <author><name>Author Name</name></author>
  <summary>Abstract text...</summary>
</entry>
```

## Troubleshooting

### Publications Not Loading

1. **Check Browser Console**: Open Developer Tools (F12) and check for errors
2. **Check ORCID Profile**: Ensure profile is public at https://orcid.org/0000-0001-8318-7269
3. **Clear Cache**: Click the "Refresh" button to clear cache and reload
4. **Check Network**: Ensure APIs are accessible (check browser's Network tab)
5. **Fallback**: If APIs fail, static HTML content will be displayed

### Missing Publications

- **ORCID**: Ensure publications are added to your ORCID profile
- **arXiv**: Ensure author name "Riccardo Polvara" appears in the paper's author list
- **Semantic Scholar**: The author-level search automatically finds all papers by "Riccardo Polvara"
- **Cache**: Click "Refresh" to clear cache and fetch latest data

### Performance Issues

- Reduce cache expiration time if updates are needed more frequently
- Increase cache expiration time to reduce API calls
- Check browser's localStorage size limits (~5-10MB)

## Browser Compatibility

- Modern browsers with `fetch()` API support
- Requires `localStorage` for caching
- Tested on: Chrome, Firefox, Safari, Edge

## CORS Considerations

- ORCID API supports CORS (can be called from browser)
- arXiv API supports CORS (can be called from browser)
- No server-side proxy required

## Future Enhancements

Possible improvements:
- **Google Scholar**: No official API available. Google Scholar scraping is against their Terms of Service and unreliable. Current implementation uses Crossref API which provides similar metadata quality for published papers with DOIs.
- Add Semantic Scholar API for citation counts and additional metadata
- Support multiple ORCID IDs for co-authored papers
- Export publications to BibTeX format
- Add search/filter by keyword or year range
- Show abstract on click/hover
- Add analytics for most viewed publications

### Why Not Google Scholar?

While Google Scholar was requested, it presents significant challenges:
1. **No Official API**: Google does not provide a public API for Scholar
2. **Terms of Service**: Web scraping Google Scholar violates their ToS
3. **Unreliable**: Third-party scrapers frequently break due to anti-scraping measures
4. **Better Alternatives**: The current solution combines:
   - **ORCID**: Authoritative source controlled by the author
   - **Crossref**: High-quality metadata for published papers with DOIs
   - **arXiv**: Official API for preprints

This combination provides comprehensive, reliable, and legal access to publication data equivalent to or better than Google Scholar for most use cases.

## Maintenance

### Updating ORCID ID
If ORCID ID changes, update in `publications.html`:
```javascript
orcidId: '0000-0001-8318-7269'  // Change this
```

### Updating Author Name
If searching different name on arXiv and Semantic Scholar, update in `publications.html`:
```javascript
authorName: 'Riccardo Polvara'  // Use full name to avoid matching other authors with same surname
```

### Adjusting Cache Duration
To change how long publications are cached:
```javascript
cacheExpiration: 24 * 60 * 60 * 1000  // 24 hours in milliseconds
// Examples:
// 1 hour:  1 * 60 * 60 * 1000
// 1 week:  7 * 24 * 60 * 60 * 1000
```

## Security

- All data is fetched from public APIs
- No authentication credentials stored or exposed
- User input is HTML-escaped to prevent XSS
- No sensitive data in localStorage
- APIs are accessed over HTTPS (ORCID) or HTTP (arXiv)

## License

This implementation is part of the personal academic website and follows the same license as the repository.
