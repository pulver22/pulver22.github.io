/**
 * Publications Manager
 * Automatically fetches publications from ORCID and arXiv APIs
 */

class PublicationsManager {
  constructor(config) {
    this.config = {
      orcidId: config.orcidId || '0000-0001-8318-7269',
      authorName: config.authorName || 'Polvara',
      cacheExpiration: config.cacheExpiration || 24 * 60 * 60 * 1000, // 24 hours in ms
      useCache: config.useCache !== false,
      metadataCacheExpiration: config.metadataCacheExpiration || 30 * 24 * 60 * 60 * 1000, // 30 days
      metadataCacheKey: config.metadataCacheKey || 'crossref_metadata_cache_v1',
      ...config
    };
    this.publications = [];
  }

  /**
   * Main method to fetch all publications
   */
  async fetchPublications() {
    // Check cache first
    if (this.config.useCache) {
      const cached = this.getFromCache();
      if (cached) {
        console.log('Using cached publications');
        const needsRefresh = this.cachedNeedsEnrichment(cached);
        if (needsRefresh) {
          console.log('Refreshing cached publications with improved metadata');
          const refreshed = await this.refreshCachedPublications(cached);
          this.publications = refreshed;
          return refreshed;
        }

        this.publications = cached;
        return cached;
      }
    }

    try {
      console.log('Fetching fresh publications from APIs...');

      // Fetch from ORCID
      const orcidPubs = await this.fetchFromORCID();
      console.log(`Fetched ${orcidPubs.length} publications from ORCID`);

      // Fetch from arXiv
      const arxivPubs = await this.fetchFromArXiv();
      console.log(`Fetched ${arxivPubs.length} publications from arXiv`);

      // Merge and deduplicate
      this.publications = this.mergePublications(orcidPubs, arxivPubs);
      console.log(`Total unique publications: ${this.publications.length}`);

      // Sort by year (newest first)
      this.publications.sort((a, b) => b.year - a.year);

      // Cache the results
      if (this.config.useCache) {
        this.saveToCache(this.publications);
      }

      return this.publications;
    } catch (error) {
      console.error('Error fetching publications:', error);
      // Try to return cached data as fallback
      const cached = this.getFromCache(true); // ignore expiration
      if (cached) {
        console.log('Using expired cache as fallback');
        return cached;
      }
      throw error;
    }
  }

  /**
   * Fetch publications from ORCID API
   */
  async fetchFromORCID() {
    const url = `https://pub.orcid.org/v3.0/${this.config.orcidId}/works`;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`ORCID API error: ${response.status}`);
      }

      const data = await response.json();
      return await this.parseORCIDData(data);
    } catch (error) {
      console.error('Error fetching from ORCID:', error);
      return [];
    }
  }

  /**
   * Parse ORCID API response and fetch detailed work information
   */
  async parseORCIDData(data) {
    if (!data || !data.group) {
      return [];
    }

    const publications = [];
    const detailPromises = [];

    // Collect all works and their put-codes
    data.group.forEach(group => {
      if (!group['work-summary'] || group['work-summary'].length === 0) {
        return;
      }

      // Use the first work summary (they're usually duplicates from different sources)
      const work = group['work-summary'][0];
      const putCode = work['put-code'];

      // Fetch detailed information for each work
      detailPromises.push(
        this.fetchORCIDWorkDetail(putCode).then(detailedWork => {
          if (detailedWork) {
            const pub = {
              source: 'orcid',
              title: detailedWork.title?.title?.value || work.title?.title?.value || 'Untitled',
              year: work['publication-date']?.year?.value || 'n.d.',
              type: this.mapORCIDType(work.type),
              url: this.extractORCIDUrl(work),
              putCode: putCode,
              journalTitle: work['journal-title']?.value || null,
              authors: this.extractORCIDAuthors(detailedWork),
              doi: this.extractDOI(work),
              venue: this.extractVenue(work, detailedWork)
            };
            return pub;
          }
          return null;
        })
      );
    });

    // Wait for all detailed work fetches to complete
    const results = await Promise.all(detailPromises);

    // Filter out nulls and add to publications
    results.forEach(pub => {
      if (pub) {
        publications.push(pub);
      }
    });

    // Enrich with Crossref data for publications with DOIs
    await this.enrichWithCrossref(publications);

    // Ensure all publications have author information for consistency
    this.ensureAuthorConsistency(publications);

    return publications;
  }

  /**
   * Ensure all publications have author information for display consistency
   * This is a last resort fallback - should only trigger if ORCID and Crossref both fail
   */
  ensureAuthorConsistency(publications) {
    const targetAuthor = this.config.authorName || 'Polvara';
    let placeholderCount = 0;

    publications.forEach(pub => {
      // If no authors at all, add a placeholder with target author as absolute last resort
      if (!pub.authors ||
          (Array.isArray(pub.authors) && pub.authors.length === 0) ||
          (typeof pub.authors === 'string' && pub.authors.trim() === '')) {

        // Use a generic author entry based on ORCID profile
        pub.authors = [targetAuthor + ' R'];
        pub.hasPlaceholderAuthors = true; // Mark for future enrichment attempts
        placeholderCount++;
        console.warn(`⚠ No authors found for "${pub.title.substring(0, 50)}..." from any source (ORCID or Crossref), using placeholder. DOI: ${pub.doi || 'none'}`);
      }
    });

    if (placeholderCount > 0) {
      console.warn(`${placeholderCount} publication(s) are using placeholder authors. This may indicate API issues.`);
    }
  }

  cachedNeedsEnrichment(publications) {
    return publications.some(pub => this.needsMetadataRefresh(pub));
  }

  async refreshCachedPublications(publications) {
    // Deep clone to avoid mutating the cached object until we resave
    const clone = JSON.parse(JSON.stringify(publications));

    // Try to enrich missing authors/venues
    const needsRefresh = clone.filter(pub => this.needsMetadataRefresh(pub));
    if (needsRefresh.length > 0) {
      await this.enrichWithCrossref(needsRefresh);
    }
    this.ensureAuthorConsistency(clone);

    if (this.config.useCache) {
      this.saveToCache(clone);
    }

    return clone;
  }

  needsMetadataRefresh(pub) {
    if (!pub || !pub.doi) {
      return false;
    }

    const authorCount = this.countAuthors(pub.authors);
    const missingVenue = !pub.venue && !pub.journalTitle;
    const weakAuthors = !pub.authors || pub.hasPlaceholderAuthors || authorCount <= 1;

    return missingVenue || weakAuthors;
  }

  countAuthors(authors) {
    if (!authors) {
      return 0;
    }
    if (Array.isArray(authors)) {
      return authors.length;
    }
    if (typeof authors === 'string') {
      return authors.split(',').map(a => a.trim()).filter(Boolean).length;
    }
    return 0;
  }

  /**
   * Fetch detailed work information from ORCID
   */
  async fetchORCIDWorkDetail(putCode) {
    const url = `https://pub.orcid.org/v3.0/${this.config.orcidId}/work/${putCode}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn(`Failed to fetch ORCID work detail for put-code ${putCode}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.warn(`Error fetching ORCID work detail:`, error);
      return null;
    }
  }

  /**
   * Extract authors from detailed ORCID work
   */
  extractORCIDAuthors(detailedWork) {
    if (!detailedWork || !detailedWork.contributors || !detailedWork.contributors.contributor) {
      return null;
    }

    const contributors = detailedWork.contributors.contributor;
    const authors = contributors
      .filter(c => c['contributor-attributes']?.['contributor-role'] === 'author')
      .map(c => {
        // Try credit name first
        const creditName = c['credit-name']?.value;
        if (creditName) {
          return creditName;
        }

        // Try to construct from contributor-orcid or contributor-email if available
        // Try alternative paths for given and family names
        const attrs = c['contributor-attributes'];
        let givenName = attrs?.['given-names']?.value;
        let familyName = attrs?.['family-name']?.value;

        // Sometimes names are at the contributor level
        if (!givenName && c['contributor-orcid']) {
          givenName = c['contributor-orcid']['given-names']?.value;
        }
        if (!familyName && c['contributor-orcid']) {
          familyName = c['contributor-orcid']['family-name']?.value;
        }

        if (givenName && familyName) {
          return `${givenName} ${familyName}`;
        } else if (familyName) {
          return familyName;
        } else if (givenName) {
          return givenName;
        }

        return null;
      })
      .filter(name => name !== null);

    return authors.length > 0 ? authors : null;
  }

  /**
   * Extract venue information from work
   */
  extractVenue(work, detailedWork) {
    // Try journal title first
    if (work['journal-title']?.value) {
      return work['journal-title'].value;
    }

    // Try from detailed work
    if (detailedWork?.['journal-title']?.value) {
      return detailedWork['journal-title'].value;
    }

    return null;
  }

  /**
   * Enrich publications with Crossref metadata
   */
  async enrichWithCrossref(publications) {
    console.log(`Starting Crossref enrichment for ${publications.filter(p => p.doi).length} publications with DOIs`);

    const crossrefPromises = publications
      .filter(pub => pub.doi) // Try to enrich all publications with DOIs
      .map(async (pub, index) => {
        // Add small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, index * 100));

        try {
          const crossrefData = await this.fetchFromCrossrefWithRetry(pub.doi);
          if (crossrefData) {
            let enriched = false;

            // Add or replace authors if Crossref has better data
            const crossrefAuthorCount = crossrefData.authors ? crossrefData.authors.length : 0;
            const currentAuthorCount = this.countAuthors(pub.authors);
            const weakAuthors = !pub.authors || pub.hasPlaceholderAuthors || currentAuthorCount <= 1;

            if (crossrefAuthorCount > 0 &&
                (weakAuthors || crossrefAuthorCount > currentAuthorCount)) {
              pub.authors = crossrefData.authors;
              pub.hasPlaceholderAuthors = false;
              enriched = true;
            }

            // Add venue if not already present
            if (!pub.venue && crossrefData.venue) {
              pub.venue = crossrefData.venue;
              enriched = true;
            }

            // Update journal title if available
            if (!pub.journalTitle && crossrefData.venue) {
              pub.journalTitle = crossrefData.venue;
            }

            if (enriched) {
              console.log(`✓ Enriched "${pub.title.substring(0, 50)}..." with Crossref data`);
            }
          }
        } catch (error) {
          console.warn(`Failed to enrich "${pub.title.substring(0, 50)}...":`, error.message);
        }
      });

    await Promise.all(crossrefPromises);
    console.log('Crossref enrichment completed');
  }

  /**
   * Fetch from Crossref with retry logic for transient failures
   */
  async fetchFromCrossrefWithRetry(doi, maxRetries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
          console.log(`Retry ${attempt}/${maxRetries} for DOI ${doi}`);
        }

        const result = await this.fetchFromCrossref(doi);
        if (result) {
          return result;
        }

        // If result is null but no error thrown, don't retry
        if (attempt === 0) {
          return null;
        }
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  }

  parseCrossrefWork(work) {
    if (!work) {
      return null;
    }

    // Extract authors
    let authors = null;
    if (work.author && work.author.length > 0) {
      authors = work.author.map(a => {
        if (a.given && a.family) {
          return `${a.given} ${a.family}`;
        } else if (a.family) {
          return a.family;
        } else if (a.name) {
          return a.name;
        }
        return null;
      }).filter(name => name !== null);
    }

    // Extract venue (journal or conference)
    let venue = null;
    if (work['container-title'] && work['container-title'].length > 0) {
      venue = work['container-title'][0];
    } else if (work['event'] && work['event'].name) {
      venue = work['event'].name;
    }

    if ((authors && authors.length > 0) || venue) {
      return { authors, venue };
    }
    return null;
  }

  async fetchBibtexMetadata(doi) {
    try {
      const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`;
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const bibtex = await response.text();
      const parsed = this.parseBibtexMetadata(bibtex);
      if (parsed && ((parsed.authors && parsed.authors.length > 0) || parsed.venue)) {
        return parsed;
      }
    } catch (error) {
      console.warn(`BibTeX fallback failed for DOI ${doi}:`, error);
    }
    return null;
  }

  parseBibtexMetadata(bibtexText) {
    if (!bibtexText) {
      return null;
    }

    // Extract author line
    const authorMatch = bibtexText.match(/author\s*=\s*[{"]([^}"]+)/i);
    let authors = null;
    if (authorMatch && authorMatch[1]) {
      authors = authorMatch[1]
        .split(/\s+and\s+/i)
        .map(a => a.replace(/[{}]/g, '').trim())
        .filter(Boolean);
    }

    // Extract venue (journal or booktitle)
    const venueMatch = bibtexText.match(/(?:journal|booktitle)\s*=\s*[{"]([^}"]+)/i);
    const venue = venueMatch && venueMatch[1] ? venueMatch[1].replace(/[{}]/g, '').trim() : null;

    if ((authors && authors.length > 0) || venue) {
      return { authors, venue };
    }
    return null;
  }

  /**
   * Fetch publication metadata from Crossref API
   */
  async fetchFromCrossref(doi) {
    const cached = this.getCrossrefMetadataFromCache(doi);
    if (cached) {
      return cached;
    }

    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const work = data.message;

      const parsed = this.parseCrossrefWork(work);
      if (parsed) {
        this.saveCrossrefMetadataToCache(doi, parsed);
        return parsed;
      }
    } catch (error) {
      console.warn(`Crossref API error for DOI ${doi}:`, error);
    }

    // Fallback: attempt to fetch bibtex to recover authors/venue
    const bibtex = await this.fetchBibtexMetadata(doi);
    if (bibtex) {
      this.saveCrossrefMetadataToCache(doi, bibtex);
      return bibtex;
    }

    return null;
  }

  /**
   * Extract DOI from ORCID work
   */
  extractDOI(work) {
    if (!work['external-ids'] || !work['external-ids']['external-id']) {
      return null;
    }

    const doiEntry = work['external-ids']['external-id'].find(
      id => id['external-id-type'] === 'doi'
    );

    return doiEntry ? doiEntry['external-id-value'] : null;
  }

  /**
   * Extract URL from ORCID work
   */
  extractORCIDUrl(work) {
    let url = null;
    let directUrl = null;

    // Try to get URL from external identifiers (direct publisher links)
    if (work['external-ids'] && work['external-ids']['external-id']) {
      const urlEntry = work['external-ids']['external-id'].find(
        id => id['external-id-url'] && id['external-id-url'].value
      );
      if (urlEntry) {
        directUrl = urlEntry['external-id-url'].value;

        // Clean trailing slashes from direct URLs
        if (directUrl && directUrl.endsWith('/')) {
          directUrl = directUrl.slice(0, -1);
        }

        // Prefer direct URLs that are NOT doi.org links
        if (directUrl && !directUrl.includes('doi.org')) {
          url = directUrl;
        }
      }
    }

    // If no direct publisher URL, try DOI (but avoid it if possible due to redirect issues)
    if (!url) {
      const doi = this.extractDOI(work);
      if (doi) {
        // Only use DOI if we have no other option
        // DOI redirects can sometimes add trailing slashes causing issues
        url = `https://doi.org/${doi}`;
      }
    }

    // Fallback to work URL
    if (!url) {
      url = work.url?.value || null;
      if (url && url.endsWith('/')) {
        url = url.slice(0, -1);
      }
    }

    // If we only have directUrl with doi.org, use it as last resort
    if (!url && directUrl) {
      url = directUrl;
    }

    return url;
  }

  /**
   * Map ORCID work types to our categories
   */
  mapORCIDType(orcidType) {
    const typeMap = {
      'journal-article': 'journal',
      'conference-paper': 'conference',
      'conference-abstract': 'conference',
      'preprint': 'other',
      'working-paper': 'other',
      'other': 'other'
    };
    return typeMap[orcidType] || 'other';
  }

  /**
   * Fetch publications from arXiv API
   */
  async fetchFromArXiv() {
    const author = this.config.authorName;
    const url = `http://export.arxiv.org/api/query?search_query=au:${encodeURIComponent(author)}&max_results=100&sortBy=submittedDate&sortOrder=descending`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`arXiv API error: ${response.status}`);
      }

      const xmlText = await response.text();
      return this.parseArXivData(xmlText);
    } catch (error) {
      console.error('Error fetching from arXiv:', error);
      return [];
    }
  }

  /**
   * Parse arXiv API response (Atom XML)
   */
  parseArXivData(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    const entries = xmlDoc.querySelectorAll('entry');
    const publications = [];

    entries.forEach(entry => {
      const title = entry.querySelector('title')?.textContent?.trim();
      const published = entry.querySelector('published')?.textContent;
      const year = published ? new Date(published).getFullYear() : 'n.d.';
      const id = entry.querySelector('id')?.textContent;
      const arxivId = id ? id.split('/').pop() : null;

      // Get authors
      const authorNodes = entry.querySelectorAll('author name');
      const authors = Array.from(authorNodes).map(node => node.textContent.trim());

      // Get abstract
      const summary = entry.querySelector('summary')?.textContent?.trim();

      const pub = {
        source: 'arxiv',
        title: title,
        year: year,
        type: 'other', // arXiv papers are preprints
        url: `https://arxiv.org/abs/${arxivId}`,
        arxivId: arxivId,
        authors: authors.join(', '),
        abstract: summary,
        doi: null
      };

      publications.push(pub);
    });

    return publications;
  }

  /**
   * Merge publications from multiple sources and remove duplicates
   */
  mergePublications(...sources) {
    const merged = [];
    const seen = new Set();

    sources.forEach(source => {
      source.forEach(pub => {
        // Create a unique key for deduplication
        const key = this.createPublicationKey(pub);

        if (!seen.has(key)) {
          seen.add(key);
          merged.push(pub);
        }
      });
    });

    return merged;
  }

  /**
   * Create a unique key for a publication (for deduplication)
   */
  createPublicationKey(pub) {
    // Use title and year as the key (normalized)
    const normalizedTitle = pub.title.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 50);
    return `${normalizedTitle}-${pub.year}`;
  }

  /**
   * Save publications to localStorage
   */
  saveToCache(publications) {
    const cacheData = {
      timestamp: Date.now(),
      publications: publications
    };
    try {
      localStorage.setItem('publications_cache', JSON.stringify(cacheData));
    } catch (error) {
      console.warn('Failed to save to cache:', error);
    }
  }

  /**
   * Get publications from cache
   */
  getFromCache(ignoreExpiration = false) {
    try {
      const cached = localStorage.getItem('publications_cache');
      if (!cached) {
        return null;
      }

      const cacheData = JSON.parse(cached);
      const age = Date.now() - cacheData.timestamp;

      if (!ignoreExpiration && age > this.config.cacheExpiration) {
        console.log('Cache expired');
        return null;
      }

      return cacheData.publications;
    } catch (error) {
      console.warn('Failed to read cache:', error);
      return null;
    }
  }

  getCrossrefMetadataFromCache(doi) {
    if (!doi) {
      return null;
    }

    try {
      const raw = localStorage.getItem(this.config.metadataCacheKey);
      if (!raw) {
        return null;
      }

      const cache = JSON.parse(raw);
      const entry = cache?.entries?.[doi.toLowerCase()];
      if (!entry) {
        return null;
      }

      const age = Date.now() - entry.timestamp;
      if (age > this.config.metadataCacheExpiration) {
        return null;
      }

      return entry.data || null;
    } catch (error) {
      console.warn('Failed to read metadata cache:', error);
      return null;
    }
  }

  saveCrossrefMetadataToCache(doi, data) {
    if (!doi || !data) {
      return;
    }

    try {
      const raw = localStorage.getItem(this.config.metadataCacheKey);
      const cache = raw ? JSON.parse(raw) : { entries: {} };
      const key = doi.toLowerCase();
      const existing = cache.entries[key]?.data || {};

      const merged = {
        authors: (data.authors && data.authors.length > 0) ? data.authors : existing.authors,
        venue: data.venue || existing.venue
      };

      // Only store if we have meaningful data
      if ((merged.authors && merged.authors.length > 0) || merged.venue) {
        cache.entries[key] = {
          timestamp: Date.now(),
          data: merged
        };
        localStorage.setItem(this.config.metadataCacheKey, JSON.stringify(cache));
      }
    } catch (error) {
      console.warn('Failed to write metadata cache:', error);
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    try {
      localStorage.removeItem('publications_cache');
      localStorage.removeItem(this.config.metadataCacheKey);
    } catch (error) {
      console.warn('Failed to clear cache:', error);
    }
  }

  /**
   * Render publications to HTML
   */
  renderPublications(publications, container) {
    const groupedByType = {
      journal: [],
      conference: [],
      other: []
    };

    // Group publications by type
    publications.forEach(pub => {
      if (groupedByType[pub.type]) {
        groupedByType[pub.type].push(pub);
      }
    });

    // Create HTML for each section
    let html = '';

    // Journal Papers
    if (groupedByType.journal.length > 0) {
      html += '<h3 class="pub-section-heading" data-section="journal">Journal Papers</h3>';
      html += '<ul class="pub-list">';
      html += groupedByType.journal.map(pub => this.renderPublicationItem(pub)).join('');
      html += '</ul>';
    }

    // Conference Papers
    if (groupedByType.conference.length > 0) {
      html += '<h3 class="pub-section-heading" data-section="conference">Conference Papers</h3>';
      html += '<ul class="pub-list">';
      html += groupedByType.conference.map(pub => this.renderPublicationItem(pub)).join('');
      html += '</ul>';
    }

    // Other (Preprints & Presentations)
    if (groupedByType.other.length > 0) {
      html += '<h3 class="pub-section-heading" data-section="other">Presentations &amp; Preprints</h3>';
      html += '<ul class="pub-list">';
      html += groupedByType.other.map(pub => this.renderPublicationItem(pub)).join('');
      html += '</ul>';
    }

    // Insert into container
    if (container) {
      container.innerHTML = html;
    }

    return html;
  }

  /**
   * Render a single publication item
   */
  renderPublicationItem(pub) {
    const url = pub.url || '#';
    const title = this.escapeHtml(pub.title);

    // Use venue field, fallback to journalTitle
    const venueText = pub.venue || pub.journalTitle;
    const venue = venueText ? `<em>${this.escapeHtml(venueText)}</em>` : '';

    let links = '';
    if (pub.url) {
      if (pub.arxivId) {
        links += `<a href="${pub.url}">arXiv</a>`;
      } else if (pub.doi) {
        links += `<a href="${pub.url}">DOI</a>`;
      } else {
        links += `<a href="${pub.url}">Link</a>`;
      }
    }

    // Format authors with highlighting
    const authorsHtml = this.formatAuthors(pub.authors);

    return `
      <li class="pub-item" data-type="${pub.type}">
        <span class="pub-year">${pub.year}</span>
        <div class="pub-content">
          <div class="pub-title">
            <a href="${url}">${title}</a>
          </div>
          ${authorsHtml ? `<div class="pub-authors">${authorsHtml}</div>` : ''}
          ${venue ? `<div class="pub-venue">${venue}</div>` : ''}
          ${links ? `<div class="pub-links">${links}</div>` : ''}
        </div>
      </li>
    `;
  }

  /**
   * Format author list with highlighting for target author
   */
  formatAuthors(authors) {
    if (!authors) {
      return '';
    }

    // If authors is already a string (from arXiv), use it directly
    if (typeof authors === 'string') {
      return this.highlightAuthor(authors);
    }

    // If authors is an array, format it
    if (Array.isArray(authors)) {
      // Limit to reasonable number of authors for display
      if (authors.length > 15) {
        // Show first few, target author if present, and last few
        const formatted = this.formatAuthorList(authors);
        return this.highlightAuthor(formatted);
      } else {
        const formatted = authors.join(', ');
        return this.highlightAuthor(formatted);
      }
    }

    return '';
  }

  /**
   * Format a long author list with ellipsis
   */
  formatAuthorList(authors) {
    const targetName = this.config.authorName || 'Polvara';
    const targetIndex = authors.findIndex(name =>
      name.toLowerCase().includes(targetName.toLowerCase())
    );

    // If list is short enough, show all
    if (authors.length <= 15) {
      return authors.join(', ');
    }

    // If target author is in the list
    if (targetIndex !== -1) {
      // Keep first 3, target author and surrounding, last 2
      const beforeTarget = Math.max(0, targetIndex - 1);
      const afterTarget = Math.min(authors.length - 1, targetIndex + 1);

      let result = [];

      // First authors
      if (beforeTarget > 3) {
        result.push(...authors.slice(0, 3));
        result.push('...');
      } else {
        result.push(...authors.slice(0, beforeTarget));
      }

      // Around target
      result.push(...authors.slice(beforeTarget, afterTarget + 1));

      // Last authors
      if (afterTarget < authors.length - 3) {
        result.push('...');
        result.push(...authors.slice(-2));
      } else {
        result.push(...authors.slice(afterTarget + 1));
      }

      return result.join(', ');
    }

    // Target author not found, show first and last
    return authors.slice(0, 5).join(', ') + ', ..., ' + authors.slice(-2).join(', ');
  }

  /**
   * Highlight the target author name in the author list
   */
  highlightAuthor(authorString) {
    if (!authorString) {
      return '';
    }

    const targetName = this.config.authorName || 'Polvara';

    // Escape the author string for safety
    const escaped = this.escapeHtml(authorString);

    // Find and highlight all variations of the target name
    // This handles: "Polvara R", "R Polvara", "Polvara, R", "Riccardo Polvara", etc.
    const patterns = [
      new RegExp(`\\b${targetName}\\s+[A-Z]\\b`, 'gi'),  // "Polvara R"
      new RegExp(`\\b[A-Z]\\s+${targetName}\\b`, 'gi'),  // "R Polvara"
      new RegExp(`\\b${targetName},?\\s+[A-Z]\\.?\\b`, 'gi'),  // "Polvara, R" or "Polvara R."
      new RegExp(`\\b[A-Z]\\.?\\s+${targetName}\\b`, 'gi'),  // "R. Polvara"
      new RegExp(`\\b\\w+\\s+${targetName}\\b`, 'gi'),  // "Riccardo Polvara"
      new RegExp(`\\b${targetName}\\s+\\w+\\b`, 'gi'),  // "Polvara Riccardo"
      new RegExp(`\\b${targetName}\\b`, 'gi')  // Just "Polvara"
    ];

    let result = escaped;
    for (const pattern of patterns) {
      result = result.replace(pattern, match => `<strong>${match}</strong>`);
    }

    return result;
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Make it available globally
window.PublicationsManager = PublicationsManager;
