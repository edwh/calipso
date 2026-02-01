/**
 * Outlook Email content script
 * Runs on Outlook Web mail pages to extract email metadata
 */

console.log('Calipso: Outlook email adapter loaded');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_OUTLOOK_EMAILS') {
    scanOutlookEmails(message.options || {}).then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_OUTLOOK_MAIL') {
    sendResponse({
      isOutlookMail: isOutlookMailPage(),
      url: window.location.href
    });
    return true;
  }
});

function isOutlookMailPage() {
  const hostname = window.location.hostname;
  return (
    (hostname.includes('outlook.live.com') ||
     hostname.includes('outlook.office.com') ||
     hostname.includes('outlook.office365.com')) &&
    window.location.pathname.includes('/mail')
  );
}

/**
 * Scan visible emails in Outlook Web
 */
async function scanOutlookEmails(options = {}) {
  const lookbackDays = options.lookbackDays || 14;
  const emails = [];

  try {
    await new Promise(r => setTimeout(r, 2000));

    const rows = document.querySelectorAll('[role="option"][aria-label]');
    console.log(`Calipso: Found ${rows.length} Outlook email rows`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
    cutoffDate.setHours(0, 0, 0, 0);

    for (const row of rows) {
      try {
        const email = extractOutlookEmail(row);
        if (!email) continue;

        // Skip calendar invites - already captured via calendar scraping
        if (email.isCalendarInvite) {
          console.log('Calipso: Skipping calendar invite:', email.subject);
          continue;
        }

        // Filter by date
        if (email.parsedDate) {
          const emailDate = new Date(email.parsedDate);
          if (emailDate < cutoffDate) continue;
        }

        emails.push(email);
      } catch (e) {
        console.warn('Calipso: Failed to extract Outlook email:', e);
      }
    }

    console.log(`Calipso: Outlook email scan found ${emails.length} emails (from ${rows.length} rows)`);

  } catch (error) {
    console.error('Calipso: Error scanning Outlook emails:', error);
  }

  return {
    emailCount: emails.length,
    totalVisible: emails.length,
    cutoffDate: new Date(Date.now() - lookbackDays * 86400000).toISOString(),
    emails: emails.slice(0, 50)
  };
}

/**
 * Extract email metadata from an Outlook Web option element.
 *
 * aria-label format examples:
 *   "Unread Has attachments External sender user@domain.com Subject here 09:00 Snippet..."
 *   "External sender wood.blood@hematology.org Subject here Sat 23:44 Snippet..."
 *   "Unread Has attachments Meeting start time 04 February at 07:30 SenderName Subject Snippet..."
 *   "Collapsed Sheldon, Sophie (RTH) OUH; Francis, Mariella (RTH) OUH update? Sat 16:43 Snippet..."
 */
function extractOutlookEmail(row) {
  const label = row.getAttribute('aria-label') || '';
  if (!label || label.length < 20) return null;

  // Known flags at the start of the label
  const flagWords = ['Unread', 'Has attachments', 'External sender', 'Flagged',
                     'Pinned', 'Collapsed', 'Important'];

  let remaining = label;
  let isUnread = false;
  let isCalendarInvite = false;

  // Strip flags
  let changed = true;
  while (changed) {
    changed = false;
    for (const flag of flagWords) {
      if (remaining.startsWith(flag + ' ')) {
        if (flag === 'Unread') isUnread = true;
        remaining = remaining.substring(flag.length + 1);
        changed = true;
      }
    }
  }

  // Detect calendar invite: "Meeting start time DD Month at HH:MM ..."
  if (remaining.startsWith('Meeting')) {
    isCalendarInvite = true;
    // Still extract subject for logging
    const meetingMatch = remaining.match(/^Meeting start time .+? at \d{1,2}:\d{2}\s+(.+)/);
    const subject = meetingMatch ? meetingMatch[1].substring(0, 80) : remaining.substring(0, 80);
    return { id: hashCode(label), subject, from: '', dateText: '', parsedDate: null, snippet: '', isUnread, isCalendarInvite };
  }

  // Remove trailing "No conversations selected"
  remaining = remaining.replace(/\s*No conversations selected\s*$/, '');

  if (remaining.length < 10) return null;

  // Find the time marker which separates subject from snippet.
  // Patterns: "HH:MM" standalone or "Day HH:MM" (e.g. "Sat 18:07")
  // The time appears after the subject and before the snippet.
  const timeRegex = /\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(\d{1,2}:\d{2})\s+/;
  const timeMatch = remaining.match(timeRegex);

  let from = '';
  let subject = '';
  let dateText = '';
  let snippet = '';

  if (timeMatch) {
    const beforeTime = remaining.substring(0, timeMatch.index);
    snippet = remaining.substring(timeMatch.index + timeMatch[0].length).substring(0, 200);
    dateText = timeMatch[0].trim();

    // Split beforeTime into sender + subject
    // Sender is an email address or a name like "LastName, FirstName (ORG) TRUST"
    const emailMatch = beforeTime.match(/^(\S+@\S+)\s+(.+)$/);
    if (emailMatch) {
      from = emailMatch[1];
      subject = emailMatch[2].trim();
    } else {
      // Name-based sender: look for "(ORG)" pattern or "; " (multiple recipients)
      // Find end of sender block by looking for known patterns
      const orgEnd = beforeTime.search(/\)\s+[A-Z]/);
      if (orgEnd !== -1) {
        // Find the closing paren
        const parenIdx = beforeTime.indexOf(')', orgEnd);
        // Check for "TRUST" or similar after paren
        const afterParen = beforeTime.substring(parenIdx + 1).trimStart();
        const trustMatch = afterParen.match(/^((?:NHS\s+)?(?:TRUST|OUH|NHS)[A-Z]*)\s+/i);
        if (trustMatch) {
          const senderEnd = parenIdx + 1 + afterParen.indexOf(trustMatch[1]) + trustMatch[1].length;
          from = beforeTime.substring(0, senderEnd).trim();
          subject = beforeTime.substring(senderEnd).trim();
        } else {
          from = beforeTime.substring(0, parenIdx + 1).trim();
          subject = afterParen.trim();
        }
      } else if (beforeTime.includes(';')) {
        // Multiple senders separated by ";"
        const semiParts = beforeTime.split(/;\s*/);
        // The last segment likely contains "LastSender Subject"
        // Heuristic: take all parts except parse subject from the last one
        from = beforeTime.substring(0, beforeTime.lastIndexOf(';')).trim();
        const lastPart = semiParts[semiParts.length - 1].trim();
        // Try to find where sender ends in the last segment
        const lastOrgEnd = lastPart.search(/\)\s/);
        if (lastOrgEnd !== -1) {
          const closeParen = lastPart.indexOf(')', lastOrgEnd);
          from += '; ' + lastPart.substring(0, closeParen + 1);
          subject = lastPart.substring(closeParen + 1).trim();
        } else {
          // Can't distinguish - take whole thing as from+subject combo
          subject = lastPart;
        }
      } else {
        // Simple case: first few words are sender
        // Use a heuristic: sender names usually have comma (Last, First)
        const commaIdx = beforeTime.indexOf(',');
        if (commaIdx !== -1 && commaIdx < 30) {
          // "LastName, FirstName (ORG) Subject..."
          const afterComma = beforeTime.substring(commaIdx + 1);
          const spaceAfterName = afterComma.search(/\s{2,}|\)\s/);
          if (spaceAfterName !== -1) {
            const nameEnd = commaIdx + 1 + spaceAfterName + 1;
            from = beforeTime.substring(0, nameEnd).trim();
            subject = beforeTime.substring(nameEnd).trim();
          } else {
            // Just split roughly
            from = beforeTime.substring(0, commaIdx + 10).trim();
            subject = beforeTime.substring(commaIdx + 10).trim();
          }
        } else {
          // No comma - first word(s) might be sender
          const words = beforeTime.split(/\s+/);
          from = words.slice(0, 2).join(' ');
          subject = words.slice(2).join(' ');
        }
      }
    }
  } else {
    // No time found - use whole remaining as subject
    subject = remaining.substring(0, 100);
  }

  if (!subject || subject.length < 3) return null;

  // Clean up subject - remove trailing sender artifacts
  subject = subject.replace(/\s*No conversations selected$/, '').trim();

  // Parse date from time text
  const parsedDate = parseTimeText(dateText);

  // Additional calendar invite detection from subject
  const subjectLower = subject.toLowerCase();
  if (subjectLower.startsWith('accepted:') ||
      subjectLower.startsWith('declined:') ||
      subjectLower.startsWith('tentative:') ||
      subjectLower.startsWith('canceled:') ||
      subjectLower.startsWith('cancelled:')) {
    isCalendarInvite = true;
  }

  return {
    id: hashCode(from + subject + dateText),
    subject,
    from,
    dateText,
    parsedDate: parsedDate?.toISOString() || null,
    snippet,
    isUnread,
    isCalendarInvite
  };
}

/**
 * Parse time text like "09:00", "Sat 23:44" into a Date
 */
function parseTimeText(text) {
  if (!text) return null;
  const now = new Date();

  // "Sat 23:44" - day + time
  const dayTime = text.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})$/i);
  if (dayTime) {
    const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = days[dayTime[1].toLowerCase()];
    const date = new Date(now);
    const diff = (date.getDay() - targetDay + 7) % 7 || 0;
    date.setDate(date.getDate() - diff);
    date.setHours(parseInt(dayTime[2]), parseInt(dayTime[3]), 0, 0);
    return date;
  }

  // "09:00" - time only (today)
  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const date = new Date(now);
    date.setHours(parseInt(timeOnly[1]), parseInt(timeOnly[2]), 0, 0);
    return date;
  }

  return null;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'outlook-' + Math.abs(hash).toString(36);
}

if (isOutlookMailPage()) {
  chrome.runtime.sendMessage({
    type: 'OUTLOOK_EMAIL_ADAPTER_READY',
    url: window.location.href
  });
}
