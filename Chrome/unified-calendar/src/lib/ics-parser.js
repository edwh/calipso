/**
 * ICS (iCalendar) parser for Google Calendar feeds
 * Parses private iCal URLs into calendar entries
 */

import { createCalendarEntry } from './types.js';
import { generateId } from './storage.js';

/**
 * Fetch and parse an iCal URL
 * @param {string} icalUrl - Private iCal URL
 * @param {string} mailboxId - Mailbox this calendar belongs to
 * @param {string} calendarName - Name of the calendar
 * @returns {Promise<Array>} Array of calendar entries
 */
export async function fetchAndParseIcal(icalUrl, mailboxId, calendarName) {
  try {
    const response = await fetch(icalUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch iCal: ${response.status}`);
    }

    const icsText = await response.text();
    return parseIcsText(icsText, mailboxId, calendarName);
  } catch (error) {
    console.error('Error fetching iCal:', error);
    throw error;
  }
}

/**
 * Parse ICS text into calendar entries
 * @param {string} icsText - Raw ICS content
 * @param {string} mailboxId - Mailbox ID
 * @param {string} calendarName - Calendar name
 * @returns {Array} Array of calendar entries
 */
export function parseIcsText(icsText, mailboxId, calendarName) {
  const entries = [];
  const events = extractEvents(icsText);

  for (const event of events) {
    try {
      const entry = parseEvent(event, mailboxId, calendarName);
      if (entry) {
        entries.push(entry);
      }
    } catch (error) {
      console.warn('Failed to parse event:', error);
    }
  }

  return entries;
}

/**
 * Extract VEVENT blocks from ICS text
 * @param {string} icsText - Raw ICS content
 * @returns {Array} Array of event text blocks
 */
function extractEvents(icsText) {
  const events = [];
  const lines = icsText.split(/\r?\n/);

  let inEvent = false;
  let currentEvent = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = [];
    } else if (line === 'END:VEVENT') {
      inEvent = false;
      events.push(currentEvent.join('\n'));
    } else if (inEvent) {
      currentEvent.push(line);
    }
  }

  return events;
}

/**
 * Parse a single VEVENT into a calendar entry
 * @param {string} eventText - Event text block
 * @param {string} mailboxId - Mailbox ID
 * @param {string} calendarName - Calendar name
 * @returns {Object|null} Calendar entry or null if invalid
 */
function parseEvent(eventText, mailboxId, calendarName) {
  const props = parseProperties(eventText);

  const uid = props.UID;
  const summary = props.SUMMARY || 'Untitled Event';
  const dtstart = props.DTSTART;
  const dtend = props.DTEND;

  if (!dtstart) return null;

  const startTime = parseIcsDate(dtstart);
  const endTime = dtend ? parseIcsDate(dtend) : new Date(startTime.getTime() + 60 * 60 * 1000);

  // Skip events older than 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  if (endTime < cutoff) return null;

  return createCalendarEntry({
    id: `cal-${mailboxId}-${uid || generateId()}`,
    mailboxId,
    title: unescapeIcsText(summary),
    startTime,
    endTime,
    calendarName,
    eventId: uid
  });
}

/**
 * Parse ICS properties from text
 * @param {string} text - Property text
 * @returns {Object} Key-value properties
 */
function parseProperties(text) {
  const props = {};
  const lines = unfoldLines(text.split(/\r?\n/));

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    let key = line.substring(0, colonIndex);
    const value = line.substring(colonIndex + 1);

    // Handle parameters like DTSTART;TZID=America/New_York:20250115T100000
    const semiIndex = key.indexOf(';');
    if (semiIndex !== -1) {
      key = key.substring(0, semiIndex);
    }

    props[key] = value;
  }

  return props;
}

/**
 * Unfold continuation lines (lines starting with space/tab)
 * @param {Array} lines - Array of lines
 * @returns {Array} Unfolded lines
 */
function unfoldLines(lines) {
  const result = [];

  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (result.length > 0) {
        result[result.length - 1] += line.substring(1);
      }
    } else {
      result.push(line);
    }
  }

  return result;
}

/**
 * Parse an ICS date string
 * @param {string} dateStr - ICS date string
 * @returns {Date} Parsed date
 */
function parseIcsDate(dateStr) {
  // Handle different formats:
  // 20250115 (date only)
  // 20250115T100000 (local time)
  // 20250115T100000Z (UTC)

  // Remove any VALUE=DATE: prefix
  dateStr = dateStr.replace(/^VALUE=DATE:/, '');

  // Date only format
  if (dateStr.length === 8) {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(year, month, day);
  }

  // DateTime format
  const isUtc = dateStr.endsWith('Z');
  const cleanStr = dateStr.replace('Z', '').replace('T', '');

  const year = parseInt(cleanStr.substring(0, 4));
  const month = parseInt(cleanStr.substring(4, 6)) - 1;
  const day = parseInt(cleanStr.substring(6, 8));
  const hour = parseInt(cleanStr.substring(8, 10)) || 0;
  const minute = parseInt(cleanStr.substring(10, 12)) || 0;
  const second = parseInt(cleanStr.substring(12, 14)) || 0;

  if (isUtc) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  return new Date(year, month, day, hour, minute, second);
}

/**
 * Unescape ICS text (handle backslash escaping)
 * @param {string} text - Escaped text
 * @returns {string} Unescaped text
 */
function unescapeIcsText(text) {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
