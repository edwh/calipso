/**
 * Outlook Calendar content script
 * Runs on Outlook Web calendar pages to extract calendar events
 */

console.log('Calipso: Outlook calendar adapter loaded');

// Message listener for commands from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCRAPE_OUTLOOK_CALENDAR') {
    scrapeOutlookCalendarEvents().then(sendResponse);
    return true;
  }

  if (message.type === 'NAVIGATE_NEXT_WEEK') {
    navigateNextWeek().then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_OUTLOOK_PAGE') {
    sendResponse({
      isOutlookCalendar: isOutlookCalendarPage(),
      url: window.location.href
    });
    return true;
  }

  if (message.type === 'GET_OUTLOOK_INFO') {
    sendResponse(getOutlookInfo());
    return true;
  }
});

/**
 * Navigate to next week by clicking the forward button
 */
async function navigateNextWeek() {
  // Find the "next" navigation button in Outlook
  const nextButton = document.querySelector('[aria-label*="Next"]') ||
                     document.querySelector('[aria-label*="Forward"]') ||
                     document.querySelector('button[title*="Next"]') ||
                     document.querySelector('[data-icon-name="ChevronRight"]')?.closest('button');

  if (nextButton) {
    nextButton.click();
    await new Promise(r => setTimeout(r, 2000));
    return { success: true };
  }

  return { success: false, error: 'Next button not found' };
}

/**
 * Check if we're on an Outlook calendar page
 */
function isOutlookCalendarPage() {
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;
  return (
    (hostname.includes('outlook.live.com') ||
     hostname.includes('outlook.office.com') ||
     hostname.includes('outlook.office365.com')) &&
    pathname.includes('/calendar')
  );
}

/**
 * Get Outlook account info from the page
 */
function getOutlookInfo() {
  // Try to find email from various locations in Outlook Web
  let email = '';

  // Try account manager button
  const accountBtn = document.querySelector('[data-testid="account-manager-button"]');
  if (accountBtn) {
    email = accountBtn.getAttribute('aria-label')?.match(/[\w.-]+@[\w.-]+/)?.[0] || '';
  }

  // Try header profile
  if (!email) {
    const profile = document.querySelector('[class*="accountProfile"]');
    email = profile?.textContent?.match(/[\w.-]+@[\w.-]+/)?.[0] || '';
  }

  return {
    isOutlook: true,
    email,
    provider: 'outlook'
  };
}

/**
 * Scrape events from Outlook Calendar web page
 */
async function scrapeOutlookCalendarEvents() {
  const events = [];
  const seenEvents = new Set();

  try {
    // Wait a bit for calendar to fully render
    await new Promise(r => setTimeout(r, 1000));

    // Outlook Web calendar events are buttons with detailed descriptions
    // Format: "Title, StartTime to EndTime, DayOfWeek, Date, By Organizer, Status, ..."
    const eventButtons = document.querySelectorAll('button[class*="event"], button[aria-label*="to"]');

    for (const btn of eventButtons) {
      const description = btn.getAttribute('aria-label') || btn.getAttribute('description') || '';

      // Skip non-event buttons
      if (!description || description.length < 20) continue;

      // Parse the Outlook event description format
      const event = parseOutlookEventDescription(description);
      if (event && !seenEvents.has(event.title + event.startTime)) {
        seenEvents.add(event.title + event.startTime);
        events.push(event);
      }
    }

    // Also check main calendar region for any missed events
    const mainRegion = document.querySelector('main[class*="calendar"], [role="main"]');
    if (mainRegion) {
      const allButtons = mainRegion.querySelectorAll('button');
      for (const btn of allButtons) {
        const description = btn.getAttribute('aria-label') || btn.getAttribute('description') || '';
        if (description.includes(' to ') && description.includes(',')) {
          const event = parseOutlookEventDescription(description);
          if (event && !seenEvents.has(event.title + event.startTime)) {
            seenEvents.add(event.title + event.startTime);
            events.push(event);
          }
        }
      }
    }

    console.log(`Outlook calendar scraper found ${events.length} events`);

  } catch (error) {
    console.error('Error scraping Outlook calendar:', error);
  }

  return {
    events,
    count: events.length,
    url: window.location.href
  };
}

/**
 * Parse Outlook event description format
 * Format: "Title, StartTime to EndTime, DayOfWeek, MonthName Day, Year, By Organizer, Status, ..."
 * Example: "Lab consultants' weekly check-in, 11:00 to 11:30, Monday, January 26, 2026, By Pavord, Sue (RTH) OUH, Busy, Recurring event"
 */
function parseOutlookEventDescription(description) {
  try {
    // Skip canceled events
    if (description.toLowerCase().startsWith('canceled:')) {
      return null;
    }

    // Split by comma but be careful with commas in names
    const parts = description.split(', ');
    if (parts.length < 4) return null;

    // First part is the title
    const title = parts[0].trim();
    if (!title) return null;

    // Find time pattern: "HH:MM to HH:MM"
    let timeStr = '';
    let timePartIndex = -1;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].match(/^\d{1,2}:\d{2}\s+to\s+\d{1,2}:\d{2}$/)) {
        timeStr = parts[i];
        timePartIndex = i;
        break;
      }
    }

    // Find date pattern: look for "DayOfWeek, MonthName Day, Year" after time
    let dateStr = '';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    for (let i = timePartIndex + 1; i < parts.length; i++) {
      const part = parts[i].trim();
      // Check for day of week
      if (days.includes(part) && i + 2 < parts.length) {
        // Next parts should be "MonthName Day" and "Year"
        const monthDayPart = parts[i + 1]?.trim() || '';
        const yearPart = parts[i + 2]?.trim() || '';

        const monthMatch = monthDayPart.match(/^(\w+)\s+(\d{1,2})$/);
        const yearMatch = yearPart.match(/^(\d{4})/);

        if (monthMatch && yearMatch && months.includes(monthMatch[1])) {
          dateStr = `${monthMatch[1]} ${monthMatch[2]}, ${yearMatch[1]}`;
          break;
        }
      }
    }

    // Check for all-day events
    const isAllDay = description.toLowerCase().includes('all day');

    if (!dateStr && !isAllDay) {
      // Try to find just month/day/year without day of week
      for (let i = 1; i < parts.length; i++) {
        for (const month of months) {
          if (parts[i].includes(month)) {
            const match = parts[i].match(new RegExp(`(${month})\\s+(\\d{1,2})`));
            if (match) {
              // Look for year in next part
              const yearMatch = parts[i + 1]?.match(/^(\d{4})/);
              if (yearMatch) {
                dateStr = `${match[1]} ${match[2]}, ${yearMatch[1]}`;
                break;
              }
            }
          }
        }
        if (dateStr) break;
      }
    }

    if (!dateStr) {
      // Default to today if no date found
      dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    const eventDate = new Date(dateStr);
    if (isNaN(eventDate.getTime())) return null;

    let startTime, endTime;

    if (timeStr) {
      const timeMatch = timeStr.match(/(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})/);
      if (timeMatch) {
        startTime = parseOutlookTime(eventDate, timeMatch[1]);
        endTime = parseOutlookTime(eventDate, timeMatch[2]);
      }
    }

    if (!startTime) {
      // All day event
      startTime = new Date(eventDate);
      startTime.setHours(0, 0, 0, 0);
      endTime = new Date(eventDate);
      endTime.setHours(23, 59, 59, 999);
    }

    // Extract status
    let rsvpStatus = '';
    if (description.includes('Tentative')) rsvpStatus = 'tentative';
    else if (description.includes('Busy')) rsvpStatus = 'accepted';
    else if (description.includes('Free')) rsvpStatus = 'free';

    return {
      title,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      isAllDay: isAllDay || !timeStr,
      location: '',
      rsvpStatus
    };
  } catch (e) {
    console.error('Error parsing Outlook event description:', e);
    return null;
  }
}

/**
 * Parse an Outlook event card element
 */
function parseOutlookEventCard(card) {
  try {
    const ariaLabel = card.getAttribute('aria-label') || '';
    const textContent = card.textContent || '';

    // Try to extract title
    const titleEl = card.querySelector('[class*="title"], [class*="subject"]');
    const title = titleEl?.textContent?.trim() || textContent.split(',')[0]?.trim();

    if (!title) return null;

    // Try to extract time from aria-label or text
    const timeMatch = ariaLabel.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:to|-)\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i) ||
                      textContent.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:to|-)\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);

    // Try to extract date
    const dateMatch = ariaLabel.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}/i) ||
                      textContent.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}/i);

    if (!timeMatch && !dateMatch) return null;

    const eventDate = dateMatch ? new Date(dateMatch[0]) : new Date();
    let startTime, endTime;

    if (timeMatch) {
      startTime = parseOutlookTime(eventDate, timeMatch[1]);
      endTime = parseOutlookTime(eventDate, timeMatch[2]);
    } else {
      // All day event
      startTime = new Date(eventDate);
      startTime.setHours(0, 0, 0, 0);
      endTime = new Date(eventDate);
      endTime.setHours(23, 59, 59, 999);
    }

    return {
      title,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      isAllDay: !timeMatch,
      location: '',
      rsvpStatus: ''
    };
  } catch (e) {
    console.error('Error parsing Outlook event card:', e);
    return null;
  }
}

/**
 * Parse an Outlook grid event element
 */
function parseOutlookGridEvent(el) {
  return parseOutlookEventCard(el); // Same parsing logic
}

/**
 * Parse event from an aria-label string
 */
function parseOutlookAriaLabel(label) {
  try {
    // Pattern: "Title, Month Day, Year, StartTime to EndTime"
    // or: "Title, Month Day, Year StartTime - EndTime, Location"
    const parts = label.split(',').map(s => s.trim());
    if (parts.length < 3) return null;

    const title = parts[0];

    // Find date part
    let dateStr = '';
    let timeStr = '';

    for (const part of parts) {
      if (part.match(/(January|February|March|April|May|June|July|August|September|October|November|December)/i)) {
        dateStr = part;
      }
      if (part.match(/\d{1,2}:\d{2}/)) {
        timeStr = part;
      }
    }

    if (!dateStr) return null;

    const eventDate = new Date(dateStr);
    if (isNaN(eventDate.getTime())) return null;

    let startTime, endTime;

    const timeMatch = timeStr.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:to|-)\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
    if (timeMatch) {
      startTime = parseOutlookTime(eventDate, timeMatch[1]);
      endTime = parseOutlookTime(eventDate, timeMatch[2]);
    } else {
      startTime = new Date(eventDate);
      startTime.setHours(0, 0, 0, 0);
      endTime = new Date(eventDate);
      endTime.setHours(23, 59, 59, 999);
    }

    return {
      title,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      isAllDay: !timeMatch,
      location: '',
      rsvpStatus: ''
    };
  } catch (e) {
    return null;
  }
}

/**
 * Parse time string like "10:00 AM" and set on date
 */
function parseOutlookTime(date, timeStr) {
  const result = new Date(date);
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);

  if (match) {
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const meridiem = match[3]?.toUpperCase();

    if (meridiem === 'PM' && hours !== 12) {
      hours += 12;
    } else if (meridiem === 'AM' && hours === 12) {
      hours = 0;
    }

    result.setHours(hours, minutes, 0, 0);
  }

  return result;
}

// Notify background script that we're on an Outlook calendar page
if (isOutlookCalendarPage()) {
  chrome.runtime.sendMessage({
    type: 'OUTLOOK_CALENDAR_PAGE_READY',
    url: window.location.href
  });
}
