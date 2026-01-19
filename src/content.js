// Scholar Disambiguator - Content Script
// Runs on Google Scholar profile pages to extract author information

(function() {
  'use strict';

  // Store current page info
  let currentUserId = null;
  let currentAuthorName = null;
  let sidebarContainer = null;
  let currentPage = 1;
  let lastSearchTime = 0;
  let isCollapsed = false;

  // Results storage
  let allAuthors = []; // All fetched authors
  let nextPageToken = null; // Token for fetching next page from Google Scholar
  let isLoadingMore = false; // Flag to prevent multiple simultaneous fetches

  // Constants
  const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  const MIN_SEARCH_DELAY_MS = 2000; // 2 seconds between searches
  const CACHE_KEY_PREFIX = 'sd_cache_';
  const RESULTS_PER_PAGE = 10; // Results per UI page

  /**
   * Extract the user ID from the current URL
   */
  function extractUserId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('user');
  }

  /**
   * Extract the author name from the profile page
   * Handles names with non-Latin characters like "Jia Wang (王佳)" or "Xing Xie 谢幸"
   * Returns only the English/Latin part of the name
   */
  function extractAuthorName() {
    const nameElement = document.querySelector('#gsc_prf_in');
    if (!nameElement) return null;

    let fullName = nameElement.textContent.trim();

    // Remove content in parentheses (often contains Chinese name)
    fullName = fullName.replace(/\s*\([^)]*\)\s*/g, ' ');

    // Extract only Latin characters, spaces, hyphens, and periods
    // This handles names like "Xing Xie 谢幸" -> "Xing Xie"
    const latinMatch = fullName.match(/^[A-Za-z\s.\-']+/);
    if (latinMatch) {
      return latinMatch[0].trim();
    }

    // Fallback: return cleaned full name
    return fullName.trim();
  }

  /**
   * Extract user ID from a profile URL
   */
  function extractUserIdFromUrl(url) {
    const match = url.match(/[?&]user=([^&]+)/);
    return match ? match[1] : null;
  }

  // ==================== CACHING ====================

  function getCacheKey(authorName) {
    return CACHE_KEY_PREFIX + encodeURIComponent(authorName.toLowerCase());
  }

  function getCachedResults(authorName) {
    try {
      const key = getCacheKey(authorName);
      const cached = sessionStorage.getItem(key);
      if (!cached) return null;

      const data = JSON.parse(cached);
      if (Date.now() - data.timestamp > CACHE_DURATION_MS) {
        sessionStorage.removeItem(key);
        return null;
      }

      console.log('[Scholar Disambiguator] Using cached results');
      return data;
    } catch (e) {
      return null;
    }
  }

  function cacheResults(authorName, authors, nextToken) {
    try {
      const key = getCacheKey(authorName);
      const data = {
        timestamp: Date.now(),
        authors,
        nextToken
      };
      sessionStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.error('[Scholar Disambiguator] Cache write error:', e);
    }
  }

  // ==================== RATE LIMITING ====================

  function getRateLimitDelay() {
    const elapsed = Date.now() - lastSearchTime;
    return elapsed < MIN_SEARCH_DELAY_MS ? MIN_SEARCH_DELAY_MS - elapsed : 0;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== PARSING ====================

  function parseSearchResults(html) {
    const authors = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const authorCards = doc.querySelectorAll('.gsc_1usr');

    for (const card of authorCards) {
      try {
        const nameElement = card.querySelector('.gs_ai_name a');
        if (!nameElement) continue;

        const name = nameElement.textContent.trim();
        const profileUrl = nameElement.getAttribute('href');
        const fullProfileUrl = profileUrl.startsWith('http')
          ? profileUrl
          : `https://scholar.google.com${profileUrl}`;

        const userId = extractUserIdFromUrl(fullProfileUrl);

        const affiliationElement = card.querySelector('.gs_ai_aff');
        const affiliation = affiliationElement ? affiliationElement.textContent.trim() : '';

        const emailElement = card.querySelector('.gs_ai_eml');
        let emailDomain = null;
        if (emailElement) {
          const emailMatch = emailElement.textContent.match(/at\s+(.+)$/i);
          emailDomain = emailMatch ? emailMatch[1] : null;
        }

        const citationElement = card.querySelector('.gs_ai_cby');
        let citationCount = null;
        if (citationElement) {
          const citationMatch = citationElement.textContent.match(/(\d+)/);
          citationCount = citationMatch ? parseInt(citationMatch[1], 10) : null;
        }

        // Extract thumbnail
        const thumbnailElement = card.querySelector('.gs_ai_pho img');
        let thumbnailUrl = null;
        if (thumbnailElement) {
          thumbnailUrl = thumbnailElement.getAttribute('src');
          // Convert relative URLs to absolute
          if (thumbnailUrl && !thumbnailUrl.startsWith('http')) {
            thumbnailUrl = `https://scholar.google.com${thumbnailUrl}`;
          }
        }

        authors.push({
          name,
          affiliation,
          profileUrl: fullProfileUrl,
          userId,
          emailDomain,
          citationCount,
          thumbnailUrl
        });
      } catch (e) {
        console.error('[Scholar Disambiguator] Error parsing author card:', e);
      }
    }

    return authors;
  }

  // ==================== API ====================

  function fetchAuthorSearch(authorName, afterToken = null) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'searchAuthors', authorName, afterToken },
        response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Fetch initial search results
   */
  async function searchAuthors(authorName, skipCache = false) {
    // Check cache
    if (!skipCache) {
      const cached = getCachedResults(authorName);
      if (cached) {
        allAuthors = cached.authors;
        nextPageToken = cached.nextToken;
        return { success: true, authors: cached.authors };
      }
    }

    // Rate limiting
    const waitTime = getRateLimitDelay();
    if (waitTime > 0) {
      await delay(waitTime);
    }
    lastSearchTime = Date.now();

    // Fetch from Google Scholar
    const result = await fetchAuthorSearch(authorName);

    if (!result.success) {
      return result;
    }

    // Parse and store results
    const authors = parseSearchResults(result.html);
    const filteredAuthors = authors.filter(a => a.userId !== currentUserId);

    allAuthors = filteredAuthors;
    nextPageToken = result.nextToken;

    // Cache results
    cacheResults(authorName, filteredAuthors, result.nextToken);

    console.log('[Scholar Disambiguator] Found', filteredAuthors.length, 'authors, hasMore:', !!nextPageToken);

    return { success: true, authors: filteredAuthors };
  }

  /**
   * Fetch more results (next page from Google Scholar)
   */
  async function loadMoreAuthors() {
    if (!nextPageToken || isLoadingMore) {
      return { success: false, message: 'No more results' };
    }

    isLoadingMore = true;
    console.log('[Scholar Disambiguator] Loading more authors...');

    try {
      // Rate limiting
      const waitTime = getRateLimitDelay();
      if (waitTime > 0) {
        await delay(waitTime);
      }
      lastSearchTime = Date.now();

      const result = await fetchAuthorSearch(currentAuthorName, nextPageToken);

      if (!result.success) {
        return result;
      }

      // Parse and add new results
      const newAuthors = parseSearchResults(result.html);
      const filteredNew = newAuthors.filter(a => a.userId !== currentUserId);

      allAuthors = [...allAuthors, ...filteredNew];
      nextPageToken = result.nextToken;

      // Update cache
      cacheResults(currentAuthorName, allAuthors, nextPageToken);

      console.log('[Scholar Disambiguator] Loaded', filteredNew.length, 'more authors, total:', allAuthors.length);

      return { success: true, newCount: filteredNew.length };
    } finally {
      isLoadingMore = false;
    }
  }

  // ==================== UI FUNCTIONS ====================

  function createSidebar() {
    const sidebarSelectors = ['#gsc_rsb', '#gsc_prf_w', '.gsc_rsb', '#gs_bdy'];
    let sidebar = null;

    for (const selector of sidebarSelectors) {
      sidebar = document.querySelector(selector);
      if (sidebar) break;
    }

    const container = document.createElement('div');
    container.className = 'sd-container';
    container.id = 'sd-sidebar';

    if (sidebar) {
      sidebar.insertBefore(container, sidebar.firstChild);
    } else {
      container.classList.add('sd-floating');
      document.body.appendChild(container);
    }

    return container;
  }

  function renderInitialState() {
    if (!sidebarContainer) return;

    // Check cache for existing results
    const cached = getCachedResults(currentAuthorName);
    if (cached && cached.authors.length > 0) {
      allAuthors = cached.authors;
      nextPageToken = cached.nextToken;
      renderResultsState();
      return;
    }

    sidebarContainer.innerHTML = `
      <div class="sd-header">
        <span>Similar Authors</span>
      </div>
      <button class="sd-button" id="sd-search-btn">
        Find authors with same name
      </button>
      <div class="sd-hint">
        Click to search for other "${escapeHtml(currentAuthorName)}" profiles
      </div>
    `;

    sidebarContainer.querySelector('#sd-search-btn').addEventListener('click', handleSearchClick);
  }

  function renderLoadingState() {
    if (!sidebarContainer) return;
    sidebarContainer.innerHTML = `
      <div class="sd-header"><span>Similar Authors</span></div>
      <div class="sd-loading">Searching...</div>
    `;
  }

  function renderResultsState() {
    if (!sidebarContainer) return;

    const totalCount = allAuthors.length;
    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);
    const startIndex = (currentPage - 1) * RESULTS_PER_PAGE;
    const endIndex = Math.min(startIndex + RESULTS_PER_PAGE, totalCount);
    const displayAuthors = allAuthors.slice(startIndex, endIndex);

    // Check if we need to load more (on last page and more available)
    const isLastPage = currentPage === totalPages;
    const hasMoreFromServer = !!nextPageToken;

    let html = `
      <div class="sd-header">
        <span>Similar Authors (${totalCount}${hasMoreFromServer ? '+' : ''} found)</span>
        <button class="sd-toggle" id="sd-toggle-btn" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '+' : '-'}</button>
      </div>
    `;

    if (!isCollapsed) {
      html += '<ul class="sd-results">';

      for (const author of displayAuthors) {
        const affiliation = author.affiliation || 'Affiliation not listed';
        const citations = author.citationCount !== null
          ? `Cited by ${author.citationCount.toLocaleString()}`
          : '';
        const thumbnail = author.thumbnailUrl
          ? `<img class="sd-author-thumb" src="${escapeHtml(author.thumbnailUrl)}" alt="">`
          : '<div class="sd-author-thumb sd-author-thumb-placeholder"></div>';

        html += `
          <li class="sd-author-card">
            ${thumbnail}
            <div class="sd-author-info">
              <a class="sd-author-name" href="${escapeHtml(author.profileUrl)}" target="_blank">
                ${escapeHtml(author.name)}
              </a>
              <div class="sd-author-affiliation">${escapeHtml(affiliation)}</div>
              ${citations ? `<div class="sd-author-citations">${citations}</div>` : ''}
            </div>
          </li>
        `;
      }

      html += '</ul>';

      // Pagination
      if (totalPages > 1 || hasMoreFromServer) {
        html += '<div class="sd-pagination">';
        html += `<button class="sd-page-btn" id="sd-prev-btn" ${currentPage === 1 ? 'disabled' : ''}>Prev</button>`;

        html += '<span class="sd-page-info">';
        for (let i = 1; i <= totalPages; i++) {
          html += `<span class="sd-page-num ${i === currentPage ? 'sd-page-current' : ''}" data-page="${i}">${i}</span>`;
        }
        if (hasMoreFromServer) {
          html += '<span class="sd-page-num sd-page-more" id="sd-load-more">...</span>';
        }
        html += '</span>';

        const canGoNext = currentPage < totalPages || hasMoreFromServer;
        html += `<button class="sd-page-btn" id="sd-next-btn" ${!canGoNext ? 'disabled' : ''}>Next</button>`;
        html += '</div>';
      }

      html += `<button class="sd-refresh" id="sd-refresh-btn">Refresh results</button>`;
    }

    sidebarContainer.innerHTML = html;

    // Event listeners
    sidebarContainer.querySelector('#sd-toggle-btn').addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      renderResultsState();
    });

    if (!isCollapsed) {
      const prevBtn = sidebarContainer.querySelector('#sd-prev-btn');
      const nextBtn = sidebarContainer.querySelector('#sd-next-btn');
      const pageNums = sidebarContainer.querySelectorAll('.sd-page-num:not(.sd-page-more)');
      const loadMoreBtn = sidebarContainer.querySelector('#sd-load-more');
      const refreshBtn = sidebarContainer.querySelector('#sd-refresh-btn');

      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (currentPage > 1) {
            currentPage--;
            renderResultsState();
          }
        });
      }

      if (nextBtn) {
        nextBtn.addEventListener('click', async () => {
          const totalPages = Math.ceil(allAuthors.length / RESULTS_PER_PAGE);
          if (currentPage < totalPages) {
            currentPage++;
            renderResultsState();
          } else if (nextPageToken) {
            // Need to load more from server
            await handleLoadMore();
          }
        });
      }

      pageNums.forEach(el => {
        el.addEventListener('click', () => {
          const page = parseInt(el.dataset.page, 10);
          if (page !== currentPage) {
            currentPage = page;
            renderResultsState();
          }
        });
      });

      if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', handleLoadMore);
      }

      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => handleSearchClick(true));
      }
    }
  }

  async function handleLoadMore() {
    if (isLoadingMore) return;

    // Show loading indicator
    const loadMoreBtn = sidebarContainer.querySelector('#sd-load-more');
    const nextBtn = sidebarContainer.querySelector('#sd-next-btn');
    if (loadMoreBtn) loadMoreBtn.textContent = '...';
    if (nextBtn) nextBtn.disabled = true;

    const result = await loadMoreAuthors();

    if (result.success) {
      currentPage++;
      renderResultsState();
    } else {
      // Restore UI
      if (loadMoreBtn) loadMoreBtn.textContent = '...';
      if (nextBtn) nextBtn.disabled = false;
    }
  }

  function renderNoResultsState() {
    if (!sidebarContainer) return;
    sidebarContainer.innerHTML = `
      <div class="sd-header"><span>Similar Authors</span></div>
      <div class="sd-no-results">No other authors found with this name.</div>
      <button class="sd-refresh" id="sd-refresh-btn">Search again</button>
    `;
    sidebarContainer.querySelector('#sd-refresh-btn').addEventListener('click', () => handleSearchClick(true));
  }

  function renderErrorState(message, errorType) {
    if (!sidebarContainer) return;

    let helpText = '';
    if (errorType === 'rate_limited' || errorType === 'captcha') {
      helpText = '<div class="sd-hint">Try again in a few minutes.</div>';
    }

    sidebarContainer.innerHTML = `
      <div class="sd-header"><span>Similar Authors</span></div>
      <div class="sd-error">${escapeHtml(message)}</div>
      ${helpText}
      <button class="sd-button" id="sd-retry-btn">Try again</button>
    `;
    sidebarContainer.querySelector('#sd-retry-btn').addEventListener('click', () => handleSearchClick(true));
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function handleSearchClick(skipCache = false) {
    if (!currentAuthorName) return;

    currentPage = 1;
    allAuthors = [];
    nextPageToken = null;
    renderLoadingState();

    try {
      const result = await searchAuthors(currentAuthorName, skipCache);

      if (result.success) {
        if (allAuthors.length === 0) {
          renderNoResultsState();
        } else {
          renderResultsState();
        }
      } else {
        renderErrorState(result.message, result.error);
      }
    } catch (error) {
      renderErrorState('An unexpected error occurred.', 'unknown');
    }
  }

  // ==================== INITIALIZATION ====================

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady);
    } else {
      onReady();
    }
  }

  function onReady() {
    currentUserId = extractUserId();
    currentAuthorName = extractAuthorName();

    console.log('[Scholar Disambiguator] Extension loaded');
    console.log('[Scholar Disambiguator] User ID:', currentUserId);
    console.log('[Scholar Disambiguator] Author Name:', currentAuthorName);

    if (!currentAuthorName || !currentUserId) return;

    sidebarContainer = createSidebar();
    if (sidebarContainer) {
      renderInitialState();
    }

    window.scholarDisambiguator = {
      search: handleSearchClick,
      loadMore: loadMoreAuthors,
      clearCache: () => sessionStorage.removeItem(getCacheKey(currentAuthorName))
    };
  }

  init();
})();
