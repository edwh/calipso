/**
 * Type definitions and factory functions for data models
 */

/**
 * Create a new mailbox configuration
 * @param {Object} params
 * @returns {Object} MailboxConfig
 */
export function createMailboxConfig({
  id,
  name,
  email,
  accountIndex,
  color = '#4285f4'
}) {
  return {
    id,
    name,
    email,
    accountIndex,
    color,
    lastScanTimestamp: null,
    lastScannedEmailId: null,
    createdAt: new Date().toISOString()
  };
}

/**
 * Create a calendar entry from a calendar source
 * @param {Object} params
 * @returns {Object} CalendarEntry
 */
export function createCalendarEntry({
  id,
  mailboxId,
  title,
  startTime,
  endTime,
  calendarName,
  eventId
}) {
  return {
    id,
    mailboxId,
    title,
    startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
    endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    status: 'confirmed',
    source: {
      type: 'calendar',
      calendarName,
      eventId
    },
    conflicts: []
  };
}

/**
 * Create a tentative entry from email analysis
 * @param {Object} params
 * @returns {Object} CalendarEntry
 */
export function createTentativeEntry({
  id,
  mailboxId,
  title,
  startTime,
  endTime,
  emailSubject,
  emailDate,
  emailThreadId,
  negotiationState
}) {
  return {
    id,
    mailboxId,
    title,
    startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
    endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    status: 'tentative',
    source: {
      type: 'email',
      emailSubject,
      emailDate: emailDate instanceof Date ? emailDate.toISOString() : emailDate,
      emailThreadId,
      negotiationState
    },
    conflicts: []
  };
}

/**
 * Create a negotiation state object
 * @param {Object} params
 * @returns {Object} NegotiationState
 */
export function createNegotiationState({
  proposedTimes = [],
  status = 'proposed',
  participants = [],
  lastUpdate = new Date()
}) {
  return {
    proposedTimes,
    status, // 'proposed' | 'counter-proposed' | 'awaiting-response' | 'confirmed' | 'declined'
    participants,
    lastUpdate: lastUpdate instanceof Date ? lastUpdate.toISOString() : lastUpdate
  };
}

/**
 * Create a proposed time slot
 * @param {Object} params
 * @returns {Object} ProposedTime
 */
export function createProposedTime({
  start,
  end,
  proposedBy,
  status = 'pending'
}) {
  return {
    start: start instanceof Date ? start.toISOString() : start,
    end: end instanceof Date ? end.toISOString() : end,
    proposedBy,
    status // 'pending' | 'accepted' | 'rejected'
  };
}

/**
 * Create a scan state object
 * @param {Object} params
 * @returns {Object} ScanState
 */
export function createScanState({
  mailboxId,
  status = 'idle',
  phase = 'calendar',
  progress = { current: 0, total: 0, currentItem: '' }
}) {
  return {
    mailboxId,
    status, // 'idle' | 'scanning' | 'paused' | 'error'
    phase, // 'calendar' | 'emails' | 'analyzing' | 'complete'
    progress,
    startTime: null,
    errors: []
  };
}

/**
 * Default mailbox colors
 */
export const MAILBOX_COLORS = [
  '#4285f4', // Google Blue
  '#34a853', // Google Green
  '#ea4335', // Google Red
  '#fbbc04', // Google Yellow
  '#9c27b0', // Purple
  '#00bcd4', // Cyan
  '#ff9800', // Orange
  '#795548'  // Brown
];

/**
 * Get next available color for a new mailbox
 * @param {Array} existingMailboxes
 * @returns {string} Color hex code
 */
export function getNextColor(existingMailboxes) {
  const usedColors = new Set(existingMailboxes.map(m => m.color));
  for (const color of MAILBOX_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  return MAILBOX_COLORS[existingMailboxes.length % MAILBOX_COLORS.length];
}
