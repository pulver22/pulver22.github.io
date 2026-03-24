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

    // Regex for identifying conference venues.  Add new acronyms here as needed.
    this.conferenceVenuePattern = /\b(conference|proceedings|workshop|symposium|cvpr|iccv|eccv|icra|iros|rss|nips|neurips|icml|iclr|aaai|ijcai|ral|icaps|corl|wacv|bmvc|robocup|humanoids)\b/i;
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

      // ── Phase 1: Collect raw data from all sources ─────────────────────────
      // Each parser stores raw evidence fields (orcidWorkType, fromArXiv, venue, etc.)
      // but does NOT assign a final publication type.
      const orcidPubs = await this.fetchFromORCID();
      console.log(`Fetched ${orcidPubs.length} publications from ORCID`);

      const arxivPubs = await this.fetchFromArXiv();
      console.log(`Fetched ${arxivPubs.length} publications from arXiv`);

      const semanticScholarPubs = await this.fetchFromSemanticScholarAuthor();
      console.log(`Fetched ${semanticScholarPubs.length} publications from Semantic Scholar`);

      // ── Phase 2: Merge / deduplicate ───────────────────────────────────────
      // Evidence fields (orcidWorkType, fromArXiv, …) are preserved during merge.
      this.publications = this.mergePublications(orcidPubs, arxivPubs, semanticScholarPubs);
      console.log(`Total unique publications after merge: ${this.publications.length}`);

      // ── Phase 3: Enrich all publications with Crossref / OpenAlex / etc. ──
      // Runs on ALL publications (not just arXiv ones) so every entry gets the
      // best available venue, author list, and crossrefWorkType evidence.
      await this.enrichAllPublications(this.publications);

      // ── Phase 4: Classify publication types ───────────────────────────────
      // Final, authoritative type assignment using all collected evidence.
      // A paper is "Preprint" only when it exclusively came from arXiv with no
      // real (non-arXiv) DOI and no venue.
      this.classifyPublicationTypes(this.publications);

      // ── Phase 5: Ensure every publication has author information ──────────
      this.ensureAuthorConsistency(this.publications);

      // Sort by year (newest first); normalize to number so string years like 'n.d.' don't break ordering
      this.publications.sort((a, b) => {
        const yearA = parseInt(a.year, 10);
        const yearB = parseInt(b.year, 10);
        if (isNaN(yearA) && isNaN(yearB)) return 0;
        if (isNaN(yearA)) return 1;
        if (isNaN(yearB)) return -1;
        return yearB - yearA;
      });

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
              // Store the raw ORCID type string for later authoritative classification.
              // 'type' is set definitively in classifyPublicationTypes(); null here
              // makes the preliminary state explicit.
              orcidWorkType: work.type,
              type: null, // set definitively in classifyPublicationTypes()
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

    // Fetch detailed work info with limited concurrency to avoid throttling
    const results = await this.runWithConcurrencyLimit(detailPromises, 5);

    // Filter out nulls and collect publications
    results.forEach(pub => {
      if (pub) {
        publications.push(pub);
      }
    });

    // Note: Crossref enrichment and author consistency are handled later in
    // enrichAllPublications() and ensureAuthorConsistency() during the main
    // Collect → Merge → Enrich → Classify pipeline.
    return publications;
  }

  /**
   * Run an array of promises with a concurrency limit.
   * Accepts either promise values or thunks (functions returning promises).
   * JavaScript's single-threaded event loop ensures that the shared `index`
   * variable is accessed atomically: each worker only advances `index` while
   * it holds the JS thread (i.e. between `await` points), so there is no
   * actual race condition here.
   */
  async runWithConcurrencyLimit(tasks, limit) {
    const results = new Array(tasks.length);
    let index = 0; // shared cursor; safe because JS is single-threaded between awaits

    async function worker() {
      while (index < tasks.length) {
        const i = index++;
        const task = tasks[i];
        results[i] = await (typeof task === 'function' ? task() : task);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Ensure all publications have author information for display consistency
   * This is a last resort fallback - should only trigger if ORCID and Crossref both fail
   */
  ensureAuthorConsistency(publications) {
    const targetAuthor = this.config.authorName || 'Polvara';
    // Derive a "Surname I" style placeholder from the configured name
    // e.g. "Riccardo Polvara" → "Polvara R", "Polvara" → "Polvara"
    const nameParts = targetAuthor.trim().split(/\s+/);
    const placeholder = nameParts.length >= 2
      ? `${nameParts[nameParts.length - 1]} ${nameParts[0][0]}`
      : targetAuthor;
    let placeholderCount = 0;

    publications.forEach(pub => {
      // If no authors at all, add a placeholder with target author as absolute last resort
      if (!pub.authors ||
          (Array.isArray(pub.authors) && pub.authors.length === 0) ||
          (typeof pub.authors === 'string' && pub.authors.trim() === '')) {

        // Use a generic author entry based on ORCID profile
        pub.authors = [placeholder];
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

    // Try to enrich missing authors/venues using the full enrichment pipeline
    const needsRefresh = clone.filter(pub => this.needsMetadataRefresh(pub));
    if (needsRefresh.length > 0) {
      console.log(`Re-enriching ${needsRefresh.length} cached publications with missing metadata`);
      await this.enrichAllPublications(needsRefresh);
    }
    // Re-classify and ensure consistency in case evidence fields changed
    this.classifyPublicationTypes(clone);
    this.ensureAuthorConsistency(clone);

    if (this.config.useCache) {
      this.saveToCache(clone);
    }

    return clone;
  }

  /**
   * Enrich ALL publications (regardless of source) with metadata from Crossref,
   * Semantic Scholar, OpenAlex, etc.
   *
   * This replaces the previous approach of enriching arXiv pubs separately before
   * merge.  Running after merge means each publication already has all available
   * evidence fields (orcidWorkType, fromArXiv, …) before enrichment starts.
   *
   * Flow:
   *  1. Run Crossref enrichment for every pub that has a real (non-arXiv) DOI.
   *     Crossref is the most reliable source for venue/author/type data.
   *  2. For pubs that still need metadata (missing venue or weak authors), run
   *     the Semantic Scholar → OpenAlex → title-search waterfall.
   */
  async enrichAllPublications(publications) {
    console.log(`Starting enrichment for ${publications.length} publications`);

    // Step 1: Crossref enrichment for pubs with real DOIs
    await this.enrichWithCrossref(publications);

    // Step 2: Waterfall enrichment for pubs that still need metadata
    const needsWaterfall = publications.filter(pub => this.needsMetadataRefresh(pub));
    console.log(`Running waterfall enrichment for ${needsWaterfall.length} publications`);

    const enrichmentPromises = needsWaterfall.map(async (pub, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 100)); // rate limit
      try {
        const enriched = await this.enrichPublication(pub);
        if (!enriched && pub.needsEnrichment) {
          console.warn(`⚠ Could not enrich "${pub.title.substring(0, 50)}..." from any source`);
        }
      } catch (error) {
        console.warn(`Error enriching publication:`, error.message);
      }
    });

    await Promise.all(enrichmentPromises);
    console.log('Publication enrichment completed');
  }

  /**
   * @deprecated Use enrichAllPublications() instead.
   * Kept for any external callers; delegates to enrichAllPublications.
   */
  async enrichArXivPublications(publications) {
    return this.enrichAllPublications(publications);
  }

  needsMetadataRefresh(pub) {
    if (!pub) {
      return false;
    }

    // ArXiv publications or publications with DOIs can potentially be enriched
    if (!pub.doi && !pub.arxivId) {
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
   * Returns true when a DOI is an arXiv DOI (10.48550/arXiv.*).
   * arXiv DOIs do NOT indicate publication in a journal or conference;
   * they must not be treated as evidence of a "real" publication.
   */
  isArxivDoi(doi) {
    return typeof doi === 'string' && doi.toLowerCase().startsWith('10.48550/');
  }

  /**
   * Returns true when a venue string refers to arXiv itself (not a real publication venue).
   * Semantic Scholar returns "arXiv.org" or "arXiv" as the venue for preprints;
   * these must not be treated as publication evidence in any venue-based logic.
   */
  isArxivVenue(venue) {
    if (!venue || typeof venue !== 'string') return false;
    const v = venue.trim().toLowerCase();
    return v === 'arxiv' || v === 'arxiv.org' || v.startsWith('arxiv:') || v.startsWith('arxiv ');
  }

  /**
   * Enrich publications with Crossref metadata.
   * Skips arXiv DOIs (10.48550/…) — those are not published-work identifiers.
   * Stores the Crossref work type as `pub.crossrefWorkType` for use during the
   * final classification step (classifyPublicationTypes).
   */
  async enrichWithCrossref(publications) {
    const realDoiPubs = publications.filter(pub => pub.doi && !this.isArxivDoi(pub.doi));
    console.log(`Starting Crossref enrichment for ${realDoiPubs.length} publications with real DOIs`);

    const crossrefPromises = realDoiPubs
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

            // Store Crossref type as evidence for classifyPublicationTypes().
            // Do NOT set pub.type directly here; classification happens later.
            if (crossrefData.type && !pub.crossrefWorkType) {
              pub.crossrefWorkType = crossrefData.type; // 'journal' or 'conference'
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

    // Map Crossref work type to our categories
    let type = null;
    const crossrefType = work.type || '';
    if (crossrefType === 'journal-article') {
      type = 'journal';
    } else if (crossrefType === 'proceedings-article' || crossrefType === 'proceedings') {
      type = 'conference';
    }

    if ((authors && authors.length > 0) || venue) {
      return { authors, venue, type };
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
   * Fetch metadata from Semantic Scholar API
   */
  async fetchFromSemanticScholar(identifier) {
    // Identifier can be DOI, arXiv ID, or paper ID
    // Format: "DOI:10.xxxx/xxxx" or "arXiv:xxxx.xxxxx" or just the ID
    const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(identifier)}?fields=title,authors,venue,year,externalIds`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          return null; // Paper not found
        }
        throw new Error(`Semantic Scholar API error: ${response.status}`);
      }

      const data = await response.json();

      // Extract and format data
      let authors = null;
      if (data.authors && data.authors.length > 0) {
        authors = data.authors.map(a => a.name).filter(Boolean);
      }

      const venue = data.venue || null;

      // Extract DOI from externalIds so arXiv papers can be matched with their published version
      const doi = data.externalIds?.DOI || null;

      if ((authors && authors.length > 0) || venue || doi) {
        return { authors, venue, doi };
      }

      return null;
    } catch (error) {
      console.warn(`Semantic Scholar API error for ${identifier}:`, error.message);
      return null;
    }
  }

  /**
   * Search Semantic Scholar by author name to find author ID
   */
  async searchSemanticScholarAuthor(authorName) {
    const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(authorName)}&limit=5&fields=authorId,name,affiliations,paperCount`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        return null;
      }

      // Find best matching author
      return this.findBestAuthorMatch(data.data, authorName);
    } catch (error) {
      console.warn(`Semantic Scholar author search error:`, error.message);
      return null;
    }
  }

  /**
   * Find best matching author from search results
   */
  findBestAuthorMatch(authors, targetName) {
    // Calculate similarity score for each author
    const scored = authors.map(author => {
      const similarity = this.calculateNameSimilarity(author.name, targetName);
      return { author, similarity };
    });

    // Sort by similarity
    scored.sort((a, b) => b.similarity - a.similarity);

    // Return best match if similarity > 0.6
    if (scored[0] && scored[0].similarity > 0.6) {
      return scored[0].author;
    }

    return null;
  }

  /**
   * Calculate name similarity (simple token-based similarity)
   */
  calculateNameSimilarity(name1, name2) {
    const normalize = (str) => str.toLowerCase().replace(/[^a-z]/g, '');
    const n1 = normalize(name1);
    const n2 = normalize(name2);

    // Exact match
    if (n1 === n2) return 1.0;

    // Substring match
    if (n1.includes(n2) || n2.includes(n1)) return 0.9;

    // Token-based similarity
    const tokens1 = new Set(name1.toLowerCase().split(/\s+/));
    const tokens2 = new Set(name2.toLowerCase().split(/\s+/));

    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.size / union.size;
  }

  /**
   * Fetch all publications from Semantic Scholar for a given author
   */
  async fetchFromSemanticScholarAuthor() {
    const authorName = this.config.authorName;

    console.log(`Searching Semantic Scholar for author: ${authorName}`);

    // First, find the author ID
    const author = await this.searchSemanticScholarAuthor(authorName);

    if (!author || !author.authorId) {
      console.warn(`Could not find Semantic Scholar author ID for: ${authorName}`);
      return [];
    }

    console.log(`Found Semantic Scholar author: ${author.name} (ID: ${author.authorId}, ${author.paperCount} papers)`);

    try {
      // Fetch author's papers
      const url = `https://api.semanticscholar.org/graph/v1/author/${author.authorId}/papers?fields=paperId,title,year,authors,venue,externalIds&limit=500`;

      await new Promise(resolve => setTimeout(resolve, 150)); // Rate limiting
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Semantic Scholar API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        console.log('No papers found for this author');
        return [];
      }

      console.log(`Fetched ${data.data.length} papers from Semantic Scholar`);

      // Parse papers into publication format
      const publications = data.data
        .filter(paper => paper.title && paper.year) // Only include papers with title and year
        .map(paper => {
          // Extract DOI and arXiv ID if available
          let doi = null;
          let arxivId = null;

          if (paper.externalIds) {
            doi = paper.externalIds.DOI || null;
            arxivId = paper.externalIds.ArXiv || null;
          }

          // Parse authors
          let authors = null;
          if (paper.authors && paper.authors.length > 0) {
            authors = paper.authors.map(a => a.name).filter(Boolean);
          }

          // Infer publication type from venue
          let type = 'other'; // Default to preprint
          if (paper.venue) {
            const venueLower = paper.venue.toLowerCase();
            // Check for conference patterns
            if (venueLower.includes('conference') ||
                venueLower.includes('proceedings') ||
                venueLower.includes('workshop') ||
                venueLower.match(/\b(cvpr|iccv|eccv|icra|iros|rss|nips|neurips|icml|iclr|aaai|ijcai)\b/)) {
              type = 'conference';
            }
            // Check for journal patterns
            else if (venueLower.includes('journal') ||
                     venueLower.includes('transactions') ||
                     venueLower.includes('letters') ||
                     venueLower.match(/\b(ieee|acm|springer|elsevier|nature|science)\b/)) {
              type = 'journal';
            }
          }

          // Semantic Scholar returns "arXiv.org" or "arXiv" as the venue for preprints.
          // Storing this as pub.venue would make the classifier think it's a journal.
          // Null it out so only real publication venues are stored.
          const rawVenue = paper.venue && !this.isArxivVenue(paper.venue) ? paper.venue : null;

          return {
            source: 'semantic-scholar',
            // Mark as preprint if this paper has an arXiv ID but no real published DOI.
            // This ensures classifyPublicationTypes() catches it even when the arXiv API
            // independently missed this paper (source remains 'semantic-scholar').
            fromArXiv: arxivId != null && (doi == null || this.isArxivDoi(doi)) ? true : undefined,
            title: paper.title,
            year: paper.year,
            type: null, // set definitively in classifyPublicationTypes()
            authors: authors,
            venue: rawVenue,
            doi: doi,
            arxivId: arxivId,
            url: doi ? `https://doi.org/${doi}` : (arxivId ? `https://arxiv.org/abs/${arxivId}` : null),
            semanticScholarId: paper.paperId
          };
        });

      return publications;
    } catch (error) {
      console.error('Error fetching papers from Semantic Scholar:', error);
      return [];
    }
  }

  /**
   * Fetch metadata from OpenAlex API
   */
  async fetchFromOpenAlex(doi) {
    const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          return null; // Paper not found
        }
        throw new Error(`OpenAlex API error: ${response.status}`);
      }

      const data = await response.json();

      // Extract and format data
      let authors = null;
      if (data.authorships && data.authorships.length > 0) {
        authors = data.authorships
          .map(authorship => authorship.author?.display_name)
          .filter(Boolean);
      }

      // Get venue from primary_location or host_venue
      let venue = null;
      if (data.primary_location?.source?.display_name) {
        venue = data.primary_location.source.display_name;
      } else if (data.host_venue?.display_name) {
        venue = data.host_venue.display_name;
      }

      if ((authors && authors.length > 0) || venue) {
        return { authors, venue };
      }

      return null;
    } catch (error) {
      console.warn(`OpenAlex API error for DOI ${doi}:`, error.message);
      return null;
    }
  }

  /**
   * Search Semantic Scholar by title (fallback method)
   */
  async searchSemanticScholarByTitle(title) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&fields=title,authors,venue,year&limit=1`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        return null;
      }

      const paper = data.data[0];

      // Verify title similarity (basic check)
      const similarity = this.titleSimilarity(title, paper.title);
      if (similarity < 0.8) {
        console.warn(`Title mismatch: "${title}" vs "${paper.title}"`);
        return null;
      }

      let authors = null;
      if (paper.authors && paper.authors.length > 0) {
        authors = paper.authors.map(a => a.name).filter(Boolean);
      }

      const venue = paper.venue || null;

      if ((authors && authors.length > 0) || venue) {
        return { authors, venue };
      }

      return null;
    } catch (error) {
      console.warn(`Semantic Scholar title search error:`, error.message);
      return null;
    }
  }

  /**
   * Calculate simple title similarity (normalized Levenshtein-based)
   */
  titleSimilarity(title1, title2) {
    // Normalize titles
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const t1 = normalize(title1);
    const t2 = normalize(title2);

    // Simple substring matching as a heuristic
    if (t1 === t2) return 1.0;
    if (t1.includes(t2) || t2.includes(t1)) return 0.9;

    // Count matching characters
    const shorter = t1.length < t2.length ? t1 : t2;
    const longer = t1.length >= t2.length ? t1 : t2;

    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++;
    }

    return matches / longer.length;
  }

  /**
   * Enrich publications with multiple metadata sources (waterfall approach)
   * Priority order: Semantic Scholar → Crossref → OpenAlex → title search
   */
  async enrichPublication(pub) {
    // Try Semantic Scholar first by arXiv ID
    if (pub.arxivId) {
      try {
        const semanticData = await this.fetchFromSemanticScholar(`arXiv:${pub.arxivId}`);
        if (semanticData && this.isMetadataComplete(semanticData, pub)) {
          this.applyEnrichment(pub, semanticData, 'Semantic Scholar');
          return true;
        }
      } catch (error) {
        console.warn(`Semantic Scholar enrichment failed for arXiv:${pub.arxivId}`);
      }
    }

    // Try Semantic Scholar by DOI
    if (pub.doi) {
      try {
        await new Promise(resolve => setTimeout(resolve, 150)); // Rate limiting
        const semanticData = await this.fetchFromSemanticScholar(pub.doi);
        if (semanticData && this.isMetadataComplete(semanticData, pub)) {
          this.applyEnrichment(pub, semanticData, 'Semantic Scholar');
          return true;
        }
      } catch (error) {
        console.warn(`Semantic Scholar enrichment failed for DOI ${pub.doi}`);
      }
    }

    // Try Crossref for DOI-based publications
    if (pub.doi) {
      try {
        await new Promise(resolve => setTimeout(resolve, 150)); // Rate limiting
        const crossrefData = await this.fetchFromCrossrefWithRetry(pub.doi);
        if (crossrefData && this.isMetadataComplete(crossrefData, pub)) {
          this.applyEnrichment(pub, crossrefData, 'Crossref');
          return true;
        }
      } catch (error) {
        console.warn(`Crossref enrichment failed for DOI ${pub.doi}`);
      }
    }

    // Try OpenAlex by DOI
    if (pub.doi) {
      try {
        await new Promise(resolve => setTimeout(resolve, 150)); // Rate limiting
        const openAlexData = await this.fetchFromOpenAlex(pub.doi);
        if (openAlexData && this.isMetadataComplete(openAlexData, pub)) {
          this.applyEnrichment(pub, openAlexData, 'OpenAlex');
          return true;
        }
      } catch (error) {
        console.warn(`OpenAlex enrichment failed for DOI ${pub.doi}`);
      }
    }

    // Last resort: Search by title (only for publications that really need it)
    if (this.needsMetadataRefresh(pub) && pub.title) {
      try {
        await new Promise(resolve => setTimeout(resolve, 200)); // Extra rate limiting for search
        const titleSearchData = await this.searchSemanticScholarByTitle(pub.title);
        if (titleSearchData && this.isMetadataComplete(titleSearchData, pub)) {
          this.applyEnrichment(pub, titleSearchData, 'Semantic Scholar (title search)');
          return true;
        }
      } catch (error) {
        console.warn(`Title search enrichment failed for "${pub.title.substring(0, 50)}..."`);
      }
    }

    return false;
  }

  /**
   * Check if enriched metadata is complete enough to use
   */
  isMetadataComplete(metadata, currentPub) {
    if (!metadata) return false;

    const hasGoodAuthors = metadata.authors && metadata.authors.length > 1;
    const hasVenue = metadata.venue && metadata.venue.length > 0;

    const currentAuthorCount = this.countAuthors(currentPub.authors);
    const needsAuthors = !currentPub.authors || currentAuthorCount <= 1 || currentPub.hasPlaceholderAuthors;
    const needsVenue = !currentPub.venue && !currentPub.journalTitle;

    // Metadata is complete enough if it provides what we're missing
    return (hasGoodAuthors && needsAuthors) || (hasVenue && needsVenue);
  }

  /**
   * Apply enrichment data to publication
   */
  applyEnrichment(pub, metadata, source) {
    let enriched = false;

    if (metadata.authors && metadata.authors.length > 0) {
      const currentAuthorCount = this.countAuthors(pub.authors);
      if (!pub.authors || currentAuthorCount <= 1 || pub.hasPlaceholderAuthors || metadata.authors.length > currentAuthorCount) {
        pub.authors = metadata.authors;
        pub.hasPlaceholderAuthors = false;
        enriched = true;
      }
    }

    // Only propagate venue when it is a real (non-arXiv) venue.
    // Semantic Scholar returns "arXiv.org" as the venue for preprints; storing
    // that would make the classifier misidentify the paper as a journal article.
    if (metadata.venue && !this.isArxivVenue(metadata.venue) && (!pub.venue || !pub.journalTitle)) {
      pub.venue = metadata.venue;
      if (!pub.journalTitle) {
        pub.journalTitle = metadata.venue;
      }
      enriched = true;
    }

    // Propagate DOI only when it is a real (non-arXiv) DOI.
    // arXiv DOIs (10.48550/arXiv.*) returned by Semantic Scholar do NOT indicate
    // publication in a journal or conference and must not overwrite pub.doi.
    if (metadata.doi && !pub.doi && !this.isArxivDoi(metadata.doi)) {
      pub.doi = metadata.doi;
      enriched = true;
    }

    // Do NOT set pub.type directly from waterfall enrichment — type assignment is
    // deferred to classifyPublicationTypes() which uses all evidence at once.

    if (enriched) {
      console.log(`✓ Enriched "${pub.title.substring(0, 50)}..." with ${source} data`);
    }
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
    const url = `https://export.arxiv.org/api/query?search_query=au:${encodeURIComponent(author)}&max_results=100&sortBy=submittedDate&sortOrder=descending`;

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

      // Try to extract DOI from arXiv entry if present
      let doi = null;
      const doiElement = entry.querySelector('arxiv\\:doi, doi');
      if (doiElement) {
        doi = doiElement.textContent.trim();
      }

      const pub = {
        source: 'arxiv',
        fromArXiv: true, // explicit flag for classification; persists through merge
        title: title,
        year: year,
        type: null, // set definitively in classifyPublicationTypes()
        url: `https://arxiv.org/abs/${arxivId}`,
        arxivId: arxivId,
        authors: authors.length > 0 ? authors : null, // Keep as array for consistency
        abstract: summary,
        doi: doi,
        needsEnrichment: true // Flag arXiv entries for enrichment
      };

      publications.push(pub);
    });

    return publications;
  }

  /**
   * Merge publications from multiple sources and remove duplicates.
   *
   * Deduplication key priority: real DOI > arXiv ID > ORCID put-code > title+year.
   * arXiv DOIs (10.48550/…) are NOT used as keys — they fall through to arXiv ID.
   *
   * During merge, evidence fields collected from each source are accumulated on the
   * single surviving record so that classifyPublicationTypes() later has the full
   * picture.  The `source` field is NOT changed during merge (it retains the value
   * from the first-seen entry); instead, the `fromArXiv` boolean flag is set when
   * any version of the paper came from arXiv.
   */
  mergePublications(...sources) {
    const merged = [];
    const keyMap = new Map(); // Track which publications we've seen

    sources.forEach(source => {
      source.forEach(pub => {
        // Create a unique key for deduplication
        const key = this.createPublicationKey(pub);

        if (!keyMap.has(key)) {
          // First time seeing this publication — add to merged list
          keyMap.set(key, pub);
          merged.push(pub);
        } else {
          // Duplicate found — accumulate evidence onto the existing record
          const existing = keyMap.get(key);

          // Propagate arXiv identity
          if (pub.arxivId && !existing.arxivId) {
            existing.arxivId = pub.arxivId;
          }
          // Propagate fromArXiv flag so classification knows this paper was on arXiv
          if (pub.fromArXiv || pub.source === 'arxiv') {
            existing.fromArXiv = true;
          }

          // Propagate ORCID work type (authoritative for ORCID-sourced entries)
          if (pub.orcidWorkType && !existing.orcidWorkType) {
            existing.orcidWorkType = pub.orcidWorkType;
          }

          // Propagate ORCID put-code for URL resolution
          if (pub.putCode && !existing.putCode) {
            existing.putCode = pub.putCode;
          }

          // Propagate venue/journalTitle if existing lacks them — but NEVER propagate
          // arXiv-like venue strings ("arXiv.org", "arXiv") as they are not real venues
          if (pub.venue && !existing.venue && !this.isArxivVenue(pub.venue)) {
            existing.venue = pub.venue;
          }
          if (pub.journalTitle && !existing.journalTitle && !this.isArxivVenue(pub.journalTitle)) {
            existing.journalTitle = pub.journalTitle;
          }

          // Propagate real (non-arXiv) DOI if existing lacks one
          if (pub.doi && !existing.doi && !this.isArxivDoi(pub.doi)) {
            existing.doi = pub.doi;
          }

          // Propagate authors if existing has weak/no authors
          if (pub.authors) {
            const existingCount = this.countAuthors(existing.authors);
            const pubCount = this.countAuthors(pub.authors);
            if (!existing.authors || existing.hasPlaceholderAuthors ||
                pubCount > existingCount) {
              existing.authors = pub.authors;
              existing.hasPlaceholderAuthors = pub.hasPlaceholderAuthors || false;
            }
          }

          // Note: pub.type is NOT used here — classifyPublicationTypes() will
          // assign the definitive type using all accumulated evidence fields.
        }
      });
    });

    return merged;
  }

  /**
   * Classify publication types based on all collected evidence.
   *
   * This is the ONLY place where pub.type is set to its final value.
   * It runs after all sources have been collected, merged, and enriched so
   * every publication has the most complete evidence available.
   *
   * Classification priority:
   *  1. orcidWorkType  – most authoritative for ORCID-sourced publications
   *  2. crossrefWorkType – highly reliable for any published work
   *  3. venue text patterns – reliable inference for named venues
   *  4. real (non-arXiv) DOI – signals publication even if venue is unknown
   *  5. fromArXiv with no real DOI / venue → Preprint
   *  6. Default → journal (avoids false "Preprint" label for non-arXiv entries
   *     with incomplete metadata such as datasets or book chapters)
   */
  classifyPublicationTypes(publications) {
    publications.forEach(pub => {
      // 1. ORCID work type is the most authoritative source
      if (pub.orcidWorkType) {
        const mapped = this.mapORCIDType(pub.orcidWorkType);
        if (mapped === 'journal' || mapped === 'conference') {
          pub.type = mapped;
          return;
        }
      }

      // 2. Crossref work type — highly reliable for published works
      if (pub.crossrefWorkType === 'journal') {
        pub.type = 'journal';
        return;
      }
      if (pub.crossrefWorkType === 'conference') {
        pub.type = 'conference';
        return;
      }

      // 3. Infer from venue text — but skip arXiv-like venue strings ("arXiv.org", "arXiv")
      //    which Semantic Scholar uses for preprints and which are NOT publication venues.
      const venueStr = (pub.venue || pub.journalTitle || '').trim();
      if (venueStr && !this.isArxivVenue(venueStr)) {
        pub.type = this.conferenceVenuePattern.test(venueStr) ? 'conference' : 'journal';
        return;
      }

      // 4. Has a real (non-arXiv) DOI → published somewhere even if venue is unknown
      if (pub.doi && !this.isArxivDoi(pub.doi)) {
        pub.type = 'journal';
        return;
      }

      // 5. Preprint detection — any of these signals means exclusively an arXiv preprint:
      //    a. fromArXiv flag (set by arXiv parser, merge propagation, or S2 parser)
      //    b. source === 'arxiv'
      //    c. has arXiv ID but no real published DOI (catches Semantic Scholar-only entries)
      //    d. doi is an arXiv-only DOI (10.48550/…) — no real publication evidence
      const hasArxivId = pub.arxivId && typeof pub.arxivId === 'string' && pub.arxivId.trim() !== '';
      const hasRealDoi = pub.doi && !this.isArxivDoi(pub.doi);
      if (pub.fromArXiv || pub.source === 'arxiv' ||
          (hasArxivId && !hasRealDoi) ||
          (pub.doi && this.isArxivDoi(pub.doi))) {
        pub.type = 'other'; // Preprint
        return;
      }

      // 6. Default for non-arXiv pubs with incomplete metadata (datasets, book chapters, etc.)
      pub.type = 'journal';
    });
  }

  /**
   * @deprecated Use classifyPublicationTypes() instead.
   * Kept for backward compatibility; delegates to the new method.
   */
  normalizePublicationTypes(publications) {
    return this.classifyPublicationTypes(publications);
  }

  /**
   * Create a unique key for a publication (for deduplication).
   * Uses the single most stable identifier available so that the same paper
   * from different sources (e.g. ORCID and arXiv) always produces the same key
   * and gets correctly deduplicated.
   * Priority: real DOI > arXiv ID > ORCID put-code > normalised title+year
   *
   * arXiv DOIs (10.48550/…) are intentionally excluded from the DOI slot because
   * they do not identify a published work and would prevent cross-source matching.
   */
  createPublicationKey(pub) {
    // Real (non-arXiv) DOI is the most stable cross-source identifier
    if (pub && typeof pub.doi === 'string' && pub.doi.trim() !== '' &&
        !this.isArxivDoi(pub.doi)) {
      return `doi:${pub.doi.toLowerCase().trim()}`;
    }

    // arXiv ID as secondary identifier
    if (pub && typeof pub.arxivId === 'string' && pub.arxivId.trim() !== '') {
      return `arxiv:${pub.arxivId.toLowerCase().trim()}`;
    }

    // ORCID put-code as tertiary identifier
    if (pub && (typeof pub.putCode === 'string' || typeof pub.putCode === 'number')) {
      return `orcid:${String(pub.putCode)}`;
    }

    // Fallback: use normalized title and year
    const rawTitle = pub && typeof pub.title === 'string' ? pub.title : '';
    const normalizedTitle = rawTitle.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 50);
    const yearPart = pub && pub.year != null ? String(pub.year) : '';
    return `${normalizedTitle}-${yearPart}`;
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
   * Now displays all publications chronologically with type tags
   */
  renderPublications(publications, container) {
    // Create HTML with all publications in chronological order
    // Publications are already sorted by year (newest first) in fetchPublications
    let html = '<h3 class="pub-section-heading">Publications</h3>';
    html += '<ul class="pub-list">';
    html += publications.map(pub => this.renderPublicationItem(pub)).join('');
    html += '</ul>';

    // Insert into container
    if (container) {
      container.innerHTML = html;
    }

    return html;
  }

  /**
   * Render a single publication item
   * Now includes type tag (journal/conference/preprint) along with other links
   */
  renderPublicationItem(pub) {
    // Sanitize URL: only allow http/https schemes to prevent XSS (e.g. javascript: URLs)
    const rawUrl = pub.url || '';
    const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
    const title = this.escapeHtml(pub.title || 'Untitled');

    // Use venue field, fallback to journalTitle
    const venueText = pub.venue || pub.journalTitle;
    const venue = venueText ? `<em>${this.escapeHtml(venueText)}</em>` : '';

    // Build links including type tag
    let links = '';

    // Add type tag
    const typeLabel = this.getTypeLabel(pub.type);
    links += `<span class="pub-type-tag" data-type="${pub.type}">${typeLabel}</span>`;

    // Add URL link
    if (safeUrl !== '#') {
      if (pub.arxivId) {
        links += `<a href="${safeUrl}">arXiv</a>`;
      } else if (pub.doi) {
        links += `<a href="${safeUrl}">DOI</a>`;
      } else {
        links += `<a href="${safeUrl}">Link</a>`;
      }
    }

    // Format authors with highlighting
    const authorsHtml = this.formatAuthors(pub.authors);

    return `
      <li class="pub-item" data-type="${pub.type}">
        <span class="pub-year">${pub.year}</span>
        <div class="pub-content">
          <div class="pub-title">
            <a href="${safeUrl}">${title}</a>
          </div>
          ${authorsHtml ? `<div class="pub-authors">${authorsHtml}</div>` : ''}
          ${venue ? `<div class="pub-venue">${venue}</div>` : ''}
          ${links ? `<div class="pub-links">${links}</div>` : ''}
        </div>
      </li>
    `;
  }

  /**
   * Get human-readable label for publication type
   */
  getTypeLabel(type) {
    const typeLabels = {
      'journal': 'Journal',
      'conference': 'Conference',
      'other': 'Preprint'
    };
    return typeLabels[type] || 'Other';
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

    // Escape regex metacharacters in targetName so names with special chars don't break patterns
    const safeName = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Find and highlight all variations of the target name
    // This handles: "Polvara R", "R Polvara", "Polvara, R", "Riccardo Polvara", etc.
    const patterns = [
      new RegExp(`\\b${safeName}\\s+[A-Z]\\b`, 'gi'),  // "Polvara R"
      new RegExp(`\\b[A-Z]\\s+${safeName}\\b`, 'gi'),  // "R Polvara"
      new RegExp(`\\b${safeName},?\\s+[A-Z]\\.?\\b`, 'gi'),  // "Polvara, R" or "Polvara R."
      new RegExp(`\\b[A-Z]\\.?\\s+${safeName}\\b`, 'gi'),  // "R. Polvara"
      new RegExp(`\\b\\w+\\s+${safeName}\\b`, 'gi'),  // "Riccardo Polvara"
      new RegExp(`\\b${safeName}\\s+\\w+\\b`, 'gi'),  // "Polvara Riccardo"
      new RegExp(`\\b${safeName}\\b`, 'gi')  // Just "Polvara"
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
