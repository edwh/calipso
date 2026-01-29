/**
 * Calendar content script
 * Runs on Google Calendar pages to extract calendar events
 */

console.log('Unified Calendar: Calendar script loaded');

// Message listener for commands from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCRAPE_CALENDAR_EVENTS') {
    scrapeCalendarEvents().then(sendResponse);
    return true;
  }

  if (message.type === 'NAVIGATE_NEXT_WEEK') {
    navigateNextWeek().then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_CALENDAR_PAGE') {
    sendResponse({
      isCalendar: isCalendarPage(),
      url: window.location.href
    });
    return true;
  }
});

/**
 * Navigate to next week by clicking the forward button
 */
async function navigateNextWeek() {
  // Find the "next" navigation button
  const nextButton = document.querySelector('[data-value="next"]') ||
                     document.querySelector('button[aria-label*="Next"]') ||
                     document.querySelector('button[aria-label*="Forward"]');

  if (nextButton) {
    nextButton.click();
    // Wait for calendar to update
    await new Promise(r => setTimeout(r, 2000));
    return { success: true };
  }

  return { success: false, error: 'Next button not found' };
}

/**
 * Check if we're on a calendar view page
 */
function isCalendarPage() {
  return window.location.hostname === 'calendar.google.com';
}

/**
 * Scrape events from the Google Calendar week view
 * Uses aria labels on event buttons which contain structured info
 */
async function scrapeCalendarEvents() {
  const events = [];

  // Google Calendar renders events as divs with data-eventchip attribute
  // Their textContent contains the full description label followed by a duplicate title+time
  const chips = document.querySelectorAll('[data-eventchip]');
  const processedLabels = new Set();

  for (const chip of chips) {
    const text = chip.textContent?.trim();
    if (!text || text === 'Add location') continue;

    // Extract the label portion — it starts with "All day, " or "HH:MM to HH:MM, "
    // and ends before the duplicated title+time suffix
    let label = text;

    // For timed events: the text repeats the title and time at the end
    // e.g., "10:00 to 10:45, Title, ..., 26 January 2026Title10:00 – 10:45"
    // For all-day: "All day, Title, ..., 26 January 2026"
    // Find where the label portion ends (at the year)
    const yearMatch = text.match(/\d{4}/);
    if (yearMatch) {
      const yearEnd = text.indexOf(yearMatch[0]) + yearMatch[0].length;
      label = text.substring(0, yearEnd);
    }

    if (processedLabels.has(label)) continue;

    const event = parseEventLabel(label);
    if (event) {
      processedLabels.add(label);
      events.push(event);
    }
  }

  return {
    events,
    count: events.length,
    url: window.location.href
  };
}

/**
 * Parse an event from a Google Calendar button's aria label
 * @param {string} label - The aria-label text
 * @returns {Object|null} Parsed event or null
 */
function parseEventLabel(label) {
  // Split by ", " but be careful with commas in titles
  const parts = label.split(', ');
  if (parts.length < 3) return null;

  let startTime = null;
  let endTime = null;
  let isAllDay = false;
  let title = '';
  let location = '';
  let dateStr = '';
  let status = '';

  // Check if it's an all-day event
  if (parts[0].trim() === 'All day') {
    isAllDay = true;
    // Title is next part(s) — find the date part at the end
    dateStr = findDatePart(parts);
    title = extractTitle(parts, 1, dateStr);
  } else {
    // Try to parse time range: "HH:MM to HH:MM"
    const timeMatch = parts[0].match(/^(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})$/);
    if (!timeMatch) return null;

    const startTimeStr = timeMatch[1];
    const endTimeStr = timeMatch[2];

    // Find date part at the end
    dateStr = findDatePart(parts);
    if (!dateStr) return null;

    // Parse date
    const eventDate = parseCalendarDate(dateStr);
    if (!eventDate) return null;

    // Parse times
    startTime = setTimeOnDate(eventDate, startTimeStr);
    endTime = setTimeOnDate(eventDate, endTimeStr);

    // Title is between time and the calendar/status/location/date parts
    title = extractTitle(parts, 1, dateStr);
  }

  if (!title) return null;

  // Extract location if present
  const locationIdx = parts.findIndex(p => p.startsWith('Location:'));
  if (locationIdx !== -1) {
    location = parts[locationIdx].replace('Location: ', '');
  }

  // Extract RSVP status
  if (label.includes('Needs RSVP')) {
    status = 'needs_rsvp';
  } else if (label.includes('Accepted')) {
    status = 'accepted';
  } else if (label.includes('Declined')) {
    status = 'declined';
  } else if (label.includes('Tentative')) {
    status = 'tentative';
  }

  // For all-day events, parse the date
  if (isAllDay && !startTime) {
    const eventDate = parseCalendarDate(dateStr);
    if (eventDate) {
      startTime = new Date(eventDate);
      startTime.setHours(0, 0, 0, 0);
      endTime = new Date(eventDate);
      endTime.setHours(23, 59, 59, 999);
    }
  }

  if (!startTime) return null;

  return {
    title,
    startTime: startTime.toISOString(),
    endTime: endTime?.toISOString() || new Date(startTime.getTime() + 3600000).toISOString(),
    isAllDay,
    location,
    rsvpStatus: status,
    rawLabel: label
  };
}

/**
 * Find the date portion in the parts array
 * Date is typically the last part, e.g., "28 January 2026"
 */
function findDatePart(parts) {
  // Look from the end for a date pattern
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].trim();
    // Match "DD Month YYYY" or "DD Month – DD Month YYYY" (multi-day)
    if (p.match(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/)) {
      return p;
    }
  }
  return '';
}

/**
 * Extract event title from parts, excluding known metadata fields
 */
function extractTitle(parts, startIdx, dateStr) {
  const skipPrefixes = [
    'Edward Hibbert', 'Needs RSVP', 'Accepted', 'Declined', 'Tentative',
    'No location', 'Location:', 'All day'
  ];

  const titleParts = [];
  for (let i = startIdx; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p === dateStr) break;
    if (dateStr && p.includes(dateStr.split(' ')[0]) && p.match(/\d{4}/)) break;
    if (skipPrefixes.some(prefix => p.startsWith(prefix))) continue;
    titleParts.push(p);
  }

  return titleParts.join(', ').trim();
}

/**
 * Parse a calendar date string like "28 January 2026"
 */
function parseCalendarDate(dateStr) {
  // Handle multi-day: "31 January – 1 February 2026" — use start date
  const multiMatch = dateStr.match(/^(\d{1,2})\s+(\w+)\s+(?:–|to)\s+\d{1,2}\s+\w+\s+(\d{4})/);
  if (multiMatch) {
    return new Date(`${multiMatch[2]} ${multiMatch[1]}, ${multiMatch[3]}`);
  }

  // Single date: "28 January 2026"
  const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (match) {
    return new Date(`${match[2]} ${match[1]}, ${match[3]}`);
  }

  return null;
}

/**
 * Set time on a date object from a time string like "10:00" or "14:30"
 */
function setTimeOnDate(date, timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

// Notify background script that we're on a calendar page
chrome.runtime.sendMessage({
  type: 'CALENDAR_PAGE_READY',
  url: window.location.href
});
