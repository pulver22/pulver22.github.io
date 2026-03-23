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
      return this.parseORCIDData(data);
    } catch (error) {
      console.error('Error fetching from ORCID:', error);
      return [];
    }
  }

  /**
   * Parse ORCID API response
   */
  parseORCIDData(data) {
    if (!data || !data.group) {
      return [];
    }

    const publications = [];

    data.group.forEach(group => {
      if (!group['work-summary'] || group['work-summary'].length === 0) {
        return;
      }

      // Use the first work summary (they're usually duplicates from different sources)
      const work = group['work-summary'][0];

      // Extract publication details
      const pub = {
        source: 'orcid',
        title: work.title?.title?.value || 'Untitled',
        year: work['publication-date']?.year?.value || 'n.d.',
        type: this.mapORCIDType(work.type),
        url: this.extractORCIDUrl(work),
        putCode: work['put-code'],
        journalTitle: work['journal-title']?.value || null,
        authors: null, // ORCID summary doesn't include full author list
        doi: this.extractDOI(work)
      };

      publications.push(pub);
    });

    return publications;
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
    // Try to get URL from external identifiers
    if (work['external-ids'] && work['external-ids']['external-id']) {
      const urlEntry = work['external-ids']['external-id'].find(
        id => id['external-id-url'] && id['external-id-url'].value
      );
      if (urlEntry) {
        return urlEntry['external-id-url'].value;
      }
    }

    // Try DOI
    const doi = this.extractDOI(work);
    if (doi) {
      return `https://doi.org/${doi}`;
    }

    return work.url?.value || null;
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

  /**
   * Clear cache
   */
  clearCache() {
    try {
      localStorage.removeItem('publications_cache');
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
    const venue = pub.journalTitle ? `<em>${this.escapeHtml(pub.journalTitle)}</em>` : '';

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

    const authors = pub.authors ? `<div class="pub-authors">${this.escapeHtml(pub.authors)}</div>` : '';

    return `
      <li class="pub-item" data-type="${pub.type}">
        <span class="pub-year">${pub.year}</span>
        <div class="pub-content">
          <div class="pub-title">
            <a href="${url}">${title}</a>
          </div>
          ${authors}
          ${venue ? `<div class="pub-venue">${venue}</div>` : ''}
          ${links ? `<div class="pub-links">${links}</div>` : ''}
        </div>
      </li>
    `;
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
