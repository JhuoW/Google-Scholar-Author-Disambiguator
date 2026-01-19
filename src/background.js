// Scholar Disambiguator - Background Service Worker
// Handles fetch requests to avoid CORS issues in content scripts

'use strict';

/**
 * Construct the Google Scholar author search URL
 * @param {string} authorName - The author name to search for
 * @param {string} afterToken - Optional pagination token
 * @returns {string} The search URL
 */
function buildSearchUrl(authorName, afterToken = null) {
  let url = `https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(authorName)}`;
  if (afterToken) {
    // Check token format and add appropriate parameter
    if (afterToken.startsWith('cstart:')) {
      url += `&cstart=${afterToken.substring(7)}`;
    } else if (/^\d+$/.test(afterToken)) {
      url += `&start=${afterToken}`;
    } else {
      url += `&after_author=${afterToken}`;
    }
  }
  return url;
}

/**
 * Extract the "after_author" token for next page from HTML
 * @param {string} html - The HTML string
 * @returns {string|null} The after_author token or null if no more pages
 */
function extractNextPageToken(html) {
  // Decode HTML entities first (Google Scholar often encodes & as &amp;)
  const decodedHtml = html.replace(/&amp;/g, '&');

  // Pattern 1: Look for after_author in any link/button (use decoded HTML)
  let match = decodedHtml.match(/after_author=([^&"'\s><]+)/g);
  if (match && match.length > 0) {
    // Get the last occurrence (usually the "Next" button)
    const lastMatch = match[match.length - 1];
    const tokenMatch = lastMatch.match(/after_author=([^&"'\s><]+)/);
    if (tokenMatch) {
      console.log('[Scholar Disambiguator] Found after_author token:', tokenMatch[1]);
      return tokenMatch[1];
    }
  }

  // Pattern 2: Look for cstart parameter (citation start)
  match = decodedHtml.match(/cstart=(\d+)/);
  if (match) {
    console.log('[Scholar Disambiguator] Found cstart token:', match[1]);
    return 'cstart:' + match[1];
  }

  // Pattern 3: Look for start parameter with value > 0
  match = decodedHtml.match(/[?&]start=(\d+)/g);
  if (match && match.length > 0) {
    const lastMatch = match[match.length - 1];
    const numMatch = lastMatch.match(/start=(\d+)/);
    if (numMatch && parseInt(numMatch[1]) > 0) {
      console.log('[Scholar Disambiguator] Found start token:', numMatch[1]);
      return numMatch[1];
    }
  }

  // Pattern 4: Look for Next button onclick with JavaScript
  match = decodedHtml.match(/gs_btnPR[^>]*onclick="[^"]*after_author=([^&"']+)/);
  if (match) {
    console.log('[Scholar Disambiguator] Found onclick token:', match[1]);
    return match[1];
  }

  // Pattern 5: Look for next page link in navigation buttons (href or onclick)
  // Google Scholar uses buttons with navigation like: onclick="window.location='...&after_author=TOKEN...'"
  const nextBtnMatch = decodedHtml.match(/gs_btnPR[^>]*(?:href|onclick)=[^>]*(?:after_author|start)=([^&"'\\]+)/);
  if (nextBtnMatch) {
    console.log('[Scholar Disambiguator] Found next button token:', nextBtnMatch[1]);
    return nextBtnMatch[1];
  }

  // Pattern 6: Look for any navigation link containing after_author near "Next" or navigation buttons
  const navMatch = decodedHtml.match(/(?:gs_btnPR|Next|下一页)[^<]*<[^>]+(?:href|onclick)=[^>]*after_author=([^&"'\\]+)/i);
  if (navMatch) {
    console.log('[Scholar Disambiguator] Found nav link token:', navMatch[1]);
    return navMatch[1];
  }

  // Check if there's a "Next" button at all (for debugging)
  const hasNextButton = html.includes('gs_btnPR') ||
                        html.includes('>Next<') ||
                        html.includes('aria-label="Next"') ||
                        html.includes('下一页');
  console.log('[Scholar Disambiguator] Has next button:', hasNextButton);

  // If there's a next button but we couldn't extract token, log for debugging
  if (hasNextButton) {
    // Look for gs_btnPR and log surrounding context
    const btnIndex = html.indexOf('gs_btnPR');
    if (btnIndex > -1) {
      // Get 500 chars before and after for more context
      const startIdx = Math.max(0, btnIndex - 100);
      const endIdx = Math.min(html.length, btnIndex + 400);
      console.log('[Scholar Disambiguator] Next button context:', html.substring(startIdx, endIdx));
    }

    // Also check for any href with after_author anywhere in the document
    const anyAfterAuthor = html.match(/after_author[^"'<>]{0,100}/);
    if (anyAfterAuthor) {
      console.log('[Scholar Disambiguator] Found after_author pattern:', anyAfterAuthor[0]);
    }
  }

  return null;
}

/**
 * Check if the page has any author results
 * @param {string} html - The HTML string
 * @returns {boolean} True if results exist
 */
function hasResults(html) {
  return html.includes('gsc_1usr');
}

/**
 * Fetch author search results from Google Scholar (single page)
 * @param {string} authorName - The author name to search for
 * @param {string} afterToken - Optional pagination token for next page
 * @returns {Promise<Object>} Result object with HTML, next token, or error
 */
async function fetchAuthorSearch(authorName, afterToken = null) {
  const url = buildSearchUrl(authorName, afterToken);

  console.log('[Scholar Disambiguator] Searching for:', authorName);
  console.log('[Scholar Disambiguator] URL:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include'
    });

    if (!response.ok) {
      if (response.status === 429) {
        return {
          success: false,
          error: 'rate_limited',
          message: 'Google Scholar is limiting requests. Please try again in a few minutes.'
        };
      }
      return {
        success: false,
        error: 'network_error',
        message: `HTTP error: ${response.status}`
      };
    }

    const html = await response.text();

    // Check for CAPTCHA page
    if (html.includes('Please show you') || html.includes('unusual traffic')) {
      return {
        success: false,
        error: 'captcha',
        message: 'Google Scholar is requesting CAPTCHA verification. Please visit Google Scholar directly and complete the verification.'
      };
    }

    // Extract next page token
    const nextToken = hasResults(html) ? extractNextPageToken(html) : null;

    console.log('[Scholar Disambiguator] Fetch successful, nextToken:', nextToken ? 'yes' : 'no');

    return {
      success: true,
      html,
      nextToken
    };
  } catch (e) {
    console.error('[Scholar Disambiguator] Fetch error:', e);
    return {
      success: false,
      error: 'network_error',
      message: 'Unable to connect. Check your internet connection.'
    };
  }
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'searchAuthors') {
    fetchAuthorSearch(request.authorName, request.afterToken)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({
        success: false,
        error: 'unknown',
        message: error.message
      }));

    // Return true to indicate we will send response asynchronously
    return true;
  }
});

console.log('[Scholar Disambiguator] Background service worker initialized');
