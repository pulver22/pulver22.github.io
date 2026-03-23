# Publications Auto-Update System

## Overview

The publications page now automatically fetches publication data from ORCID and arXiv APIs, eliminating the need for manual updates when new papers are published.

## How It Works

### Data Sources

1. **ORCID API** (Primary Source)
   - Fetches publication metadata from your ORCID profile
   - ORCID ID: `0000-0001-8318-7269`
   - Endpoint: `https://pub.orcid.org/v3.0/{ORCID-ID}/works`
   - No authentication required for public profiles
   - Returns: titles, publication types, years, DOIs, URLs

2. **arXiv API** (Secondary Source - Preprints)
   - Fetches preprints from arXiv
   - Search by author name: "Polvara"
   - Endpoint: `http://export.arxiv.org/api/query`
   - Returns: titles, authors, years, abstracts, arXiv IDs

### Features

- **Automatic Updates**: Publications are fetched automatically on page load
- **Smart Caching**: Results are cached for 24 hours to reduce API calls and improve performance
- **Manual Refresh**: Click the "Refresh" button to force fetch latest publications
- **Fallback Content**: Static HTML content is preserved as fallback if API fails
- **Deduplication**: Automatically merges and deduplicates publications from multiple sources
- **Filtering**: Filter publications by type (Journal, Conference, Preprints)
- **Loading States**: Shows loading spinner while fetching data
- **Error Handling**: Gracefully handles API failures and network issues

### Caching

- Publications are cached in browser's `localStorage`
- Cache expires after 24 hours
- Cache is automatically cleared on manual refresh
- If API fails, expired cache is used as fallback

## Configuration

The system can be configured in `/publications.html` (line ~633):

```javascript
pubManager = new PublicationsManager({
  orcidId: '0000-0001-8318-7269',        // Your ORCID ID
  authorName: 'Polvara',                   // Author name for arXiv search
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
- **arXiv**: Ensure author name "Polvara" appears in the paper's author list
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
- Add Google Scholar integration (requires scraping or third-party service)
- Support multiple ORCID IDs for co-authored papers
- Add citation counts (requires Crossref or Semantic Scholar API)
- Export publications to BibTeX format
- Add search/filter by keyword or year range
- Show abstract on click/hover
- Add analytics for most viewed publications

## Maintenance

### Updating ORCID ID
If ORCID ID changes, update in `publications.html`:
```javascript
orcidId: '0000-0001-8318-7269'  // Change this
```

### Updating Author Name
If searching different name on arXiv, update in `publications.html`:
```javascript
authorName: 'Polvara'  // Change this
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
