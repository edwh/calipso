/**
 * Gmail content script adapter
 * Runs in the context of Gmail pages to extract email data
 */

console.log('Unified Calendar: Gmail adapter loaded');

// Track current account from URL
function getAccountIndex() {
  const match = window.location.pathname.match(/\/u\/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

// Track if we're on Gmail
function isGmailPage() {
  return window.location.hostname === 'mail.google.com';
}

// Message listener for commands from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_GMAIL_INFO') {
    sendResponse({
      isGmail: isGmailPage(),
      accountIndex: getAccountIndex(),
      url: window.location.href
    });
    return true;
  }

  if (message.type === 'GET_EMAIL_LIST') {
    getEmailList(message.options).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_EMAIL_CONTENT') {
    getEmailContent(message.emailId).then(sendResponse);
    return true;
  }

  if (message.type === 'SCAN_VISIBLE_EMAILS') {
    scanVisibleEmails(message.options || {}).then(sendResponse);
    return true;
  }
});

/**
 * Get list of emails from current view
 * @param {Object} options - Filter options
 * @returns {Promise<Array>}
 */
async function getEmailList(options = {}) {
  const emails = [];

  // Try to find email rows in the Gmail UI
  // Gmail's DOM structure changes, so we try multiple selectors
  const selectors = [
    'tr.zA', // Main inbox row
    'div[role="row"]', // Alternate structure
    '.aDP.bq' // Another variation
  ];

  let rows = [];
  for (const selector of selectors) {
    rows = document.querySelectorAll(selector);
    if (rows.length > 0) break;
  }

  for (const row of rows) {
    try {
      const email = extractEmailFromRow(row);
      if (email) {
        emails.push(email);
      }
    } catch (error) {
      console.warn('Failed to extract email from row:', error);
    }
  }

  return emails;
}

/**
 * Extract email metadata from a Gmail row element
 * @param {Element} row
 * @returns {Object|null}
 */
function extractEmailFromRow(row) {
  // Try to get email ID from data attributes or href
  const link = row.querySelector('a[href*="#"]');
  const href = link?.getAttribute('href') || '';
  const idMatch = href.match(/#[^/]+\/([^/]+)/);
  const emailId = idMatch ? idMatch[1] : row.getAttribute('data-message-id');

  // Get subject
  const subjectEl = row.querySelector('.y6 span, .bog, [data-thread-id]');
  const subject = subjectEl?.textContent?.trim() || 'No Subject';

  // Get sender
  const senderEl = row.querySelector('.yW span[email], .yP, .zF');
  const from = senderEl?.getAttribute('email') || senderEl?.textContent?.trim() || 'Unknown';

  // Get date (relative or absolute)
  const dateEl = row.querySelector('.xW span, .bq3');
  const dateText = dateEl?.textContent?.trim() || dateEl?.getAttribute('title') || '';

  // Get snippet
  const snippetEl = row.querySelector('.y2, .Zs');
  const snippet = snippetEl?.textContent?.trim() || '';

  if (!emailId && !subject) return null;

  return {
    id: emailId || `row-${Date.now()}-${Math.random()}`,
    subject,
    from,
    dateText,
    snippet,
    isUnread: row.classList.contains('zE'),
    isStarred: row.querySelector('.T-KT-Jp') !== null
  };
}

/**
 * Get full email content by ID
 * This requires navigating to the email or using Gmail's internal API
 * @param {string} emailId
 * @returns {Promise<Object>}
 */
async function getEmailContent(emailId) {
  // This is a simplified version - full implementation would use
  // Gmail's internal APIs or navigate to the email

  // For now, try to get content if email is currently open
  const openEmail = document.querySelector('.a3s.aiL, .ii.gt');
  if (!openEmail) {
    return { error: 'Email not currently open' };
  }

  const body = openEmail.textContent || '';

  // Get header info
  const headerEl = document.querySelector('.ha h2, .gE.iv.gt');
  const subject = headerEl?.textContent || '';

  const fromEl = document.querySelector('.gD[email], .go');
  const from = fromEl?.getAttribute('email') || fromEl?.textContent || '';

  const toEl = document.querySelector('.g2');
  const to = toEl?.textContent || '';

  const dateEl = document.querySelector('.g3, .gK');
  const date = dateEl?.textContent || dateEl?.getAttribute('title') || '';

  return {
    id: emailId,
    subject,
    from,
    to,
    date,
    body: body.substring(0, 10000), // Limit body size
    threadId: getThreadId()
  };
}

/**
 * Get current thread ID from URL
 * @returns {string|null}
 */
function getThreadId() {
  const match = window.location.hash.match(/#[^/]+\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Parse Gmail's date text into a Date object
 * Gmail shows dates like "Jan 25", "9/20/22", "3:45 PM", "Yesterday"
 * @param {string} dateText
 * @returns {Date|null}
 */
function parseGmailDate(dateText) {
  if (!dateText) return null;

  const now = new Date();
  const text = dateText.trim();

  // Time only (today): "3:45 PM"
  const timeMatch = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (timeMatch) {
    const date = new Date(now);
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const ampm = timeMatch[3]?.toUpperCase();
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  // "Yesterday"
  if (text.toLowerCase() === 'yesterday') {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return date;
  }

  // Month and day: "Jan 25"
  const monthDayMatch = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i);
  if (monthDayMatch) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2]);
    const date = new Date(now.getFullYear(), month, day);
    // If date is in future, it's probably last year
    if (date > now) {
      date.setFullYear(date.getFullYear() - 1);
    }
    return date;
  }

  // Full date: "9/20/22" or "9/20/2022" or "12/1/25"
  const fullDateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (fullDateMatch) {
    const month = parseInt(fullDateMatch[1]) - 1;
    const day = parseInt(fullDateMatch[2]);
    let year = parseInt(fullDateMatch[3]);
    if (year < 100) {
      year += year > 50 ? 1900 : 2000;
    }
    return new Date(year, month, day);
  }

  return null;
}

/**
 * Scan all visible emails and return basic metadata
 * @param {Object} options - Filter options
 * @param {number} options.lookbackDays - Only include emails from last N days
 * @returns {Promise<Object>}
 */
async function scanVisibleEmails(options = {}) {
  const emails = await getEmailList();
  const lookbackDays = options.lookbackDays || 30;

  // Calculate cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
  cutoffDate.setHours(0, 0, 0, 0);

  // Filter emails by date
  const filteredEmails = emails.map(email => {
    const parsedDate = parseGmailDate(email.dateText);
    return {
      ...email,
      parsedDate: parsedDate?.toISOString() || null
    };
  }).filter(email => {
    if (!email.parsedDate) return false;
    const emailDate = new Date(email.parsedDate);
    return emailDate >= cutoffDate;
  });

  return {
    accountIndex: getAccountIndex(),
    emailCount: filteredEmails.length,
    totalVisible: emails.length,
    cutoffDate: cutoffDate.toISOString(),
    emails: filteredEmails.slice(0, 50) // Limit to first 50
  };
}

/**
 * Scroll to load more emails (for background scanning)
 * @returns {Promise<void>}
 */
async function scrollToLoadMore() {
  const scrollContainer = document.querySelector('.AO, .aeF');
  if (!scrollContainer) return;

  const currentScroll = scrollContainer.scrollTop;
  scrollContainer.scrollTop = scrollContainer.scrollHeight;

  // Wait for new content to load
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Navigate to a specific email by ID
 * @param {string} emailId
 */
function navigateToEmail(emailId) {
  // This would trigger navigation in Gmail
  // For now, we'll rely on the user having emails open
  window.location.hash = `#inbox/${emailId}`;
}

// Notify background script that adapter is ready
chrome.runtime.sendMessage({
  type: 'GMAIL_ADAPTER_READY',
  accountIndex: getAccountIndex()
});
