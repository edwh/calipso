/**
 * Background service worker
 * Orchestrates scanning, manages tabs, and coordinates all extension activities
 * Includes WebLLM integration for meeting detection
 */

import * as storage from '../lib/storage';
import { CreateMLCEngine, MLCEngine } from '@mlc-ai/web-llm';

// Type definitions
interface ScanState {
  status: string;
  startTime: number;
  phase: string;
  progress: {
    current: number;
    total: number;
    currentItem: string;
  };
  options: any;
  error?: string;
}

interface Email {
  id: string;
  subject: string;
  snippet: string;
  from?: string;
  dateText?: string;
  parsedDate?: string;
}

interface MeetingAnalysis {
  isMeeting: boolean;
  title?: string;
  date?: string;
  endDate?: string;
  time?: string;
  duration?: number;
  confidence?: string;
}

// Global state
let currentScan: ScanState | null = null;
let scanAborted = false;
let llmEngine: MLCEngine | null = null;
let llmReady = false;
let llmInitializing = false;

// ============ LLM Integration ============

async function initLLM(): Promise<{ ready?: boolean; initializing?: boolean; error?: string }> {
  if (llmReady && llmEngine) {
    return { ready: true };
  }

  if (llmInitializing) {
    return { initializing: true };
  }

  llmInitializing = true;

  try {
    console.log('Initializing WebLLM...');

    llmEngine = await CreateMLCEngine('Phi-3.5-mini-instruct-q4f16_1-MLC', {
      initProgressCallback: (progress) => {
        // Broadcast progress to popup
        chrome.runtime.sendMessage({
          type: 'LLM_INIT_PROGRESS',
          progress: {
            phase: 'loading-model',
            progress: progress.progress,
            text: progress.text
          }
        }).catch(() => {});
      }
    });

    llmReady = true;
    llmInitializing = false;
    console.log('WebLLM initialized successfully');
    return { ready: true };
  } catch (error: any) {
    llmInitializing = false;
    console.error('WebLLM init failed:', error);
    return { error: error.message || 'Unknown error' };
  }
}

async function verifyExtraction(parsed: any): Promise<any | null> {
  if (!llmReady || !llmEngine) return null;

  const verifyPrompt = `Given this text: "${parsed.dateSource}"

What is the START date of the event? Look for "Check-in", "begins", "starts", or the first date mentioned.
What is the END date? Look for "Check-out", "ends", or the last date mentioned.

Current extraction says start=${parsed.date}, end=${parsed.endDate || 'same'}

Example: "Check-in: Wednesday 8 January 2026" → start date is 2026-01-08

Respond with JSON only:
{"date": "YYYY-MM-DD", "endDate": "YYYY-MM-DD"}`;

  try {
    const response = await llmEngine.chat.completions.create({
      messages: [
        { role: 'system', content: 'You verify date extractions. Output JSON only.' },
        { role: 'user', content: verifyPrompt }
      ],
      temperature: 0.1,
      max_tokens: 100
    });

    const result = response.choices[0]?.message?.content || '';
    console.log('Verification raw response:', result);
    const objMatch = result.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const verified = JSON.parse(objMatch[0]);
      if (verified.date && verified.date !== parsed.date) {
        console.log('Verification corrected date:', parsed.date, '→', verified.date);
        return { date: verified.date, endDate: verified.endDate || parsed.endDate };
      }
      console.log('Verification confirmed:', parsed.date);
    }
  } catch (e: any) {
    console.log('Verification failed:', e.message);
  }
  return null;
}

/**
 * Heuristic meeting classifier — fast, no LLM needed.
 * Checks for forwarded calendar invites, meeting keywords, date+time patterns, etc.
 * Returns a MeetingAnalysis if it looks like a meeting, null otherwise.
 */
function classifyEmailHeuristic(email: Email): MeetingAnalysis | null {
  const subject = email.subject || '';
  const subjectLower = subject.toLowerCase();
  const snippet = (email.snippet || '').toLowerCase();
  const from = (email.from || '').toLowerCase();
  const combined = `${subjectLower} ${snippet}`;

  // Strong meeting signals (high confidence)
  const strongSignals = [
    /\b(mdt|mdts)\b/i,                          // MDT meetings
    /\bfw:\s/i,                                   // Forwarded (often calendar invites)
    /\binvit(e|ation)\b/i,                        // Invitation
    /\bcalendar\b/i,                              // Calendar reference
    /\bmeeting\b/i,                               // Meeting
    /\bappointment\b/i,                           // Appointment
    /\bcatch[\s-]?up\b/i,                         // Catch up
    /\bstandup\b/i,                               // Standup
    /\b(zoom|teams|webex|google meet)\b/i,        // Video call platforms
    /\bconference\b/i,                            // Conference
    /\bworkshop\b/i,                              // Workshop
    /\bseminar\b/i,                               // Seminar
    /\bclinic\b/i,                                // Clinic
    /\bsurgery\b/i,                               // Surgery (medical context)
    /\bteaching\b/i,                              // Teaching session
    /\bquality meeting\b/i,                       // Quality meeting
    /\bcheck[\s-]?in\b/i,                         // Check-in
    /\bdphil\b/i,                                 // DPhil meeting
  ];

  // Time patterns in subject (strong signal when combined with other keywords)
  const hasTimeInSubject = /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i.test(subject) ||
                           /\b\d{1,2}\s*(am|pm)\b/i.test(subject);

  // Date patterns in subject
  const hasDateInSubject = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(subject) ||
                           /\b\d{1,2}(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(subject) ||
                           /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(subject);

  let score = 0;
  const matchedSignals: string[] = [];

  for (const pattern of strongSignals) {
    if (pattern.test(subject)) {
      score += 3;
      matchedSignals.push(pattern.source);
    } else if (pattern.test(snippet)) {
      score += 1;
    }
  }

  // Time in subject is a moderate signal
  if (hasTimeInSubject) {
    score += 2;
    matchedSignals.push('time-in-subject');
  }

  // Date in subject is a weak signal on its own
  if (hasDateInSubject) {
    score += 1;
    matchedSignals.push('date-in-subject');
  }

  // "with <person>" pattern (e.g., "Lunch with Sarah")
  if (/\bwith\s+[A-Z][a-z]+/i.test(subject)) {
    score += 2;
    matchedSignals.push('with-person');
  }

  // Known personal contacts (not noreply/automated)
  const isPersonalSender = !from.includes('noreply') &&
                           !from.includes('no-reply') &&
                           !from.includes('digest') &&
                           !from.includes('newsletter') &&
                           !from.includes('notification') &&
                           !from.includes('alert');

  if (!isPersonalSender) {
    score -= 3; // Penalize automated senders
  }

  // Threshold: need score >= 3 to classify as meeting
  if (score >= 3) {
    console.log('Heuristic classified as meeting:', subject, `(score=${score}, signals=${matchedSignals.join(',')})`);
    return {
      isMeeting: true,
      title: subject,
      confidence: score >= 5 ? 'high' : 'medium'
    };
  }

  return null;
}

/**
 * LLM-based analysis — only used as fallback for ambiguous emails
 */
async function analyzeEmailWithLLM(email: Email): Promise<MeetingAnalysis | null> {
  if (!llmReady || !llmEngine) {
    return null;
  }

  const prompt = `Is this email about a scheduled meeting/event? Subject: "${email.subject}" Snippet: "${(email.snippet || '').substring(0, 80)}"
Reply ONLY: YES or NO`;

  try {
    const response = await llmEngine.chat.completions.create({
      messages: [
        { role: 'system', content: 'Answer YES or NO only.' },
        { role: 'user', content: 'Is this email about a scheduled meeting/event? Subject: "Team standup tomorrow 10am" Snippet: "Daily standup"\nReply ONLY: YES or NO' },
        { role: 'assistant', content: 'YES' },
        { role: 'user', content: 'Is this email about a scheduled meeting/event? Subject: "Your weekly digest" Snippet: "Top stories this week"\nReply ONLY: YES or NO' },
        { role: 'assistant', content: 'NO' },
        { role: 'user', content: 'Is this email about a scheduled meeting/event? Subject: "Your order shipped" Snippet: "Track your package"\nReply ONLY: YES or NO' },
        { role: 'assistant', content: 'NO' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.0,
      max_tokens: 5
    });

    const result = (response.choices[0]?.message?.content || '').trim().toUpperCase();
    console.log('LLM YES/NO for:', email.subject, '→', result);

    if (result.startsWith('YES')) {
      return { isMeeting: true, title: email.subject, confidence: 'medium' };
    }
    return null;
  } catch (error: any) {
    console.error('LLM analysis error:', error.message);
    return null;
  }
}

// ============ Message Handling ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (message.type) {
    case 'GET_MAILBOXES':
      return storage.getAllMailboxes();

    case 'ADD_MAILBOX':
      return addMailbox(message.mailbox);

    case 'UPDATE_MAILBOX':
      return updateMailbox(message.mailbox);

    case 'DELETE_MAILBOX':
      return storage.deleteMailbox(message.id);

    case 'START_SCAN':
      return startScan(message.options);

    case 'PAUSE_SCAN':
      return pauseScan();

    case 'CANCEL_SCAN':
      return cancelScan();

    case 'GET_SCAN_STATUS':
      return getScanStatus();

    case 'GET_ENTRIES':
      return storage.getEntriesInRange(
        new Date(message.start),
        new Date(message.end)
      );

    case 'GET_ALL_ENTRIES':
      return storage.getAllEntries();

    case 'CLEAR_ALL_ENTRIES':
      await storage.clearAllEntries();
      return { cleared: true };

    case 'INIT_LLM':
      return initLLM();

    case 'GET_LLM_STATUS':
      return { ready: llmReady, initializing: llmInitializing };

    case 'TEST_LLM':
      // Test heuristic + LLM on a specific email
      const heuristicResult = classifyEmailHeuristic(message.email);
      const llmResult = llmReady ? await analyzeEmailWithLLM(message.email) : null;
      const testResult = heuristicResult || llmResult;
      return { result: testResult };

    case 'OPEN_CALENDAR_VIEW':
      return openCalendarView();

    case 'GMAIL_ADAPTER_READY':
      console.log('Gmail adapter ready for account:', message.accountIndex);
      return { acknowledged: true };

    case 'CALENDAR_PAGE_READY':
      console.log('Calendar page ready:', message.url);
      return { acknowledged: true };

    default:
      console.warn('Unknown message type:', message.type);
      return { error: 'Unknown message type' };
  }
}

// ============ Mailbox Management ============

async function addMailbox(mailboxData: any) {
  // Prevent duplicate emails
  const existing = await storage.getAllMailboxes();
  const duplicate = existing.find((mb: any) => mb.email === mailboxData.email);
  if (duplicate) {
    // Update existing mailbox instead of creating a duplicate
    const updated = { ...duplicate, ...mailboxData, id: duplicate.id };
    await storage.saveMailbox(updated);
    return updated;
  }

  const mailbox = {
    id: `mailbox-${Date.now()}`,
    ...mailboxData,
    createdAt: new Date().toISOString()
  };

  await storage.saveMailbox(mailbox);
  await storage.addScanLog({
    mailboxId: mailbox.id,
    action: 'mailbox_added',
    details: { email: mailbox.email }
  });

  return mailbox;
}

async function updateMailbox(updates: any) {
  const existing = await storage.getMailbox(updates.id);
  if (!existing) return { error: 'Mailbox not found' };

  const updated = { ...existing, ...updates };
  await storage.saveMailbox(updated);
  return updated;
}

// ============ Scanning ============

async function startScan(options: any = {}) {
  if (currentScan?.status === 'scanning') {
    return { error: 'Scan already in progress' };
  }

  const mailboxes = await storage.getAllMailboxes();
  if (mailboxes.length === 0) {
    return { error: 'No mailboxes configured' };
  }

  scanAborted = false;
  currentScan = {
    status: 'scanning',
    startTime: Date.now(),
    phase: 'starting',
    progress: { current: 0, total: 0, currentItem: '' },
    options
  };

  // Broadcast initial status
  broadcastScanStatus();

  // Run scan in background
  runScan(mailboxes, options).catch(error => {
    console.error('Scan error:', error);
    if (currentScan) {
      currentScan.status = 'error';
      currentScan.error = error.message;
    }
    broadcastScanStatus();
  });

  return { started: true };
}

async function runScan(mailboxes: any[], options: any) {
  const lookbackDays = options.lookbackDays || 14;

  // Try to initialize LLM for email analysis (non-blocking)
  if (!llmReady && !llmInitializing) {
    currentScan!.phase = 'starting';
    currentScan!.progress.currentItem = 'Initializing LLM...';
    broadcastScanStatus();
    try {
      await initLLM();
    } catch (e) {
      console.log('LLM not available, using keyword fallback');
    }
  }

  for (const mailbox of mailboxes) {
    if (scanAborted) break;

    // Phase 1: Fetch calendar data
    await scanCalendar(mailbox);

    if (scanAborted) break;

    // Phase 2: Scan emails
    await scanEmails(mailbox, lookbackDays);
  }

  if (!scanAborted) {
    // Phase 3: Detect conflicts
    await detectAllConflicts();

    currentScan!.status = 'complete';
    currentScan!.phase = 'complete';

    // Send completion notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '/public/icons/icon128.png',
      title: 'Scan Complete',
      message: `Found entries from ${mailboxes.length} mailbox(es)`,
      buttons: [{ title: 'View Calendar' }]
    });
  }

  broadcastScanStatus();
}

async function scanCalendar(mailbox: any) {
  currentScan!.phase = 'calendar';
  currentScan!.progress.currentItem = `Fetching calendar: ${mailbox.name}`;
  broadcastScanStatus();

  try {
    // Clear old calendar entries for this mailbox
    await storage.clearEntriesBySource(mailbox.id, 'calendar');

    // Route to appropriate provider
    if (mailbox.provider === 'outlook') {
      await scanOutlookCalendar(mailbox);
      return;
    }

    // Gmail: Scrape from Google Calendar web page
    // We'll scan both current week and next week to cover rolling 7 days
    const today = new Date();
    const calUrl = `https://calendar.google.com/calendar/u/${mailbox.accountIndex}/r/week`;

    // Try to find an existing calendar tab
    const existingTabs = await chrome.tabs.query({
      url: `https://calendar.google.com/calendar/u/${mailbox.accountIndex}/*`
    });

    let tab: chrome.tabs.Tab;
    let createdTab = false;

    // Close any existing calendar tabs to ensure clean content script injection
    for (const t of existingTabs) {
      try { await chrome.tabs.remove(t.id!); } catch (e) {}
    }

    tab = await chrome.tabs.create({ url: calUrl, active: false });
    createdTab = true;
    await waitForTabLoad(tab.id!);
    await sleep(5000);
    console.log('Created Calendar tab:', tab.id);

    // Scrape events from current week AND next week to cover rolling 7 days
    const allEvents: any[] = [];

    // Scrape current week - try content script first, then direct injection
    let scraped = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id!, {
          type: 'SCRAPE_CALENDAR_EVENTS'
        });
        console.log(`Calendar scrape (this week) attempt ${attempt + 1}: ${response?.count || 0} events`);
        if (response?.events) {
          allEvents.push(...response.events);
          scraped = true;
          break;
        }
      } catch (e: any) {
        console.log(`Calendar scrape attempt ${attempt + 1} failed:`, e.message);
        if (e.message.includes('Receiving end does not exist')) {
          console.log('Injecting calendar scraper directly...');
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id! },
              func: scrapeGoogleCalendarDirect
            });
            const response = results[0]?.result;
            console.log('Direct calendar injection found', response?.count || 0, 'events');
            if (response?.events) {
              allEvents.push(...response.events);
              scraped = true;
              break;
            }
          } catch (injectErr: any) {
            console.log('Failed to inject calendar scraper:', injectErr.message);
          }
        }
      }
      await sleep(2000);
    }

    // Navigate to next week and scrape
    try {
      // Try content script navigation first, fall back to direct injection
      try {
        await chrome.tabs.sendMessage(tab.id!, { type: 'NAVIGATE_NEXT_WEEK' });
      } catch (e) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: navigateGoogleCalendarNextWeek
        });
      }
      await sleep(3000); // Wait for calendar to update

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id!, {
            type: 'SCRAPE_CALENDAR_EVENTS'
          });
          console.log(`Calendar scrape (next week) attempt ${attempt + 1}: ${response?.count || 0} events`);
          if (response?.events) {
            allEvents.push(...response.events);
            break;
          }
        } catch (e: any) {
          console.log(`Next week scrape attempt ${attempt + 1} failed:`, e.message);
          if (e.message.includes('Receiving end does not exist')) {
            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id! },
                func: scrapeGoogleCalendarDirect
              });
              const response = results[0]?.result;
              if (response?.events) {
                allEvents.push(...response.events);
                break;
              }
            } catch (injectErr: any) {
              console.log('Failed to inject calendar scraper:', injectErr.message);
            }
          }
        }
        await sleep(2000);
      }
    } catch (e) {
      console.log('Could not navigate to next week:', e);
    }

    // Deduplicate events by title+startTime
    const seen = new Set();
    const uniqueEvents = allEvents.filter(event => {
      const key = event.title + event.startTime;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Total unique events: ${uniqueEvents.length}`);

    if (uniqueEvents.length > 0) {
      currentScan!.progress.total = uniqueEvents.length;
      for (let i = 0; i < uniqueEvents.length; i++) {
        const event = uniqueEvents[i];
        currentScan!.progress.current = i + 1;
        currentScan!.progress.currentItem = event.title;
        broadcastScanStatus();

        const entry = {
          id: `cal-${mailbox.id}-${hashString(event.title + event.startTime)}`,
          mailboxId: mailbox.id,
          title: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          status: 'confirmed',
          isAllDay: event.isAllDay || false,
          source: {
            type: 'calendar',
            calendarName: mailbox.name,
            location: event.location || '',
            rsvpStatus: event.rsvpStatus || ''
          },
          conflicts: [] as string[]
        };

        await storage.saveEntry(entry);
        broadcastNewEntry(entry);
      }
    }

    // Only close the tab if we created it
    if (createdTab) {
      await chrome.tabs.remove(tab.id!);
    }

    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'calendar_scraped',
      details: { entriesFound: uniqueEvents.length }
    });

  } catch (error: any) {
    console.error('Error scanning calendar:', error);
    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'calendar_error',
      details: { error: error.message }
    });
  }
}

async function scanOutlookCalendar(mailbox: any) {
  currentScan!.progress.currentItem = `Fetching Outlook calendar: ${mailbox.name}`;
  broadcastScanStatus();

  try {
    // Determine Outlook calendar URL based on email domain
    const email = mailbox.email || '';
    let calUrl = 'https://outlook.live.com/calendar/';

    // Work/school accounts use office.com
    if (email.includes('@') && !email.match(/@(outlook|hotmail|live|msn)\./i)) {
      calUrl = 'https://outlook.office.com/calendar/';
    }

    // Reuse existing Outlook calendar tab if available, otherwise create one
    const existingTabs = await chrome.tabs.query({
      url: ['https://outlook.live.com/calendar/*', 'https://outlook.office.com/calendar/*', 'https://outlook.office365.com/calendar/*']
    });

    let tab: chrome.tabs.Tab;
    let createdTab = false;

    if (existingTabs.length > 0) {
      tab = existingTabs[0];
      console.log('Reusing existing Outlook calendar tab:', tab.id, 'URL:', tab.url);
      // Give it a moment in case it's still loading
      await sleep(2000);
    } else {
      console.log('Opening Outlook calendar URL:', calUrl);
      tab = await chrome.tabs.create({ url: calUrl, active: false });
      createdTab = true;
      await waitForTabLoad(tab.id!);
      await sleep(8000); // Extra time for Outlook to fully render events
      console.log('Created Outlook calendar tab:', tab.id, 'URL:', tab.url);
    }

    // Scrape events by injecting scraper function directly (bypasses content script issues)
    const allEvents: any[] = [];

    // Scrape current view using direct script injection
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: scrapeOutlookCalendarDirect
        });
        const response = results[0]?.result;
        console.log(`Outlook scrape (this week) attempt ${attempt + 1}: ${response?.count || 0} events`);
        if (response?.events && response.events.length > 0) {
          allEvents.push(...response.events);
          break;
        }
      } catch (e: any) {
        console.log(`Outlook scrape attempt ${attempt + 1} failed:`, e.message);
      }
      await sleep(2000);
    }

    // Navigate to next week and scrape
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: navigateOutlookNextWeek
      });
      await sleep(3000);

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            func: scrapeOutlookCalendarDirect
          });
          const response = results[0]?.result;
          console.log(`Outlook scrape (next week) attempt ${attempt + 1}: ${response?.count || 0} events`);
          if (response?.events && response.events.length > 0) {
            allEvents.push(...response.events);
            break;
          }
        } catch (e: any) {
          console.log(`Outlook next week scrape attempt ${attempt + 1} failed:`, e.message);
        }
        await sleep(2000);
      }
    } catch (e) {
      console.log('Could not navigate Outlook to next week:', e);
    }

    // Deduplicate events
    const seen = new Set();
    const uniqueEvents = allEvents.filter(event => {
      const key = event.title + event.startTime;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Outlook total unique events: ${uniqueEvents.length}`);

    if (uniqueEvents.length > 0) {
      currentScan!.progress.total = uniqueEvents.length;
      for (let i = 0; i < uniqueEvents.length; i++) {
        const event = uniqueEvents[i];
        currentScan!.progress.current = i + 1;
        currentScan!.progress.currentItem = event.title;
        broadcastScanStatus();

        const entry = {
          id: `cal-${mailbox.id}-${hashString(event.title + event.startTime)}`,
          mailboxId: mailbox.id,
          title: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          status: 'confirmed',
          isAllDay: event.isAllDay || false,
          source: {
            type: 'calendar',
            calendarName: mailbox.name,
            location: event.location || '',
            rsvpStatus: event.rsvpStatus || ''
          },
          conflicts: [] as string[]
        };

        await storage.saveEntry(entry);
        broadcastNewEntry(entry);
      }
    }

    // Only close the tab if we created it
    if (createdTab) {
      await chrome.tabs.remove(tab.id!);
    }

    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'outlook_calendar_scraped',
      details: { entriesFound: uniqueEvents.length }
    });

  } catch (error: any) {
    console.error('Error scanning Outlook calendar:', error);
    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'outlook_calendar_error',
      details: { error: error.message }
    });
  }
}

// Simple string hash for generating deterministic IDs
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

async function scanOutlookEmails(mailbox: any, lookbackDays: number) {
  currentScan!.phase = 'emails';
  currentScan!.progress.currentItem = `Scanning Outlook emails: ${mailbox.name}`;
  broadcastScanStatus();

  // Clear old email-sourced entries for this mailbox before scanning
  await storage.clearEntriesBySource(mailbox.id, 'email');

  const email = mailbox.email || '';
  let mailUrl = 'https://outlook.live.com/mail/';
  if (email.includes('@') && !email.match(/@(outlook|hotmail|live|msn)\./i)) {
    mailUrl = 'https://outlook.office.com/mail/';
  }

  try {
    // Reuse existing Outlook mail tab if available
    const existingTabs = await chrome.tabs.query({
      url: ['https://outlook.live.com/mail/*', 'https://outlook.office.com/mail/*', 'https://outlook.office365.com/mail/*']
    });

    let tab: chrome.tabs.Tab;
    let createdTab = false;

    if (existingTabs.length > 0) {
      tab = existingTabs[0];
      console.log('Reusing existing Outlook mail tab:', tab.id);
      await sleep(2000);
    } else {
      console.log('Opening Outlook mail URL:', mailUrl);
      tab = await chrome.tabs.create({ url: mailUrl, active: false });
      createdTab = true;
      await waitForTabLoad(tab.id!);
      await sleep(8000);
    }

    // Try to get emails from content script
    let response: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await chrome.tabs.sendMessage(tab.id!, {
          type: 'SCAN_OUTLOOK_EMAILS',
          options: { lookbackDays }
        });
        console.log(`Outlook email attempt ${attempt + 1}: ${response?.emailCount || 0} emails found`);
        if (response?.emails?.length > 0) break;
      } catch (e: any) {
        console.log(`Outlook email attempt ${attempt + 1} failed:`, e.message);
      }
      await sleep(3000);
    }

    console.log(`Outlook email scan found ${response?.emailCount || 0} emails within ${lookbackDays} days`);

    if (response?.emails) {
      currentScan!.progress.total = response.emails.length;
      currentScan!.progress.current = 0;

      for (let i = 0; i < response.emails.length; i++) {
        if (scanAborted) break;

        const emailItem: any = response.emails[i];
        currentScan!.progress.current = i + 1;
        currentScan!.progress.currentItem = emailItem.subject;
        broadcastScanStatus();

        // Same newsletter/spam filtering as Gmail
        const fromLower = (emailItem.from || '').toLowerCase();
        const subjectLower = emailItem.subject.toLowerCase();
        const isNewsletter = fromLower.includes('noreply') ||
                            fromLower.includes('no-reply') ||
                            fromLower.includes('newsletter') ||
                            fromLower.includes('marketing') ||
                            fromLower.includes('info@') ||
                            fromLower.includes('hello@') ||
                            fromLower.includes('news@') ||
                            fromLower.includes('updates@') ||
                            fromLower.includes('notifications') ||
                            fromLower.includes('@email.') ||
                            fromLower.includes('@mail.') ||
                            fromLower.includes('@e.') ||
                            fromLower.includes('linkedin');

        const isSpamSubject = subjectLower.includes('unsubscribe') ||
                              subjectLower.includes('now available') ||
                              subjectLower.includes('order confirm') ||
                              subjectLower.includes('shipping') ||
                              subjectLower.includes('receipt') ||
                              subjectLower.includes('password') ||
                              subjectLower.includes('security alert') ||
                              subjectLower.includes('verify your') ||
                              subjectLower.includes('welcome to') ||
                              subjectLower.includes('your account');

        if (isNewsletter || isSpamSubject) {
          console.log('Skipping non-meeting Outlook email:', emailItem.subject);
          await sleep(100);
          continue;
        }

        // Heuristic classification
        let meetingInfo = classifyEmailHeuristic(emailItem);

        // Extract date/time
        if (meetingInfo?.isMeeting && !meetingInfo.date) {
          const emailText = `${emailItem.subject} ${emailItem.snippet || ''}`;
          const parsed = extractDateFromText(emailText, emailItem.parsedDate || emailItem.dateText);
          if (parsed) {
            meetingInfo.date = parsed.dateStr;
          }
          const timeMatch = emailText.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i) ||
                            emailText.match(/\b(\d{1,2})\s*(am|pm)\b/i);
          if (timeMatch) {
            let hour = parseInt(timeMatch[1]);
            const minute = timeMatch[2]?.match(/^\d+$/) ? parseInt(timeMatch[2]) : 0;
            const ampm = (timeMatch[3] || timeMatch[2] || '').toLowerCase();
            if (ampm === 'pm' && hour < 12) hour += 12;
            if (ampm === 'am' && hour === 12) hour = 0;
            if (hour >= 0 && hour <= 23 && minute % 5 === 0) {
              meetingInfo.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            }
          }
          if (!meetingInfo.date) meetingInfo = null;
        }

        // Create entry if meeting detected with date
        if (meetingInfo?.isMeeting && meetingInfo.date) {
          let startTime: Date, endTime: Date;
          let isAllDay = false;

          if (meetingInfo.time) {
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            const [hour, minute] = meetingInfo.time.split(':').map(Number);
            if (minute % 5 !== 0) continue;
            startTime = new Date(year, month - 1, day, hour, minute);
            const duration = meetingInfo.duration || 60;
            endTime = new Date(startTime.getTime() + duration * 60 * 1000);
          } else if (meetingInfo.endDate && meetingInfo.endDate !== meetingInfo.date) {
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            const [endYear, endMonth, endDay] = meetingInfo.endDate.split('-').map(Number);
            startTime = new Date(year, month - 1, day, 0, 0);
            endTime = new Date(endYear, endMonth - 1, endDay, 23, 59);
            isAllDay = true;
          } else {
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            startTime = new Date(year, month - 1, day, 9, 0);
            endTime = new Date(year, month - 1, day, 10, 0);
            isAllDay = true;
          }

          const title = meetingInfo.title || emailItem.subject;
          if (title.toLowerCase() === 'event title' || title.includes('YYYY')) continue;

          const tentativeEntry = {
            id: `email-${mailbox.id}-${emailItem.id}`,
            mailboxId: mailbox.id,
            title: title,
            startTime: startTime!.toISOString(),
            endTime: endTime!.toISOString(),
            isAllDay,
            status: 'tentative',
            source: {
              type: 'email',
              emailSubject: emailItem.subject,
              emailSnippet: emailItem.snippet?.substring(0, 200) || '',
              emailDate: emailItem.parsedDate || emailItem.dateText,
              emailThreadId: emailItem.id,
            },
            conflicts: [] as string[]
          };

          await storage.saveEntry(tentativeEntry);
          broadcastNewEntry(tentativeEntry);
        }

        await sleep(100);
      }
    }

    if (createdTab) {
      await chrome.tabs.remove(tab.id!);
    }

    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'outlook_emails_scanned',
      details: { emailsProcessed: currentScan!.progress.current }
    });

  } catch (error: any) {
    console.error('Error scanning Outlook emails:', error);
    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'outlook_email_error',
      details: { error: error.message }
    });
  }
}

async function scanEmails(mailbox: any, lookbackDays: number) {
  if (mailbox.provider === 'outlook') {
    await scanOutlookEmails(mailbox, lookbackDays);
    return;
  }

  currentScan!.phase = 'emails';
  currentScan!.progress.currentItem = `Opening Gmail: ${mailbox.name}`;
  broadcastScanStatus();

  // Clear old email-sourced entries for this mailbox before scanning
  await storage.clearEntriesBySource(mailbox.id, 'email');

  // Open Gmail tab for this account
  // Use All Mail so we catch emails with labels that skip the inbox
  const gmailUrl = `https://mail.google.com/mail/u/${mailbox.accountIndex}/#all`;

  try {
    // Try to find an existing Gmail tab for this account first
    const existingTabs = await chrome.tabs.query({ url: `https://mail.google.com/mail/u/${mailbox.accountIndex}/*` });
    let tab: chrome.tabs.Tab;
    let createdTab = false;

    if (existingTabs.length > 0) {
      tab = existingTabs[0];
      // Navigate to All Mail view — hash change won't trigger full page load
      await chrome.tabs.update(tab.id!, { url: gmailUrl });
      // Hash changes don't trigger onUpdated 'complete', just wait for Gmail to render
      await sleep(4000);
      console.log('Reusing existing Gmail tab:', tab.id);
    } else {
      tab = await chrome.tabs.create({ url: gmailUrl, active: false });
      createdTab = true;
      await waitForTabLoad(tab.id!);
      await sleep(5000);
      console.log('Created new Gmail tab:', tab.id);
    }

    // Retry sending message to content script (it may not be ready yet)
    let response: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await chrome.tabs.sendMessage(tab.id!, {
          type: 'SCAN_VISIBLE_EMAILS',
          options: { lookbackDays }
        });
        console.log(`Attempt ${attempt + 1}: totalVisible=${response?.totalVisible}, emailCount=${response?.emailCount}`);
        if (response?.emails?.length > 0 || response?.totalVisible > 0) break;
      } catch (e: any) {
        console.log(`Attempt ${attempt + 1} failed:`, e.message);
        // Try to inject content script if it's not loaded
        if (e.message.includes('Receiving end does not exist')) {
          console.log('Injecting Gmail scraper directly...');
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id! },
              func: scrapeGmailEmailsDirect,
              args: [lookbackDays]
            });
            response = results[0]?.result;
            if (response?.emails?.length > 0) {
              console.log('Direct injection found', response.emails.length, 'emails');
              break;
            }
          } catch (injectErr: any) {
            console.log('Failed to inject scraper:', injectErr.message);
          }
        }
      }
      await sleep(3000);
    }

    console.log(`Scan found ${response?.emailCount || 0} emails within ${lookbackDays} days (${response?.totalVisible || 0} total visible)`);

    if (response?.emails) {
      currentScan!.progress.total = response.emails.length;
      currentScan!.progress.current = 0;

      // Process each email
      for (let i = 0; i < response.emails.length; i++) {
        if (scanAborted) break;

        const email: Email = response.emails[i];
        currentScan!.progress.current = i + 1;
        currentScan!.progress.currentItem = email.subject;
        broadcastScanStatus();

        // Skip obvious newsletters/marketing emails BEFORE LLM (saves ~30s per email)
        const fromLower = (email.from || '').toLowerCase();
        const subjectLower = email.subject.toLowerCase();
        const isNewsletter = fromLower.includes('noreply') ||
                            fromLower.includes('no-reply') ||
                            fromLower.includes('newsletter') ||
                            fromLower.includes('marketing') ||
                            fromLower.includes('info@') ||
                            fromLower.includes('hello@') ||
                            fromLower.includes('news@') ||
                            fromLower.includes('updates@') ||
                            fromLower.includes('notifications') ||
                            fromLower.includes('@email.') ||
                            fromLower.includes('@mail.') ||
                            fromLower.includes('@e.') ||
                            fromLower.includes('freegle') ||
                            fromLower.includes('linkedin') ||
                            fromLower.includes('.com') && !fromLower.includes('gmail.com') && !fromLower.includes('outlook.com');

        // Also skip common non-meeting subjects
        const isSpamSubject = subjectLower.includes('unsubscribe') ||
                              subjectLower.includes('now available') ||
                              subjectLower.includes('order confirm') ||
                              subjectLower.includes('shipping') ||
                              subjectLower.includes('receipt') ||
                              subjectLower.includes('password') ||
                              subjectLower.includes('security alert') ||
                              subjectLower.includes('verify your') ||
                              subjectLower.includes('welcome to') ||
                              subjectLower.includes('your account');

        if (isNewsletter || isSpamSubject) {
          console.log('Skipping non-meeting email:', email.subject);
          await sleep(100);
          continue;
        }

        // Heuristic classification first (instant), LLM fallback for ambiguous
        let meetingInfo: MeetingAnalysis | null = null;

        meetingInfo = classifyEmailHeuristic(email);

        // Extract date and time with regex for any classified meeting
        if (meetingInfo?.isMeeting && !meetingInfo.date) {
          const emailText = `${email.subject} ${email.snippet || ''}`;
          const parsed = extractDateFromText(emailText, email.parsedDate || email.dateText);
          if (parsed) {
            console.log('Regex date extraction:', email.subject, '→', parsed.dateStr);
            meetingInfo.date = parsed.dateStr;
          }
          // Extract time from email text (e.g., "at 2pm", "10:30", "8:30am")
          const timeMatch = emailText.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i) ||
                            emailText.match(/\b(\d{1,2})\s*(am|pm)\b/i);
          if (timeMatch) {
            let hour = parseInt(timeMatch[1]);
            const minute = timeMatch[2]?.match(/^\d+$/) ? parseInt(timeMatch[2]) : 0;
            const ampm = (timeMatch[3] || timeMatch[2] || '').toLowerCase();
            if (ampm === 'pm' && hour < 12) hour += 12;
            if (ampm === 'am' && hour === 12) hour = 0;
            if (hour >= 0 && hour <= 23 && minute % 5 === 0) {
              meetingInfo.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
              console.log('Regex time extraction:', email.subject, '→', meetingInfo.time);
            }
          }
          // No date extracted = can't place on calendar, discard
          if (!meetingInfo.date) {
            meetingInfo = null;
          }
        }

        // Self-email with date pattern detection (reminders to self)
        if (!meetingInfo) {
          const isSelfEmail = email.from?.toLowerCase().includes(mailbox.email.toLowerCase());
          if (isSelfEmail) {
            // Look for date patterns in subject
            const datePatterns = [
              /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,  // "Feb 2", "January 15"
              /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b/i,  // "2 Feb", "15 January"
              /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/,  // "2/15", "15-02-2026"
              /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,  // Day names
              /\b(tomorrow|next\s+week|this\s+week)\b/i  // Relative dates
            ];
            const hasDate = datePatterns.some(pattern => pattern.test(email.subject));
            if (hasDate) {
              // Extract the date from subject and try to parse it
              const extractedDate = extractDateFromText(email.subject, email.parsedDate);
              meetingInfo = {
                isMeeting: true,
                title: email.subject,
                date: extractedDate?.dateStr,
                confidence: 'medium'
              };
            }
          }
        }

        // Only create entry if we have a valid date extracted
        if (meetingInfo?.isMeeting && meetingInfo.date) {
          let startTime: Date, endTime: Date;
          let isAllDay = false;

          if (meetingInfo.time) {
            // LLM extracted specific date/time - validate time is reasonable (multiple of 5)
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            const [hour, minute] = meetingInfo.time.split(':').map(Number);
            if (minute % 5 !== 0) {
              // Suspicious time - likely hallucinated, reject the entire entry
              console.log('Rejecting entry with non-5-minute time:', meetingInfo.time, 'for:', email.subject);
              continue;
            }
            startTime = new Date(year, month - 1, day, hour, minute);
            const duration = meetingInfo.duration || 60;
            endTime = new Date(startTime.getTime() + duration * 60 * 1000);
          } else if (meetingInfo.endDate && meetingInfo.endDate !== meetingInfo.date) {
            // Multi-day event
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            const [endYear, endMonth, endDay] = meetingInfo.endDate.split('-').map(Number);
            startTime = new Date(year, month - 1, day, 0, 0);
            endTime = new Date(endYear, endMonth - 1, endDay, 23, 59);
            isAllDay = true;
          } else {
            // Date extracted but no time - create all-day event
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            startTime = new Date(year, month - 1, day, 9, 0); // Default to 9 AM
            endTime = new Date(year, month - 1, day, 10, 0);  // 1 hour default
            isAllDay = true;
          }

          // Skip if title is template text
          const title = meetingInfo.title || email.subject;
          if (title.toLowerCase() === 'event title' || title.includes('YYYY')) {
            continue;
          }

          const tentativeEntry = {
            id: `email-${mailbox.id}-${email.id}`,
            mailboxId: mailbox.id,
            title: title,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            isAllDay: isAllDay,
            status: 'tentative',
            source: {
              type: 'email',
              emailSubject: email.subject,
              emailSnippet: email.snippet?.substring(0, 200) || '',
              emailDate: email.parsedDate || email.dateText,
              emailThreadId: email.id,
              llmAnalysis: llmReady ? meetingInfo : undefined
            },
            conflicts: [] as string[]
          };

          await storage.saveEntry(tentativeEntry);
          broadcastNewEntry(tentativeEntry);
        }

        // Small delay between emails
        await sleep(100);
      }
    }

    // Only close the tab if we created it
    if (createdTab) {
      await chrome.tabs.remove(tab.id!);
    }

    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'emails_scanned',
      details: { emailsProcessed: currentScan!.progress.current, llmUsed: llmReady }
    });

  } catch (error: any) {
    console.error('Error scanning emails:', error);
    await storage.addScanLog({
      mailboxId: mailbox.id,
      action: 'email_error',
      details: { error: error.message }
    });
  }
}

async function detectAllConflicts() {
  currentScan!.phase = 'analyzing';
  currentScan!.progress.currentItem = 'Detecting conflicts';
  broadcastScanStatus();

  const entries = await storage.getAllEntries();
  const conflicts = storage.detectConflicts(entries);

  // Update entries with conflict info
  for (const entry of entries) {
    if (conflicts.has(entry.id)) {
      entry.conflicts = conflicts.get(entry.id);
      await storage.saveEntry(entry);
    }
  }
}

function pauseScan() {
  if (currentScan?.status === 'scanning') {
    currentScan.status = 'paused';
    broadcastScanStatus();
    return { paused: true };
  }
  return { error: 'No scan to pause' };
}

function cancelScan() {
  scanAborted = true;
  if (currentScan) {
    currentScan.status = 'cancelled';
    broadcastScanStatus();
  }
  return { cancelled: true };
}

function getScanStatus() {
  return currentScan || { status: 'idle' };
}

// ============ Broadcasting ============

function broadcastScanStatus() {
  chrome.runtime.sendMessage({
    type: 'SCAN_STATUS_UPDATE',
    status: currentScan
  }).catch(() => {}); // Ignore if no listeners

  // Also send to any open calendar view tabs
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.url?.includes(chrome.runtime.id)) {
        chrome.tabs.sendMessage(tab.id!, {
          type: 'SCAN_STATUS_UPDATE',
          status: currentScan
        }).catch(() => {});
      }
    }
  });
}

function broadcastNewEntry(entry: any) {
  chrome.runtime.sendMessage({
    type: 'NEW_ENTRY',
    entry
  }).catch(() => {});

  // Send to calendar view tabs for live updates
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.url?.includes('calendar-view')) {
        chrome.tabs.sendMessage(tab.id!, {
          type: 'NEW_ENTRY',
          entry
        }).catch(() => {});
      }
    }
  });
}

// ============ Calendar View ============

async function openCalendarView() {
  const url = chrome.runtime.getURL('calendar-view/index.html');

  // Check if already open
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url === url) {
      await chrome.tabs.update(tab.id!, { active: true });
      return { opened: true, tabId: tab.id };
    }
  }

  // Open new tab
  const tab = await chrome.tabs.create({ url });
  return { opened: true, tabId: tab.id };
}

// ============ Utilities ============

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract date from text like "Feb 2", "on January 15", "next Monday"
function extractDateFromText(text: string, emailDate?: string): { dateStr: string } | null {
  const baseDate = emailDate ? new Date(emailDate) : new Date();
  const currentYear = baseDate.getFullYear();

  const months: { [key: string]: number } = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };

  // Helper to resolve 2-digit or 4-digit year
  function resolveYear(yearStr: string | undefined): number | null {
    if (!yearStr) return null;
    let y = parseInt(yearStr);
    if (y < 100) y += 2000; // "26" → 2026
    return y;
  }

  // Try "Day Month [Year]" pattern first (3rd February 2026, 2 Feb, 15 January)
  // This runs before Month Day to correctly parse "3rd February 26" (day=3, not day=26)
  const dayMonthMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{2,4}))?\b/i);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1]);
    const month = months[dayMonthMatch[2].toLowerCase().substring(0, 3)];
    if (month !== undefined && day >= 1 && day <= 31) {
      let year = resolveYear(dayMonthMatch[3]) || currentYear;
      if (!dayMonthMatch[3]) {
        const testDate = new Date(year, month, day);
        if (testDate < baseDate) {
          year++;
        }
      }
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { dateStr };
    }
  }

  // Try "Month Day [Year]" pattern (Feb 2, January 15, February 3rd 2026)
  const monthDayMatch = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2,4}))?\b/i);
  if (monthDayMatch) {
    const month = months[monthDayMatch[1].toLowerCase().substring(0, 3)];
    const day = parseInt(monthDayMatch[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      let year = resolveYear(monthDayMatch[3]) || currentYear;
      if (!monthDayMatch[3]) {
        const testDate = new Date(year, month, day);
        if (testDate < baseDate) {
          year++;
        }
      }
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { dateStr };
    }
  }

  return null;
}

function waitForTabLoad(tabId: number, timeout = 15000): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.log('waitForTabLoad timed out for tab', tabId);
      resolve();
    }, timeout);
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ============ Badge Updates ============

function updateBadge(text: string, color: string) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Update badge based on scan status
setInterval(() => {
  if (currentScan?.status === 'scanning') {
    const percent = currentScan.progress.total > 0
      ? Math.round((currentScan.progress.current / currentScan.progress.total) * 100)
      : 0;
    updateBadge(`${percent}%`, '#4285f4');
  } else {
    updateBadge('', '#4285f4');
  }
}, 1000);

// Handle notification clicks
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    openCalendarView();
  }
});

// Deduplicate mailboxes on startup (clean up from previous bugs)
(async () => {
  const mailboxes = await storage.getAllMailboxes();
  const seen = new Map<string, any>();
  for (const mb of mailboxes) {
    if (seen.has(mb.email)) {
      // Keep the newer one, delete the older
      const existing = seen.get(mb.email);
      const keep = mb.createdAt > existing.createdAt ? mb : existing;
      const remove = mb.createdAt > existing.createdAt ? existing : mb;
      await storage.deleteMailbox(remove.id);
      seen.set(mb.email, keep);
      console.log(`Calipso: Removed duplicate mailbox for ${mb.email}`);
    } else {
      seen.set(mb.email, mb);
    }
  }
})();

// ============ Outlook Injected Functions ============
// These functions are injected directly into Outlook pages via chrome.scripting.executeScript

function scrapeOutlookCalendarDirect() {
  const events: any[] = [];
  const seenEvents = new Set();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function parseOutlookTime(date: any, timeStr: any) {
    const result = new Date(date);
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (match) {
      let hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const meridiem = match[3]?.toUpperCase();
      if (meridiem === 'PM' && hours !== 12) hours += 12;
      else if (meridiem === 'AM' && hours === 12) hours = 0;
      result.setHours(hours, minutes, 0, 0);
    }
    return result;
  }

  function parseOutlookEventDescription(description: string) {
    try {
      if (description.toLowerCase().startsWith('canceled:')) return null;

      const parts = description.split(', ');
      if (parts.length < 4) return null;

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

      // Find date pattern
      let dateStr = '';
      for (let i = timePartIndex + 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (days.includes(part) && i + 2 < parts.length) {
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

      const isAllDay = description.toLowerCase().includes('all day');

      if (!dateStr && !isAllDay) {
        for (let i = 1; i < parts.length; i++) {
          for (const month of months) {
            if (parts[i].includes(month)) {
              const match = parts[i].match(new RegExp(`(${month})\\s+(\\d{1,2})`));
              if (match) {
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
        startTime = new Date(eventDate);
        startTime.setHours(0, 0, 0, 0);
        endTime = new Date(eventDate);
        endTime.setHours(23, 59, 59, 999);
      }

      let rsvpStatus = '';
      if (description.includes('Tentative')) rsvpStatus = 'tentative';
      else if (description.includes('Busy')) rsvpStatus = 'accepted';
      else if (description.includes('Free')) rsvpStatus = 'free';

      return {
        title,
        startTime: startTime!.toISOString(),
        endTime: endTime!.toISOString(),
        isAllDay: isAllDay || !timeStr,
        location: '',
        rsvpStatus
      };
    } catch (e) {
      return null;
    }
  }

  // Scrape events from button aria-labels
  const eventButtons = document.querySelectorAll('button[aria-label*="to"]');
  for (const btn of eventButtons) {
    const description = btn.getAttribute('aria-label') || '';
    if (!description || description.length < 20) continue;

    const event = parseOutlookEventDescription(description);
    if (event && !seenEvents.has(event.title + event.startTime)) {
      seenEvents.add(event.title + event.startTime);
      events.push(event);
    }
  }

  // Also try div elements with aria-label (Outlook uses both)
  const eventDivs = document.querySelectorAll('div[aria-label*="to"]');
  for (const div of eventDivs) {
    const description = div.getAttribute('aria-label') || '';
    if (!description || description.length < 20) continue;
    if (!description.includes(',')) continue;

    const event = parseOutlookEventDescription(description);
    if (event && !seenEvents.has(event.title + event.startTime)) {
      seenEvents.add(event.title + event.startTime);
      events.push(event);
    }
  }

  console.log('Outlook direct scraper found', events.length, 'events');
  return { events, count: events.length, url: window.location.href };
}

function navigateOutlookNextWeek() {
  const nextButton = document.querySelector('[aria-label*="Next"]') ||
                     document.querySelector('[aria-label*="Forward"]') ||
                     document.querySelector('button[title*="Next"]') ||
                     document.querySelector('[data-icon-name="ChevronRight"]')?.closest('button');
  if (nextButton) {
    (nextButton as HTMLElement).click();
    return { success: true };
  }
  return { success: false, error: 'Next button not found' };
}

// Gmail direct scraper - injected when content script isn't available
function scrapeGmailEmailsDirect(lookbackDays: number) {
  const emails: any[] = [];

  // Calculate cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
  cutoffDate.setHours(0, 0, 0, 0);

  // Parse Gmail date
  function parseGmailDate(dateText: string) {
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
      const months: any = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = months[monthDayMatch[1].toLowerCase()];
      const day = parseInt(monthDayMatch[2]);
      const date = new Date(now.getFullYear(), month, day);
      if (date > now) date.setFullYear(date.getFullYear() - 1);
      return date;
    }

    // Full date: "9/20/22"
    const fullDateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (fullDateMatch) {
      const month = parseInt(fullDateMatch[1]) - 1;
      const day = parseInt(fullDateMatch[2]);
      let year = parseInt(fullDateMatch[3]);
      if (year < 100) year += year > 50 ? 1900 : 2000;
      return new Date(year, month, day);
    }

    return null;
  }

  // Find email rows
  const rows = document.querySelectorAll('tr.zA');

  for (const row of rows) {
    try {
      const subjectEl = row.querySelector('.y6 span, .bog');
      const subject = subjectEl?.textContent?.trim() || 'No Subject';

      const senderEl = row.querySelector('.yW span[email], .yP, .zF');
      const from = (senderEl as HTMLElement)?.getAttribute('email') || senderEl?.textContent?.trim() || 'Unknown';

      const dateEl = row.querySelector('.xW span, .bq3');
      const dateText = dateEl?.textContent?.trim() || (dateEl as HTMLElement)?.getAttribute('title') || '';

      const snippetEl = row.querySelector('.y2, .Zs');
      const snippet = snippetEl?.textContent?.trim() || '';

      // Try to extract To/CC from row (Gmail shows this in some views)
      // Note: Full To/CC requires opening the email, but we can check if "me" indicator is present
      const toMeIndicator = row.querySelector('.yP')?.textContent?.includes('me') ||
                           row.querySelector('.zF')?.textContent?.includes('me');

      const parsedDate = parseGmailDate(dateText);
      if (!parsedDate || parsedDate < cutoffDate) continue;

      // Generate deterministic ID from email content to avoid duplicates across scans
      const emailKey = `${subject}-${from}-${dateText}`;
      let hash = 0;
      for (let i = 0; i < emailKey.length; i++) {
        hash = ((hash << 5) - hash) + emailKey.charCodeAt(i);
        hash = hash & hash;
      }
      const emailId = `email-${Math.abs(hash).toString(36)}`;

      emails.push({
        id: emailId,
        subject,
        from,
        dateText,
        snippet,
        parsedDate: parsedDate.toISOString(),
        toMe: toMeIndicator || false
      });
    } catch (e) {
      console.warn('Failed to extract email:', e);
    }
  }

  return {
    emailCount: emails.length,
    totalVisible: rows.length,
    cutoffDate: cutoffDate.toISOString(),
    emails: emails.slice(0, 50)
  };
}

// ============ Google Calendar Injected Functions ============

function scrapeGoogleCalendarDirect() {
  const events: any[] = [];
  const processedLabels = new Set();

  const months: { [key: string]: number } = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  function findDatePart(parts: string[]) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i].trim();
      if (p.match(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/)) {
        return p;
      }
    }
    return '';
  }

  function parseCalDate(dateStr: string) {
    const multiMatch = dateStr.match(/^(\d{1,2})\s+(\w+)\s+(?:–|to)\s+\d{1,2}\s+\w+\s+(\d{4})/);
    if (multiMatch) return new Date(`${multiMatch[2]} ${multiMatch[1]}, ${multiMatch[3]}`);
    const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (match) return new Date(`${match[2]} ${match[1]}, ${match[3]}`);
    return null;
  }

  function setTime(date: Date, timeStr: string) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const result = new Date(date);
    result.setHours(hours, minutes, 0, 0);
    return result;
  }

  const skipPrefixes = ['Needs RSVP', 'Accepted', 'Declined', 'Tentative', 'No location', 'Location:', 'All day'];

  const chips = document.querySelectorAll('[data-eventchip]');
  for (const chip of chips) {
    const text = chip.textContent?.trim();
    if (!text || text === 'Add location') continue;

    let label = text;
    const yearMatch = text.match(/\d{4}/);
    if (yearMatch) {
      const yearEnd = text.indexOf(yearMatch[0]) + yearMatch[0].length;
      label = text.substring(0, yearEnd);
    }

    if (processedLabels.has(label)) continue;

    const parts = label.split(', ');
    if (parts.length < 3) continue;

    let startTime = null, endTime = null, isAllDay = false, title = '', location = '', status = '';
    const dateStr = findDatePart(parts);

    if (parts[0].trim() === 'All day') {
      isAllDay = true;
      const titleParts: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        if (p === dateStr || (dateStr && p.match(/\d{4}/))) break;
        if (skipPrefixes.some(sp => p.startsWith(sp))) continue;
        titleParts.push(p);
      }
      title = titleParts.join(', ');
      const eventDate = parseCalDate(dateStr);
      if (eventDate) {
        startTime = new Date(eventDate); startTime.setHours(0, 0, 0, 0);
        endTime = new Date(eventDate); endTime.setHours(23, 59, 59, 999);
      }
    } else {
      const timeMatch = parts[0].match(/^(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})$/);
      if (!timeMatch || !dateStr) continue;
      const eventDate = parseCalDate(dateStr);
      if (!eventDate) continue;
      startTime = setTime(eventDate, timeMatch[1]);
      endTime = setTime(eventDate, timeMatch[2]);
      const titleParts: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        if (p === dateStr || (dateStr && p.match(/\d{4}/))) break;
        if (skipPrefixes.some(sp => p.startsWith(sp))) continue;
        titleParts.push(p);
      }
      title = titleParts.join(', ');
    }

    if (!title || !startTime) continue;

    if (label.includes('Needs RSVP')) status = 'needs_rsvp';
    else if (label.includes('Accepted')) status = 'accepted';
    else if (label.includes('Declined')) status = 'declined';
    else if (label.includes('Tentative')) status = 'tentative';

    const locIdx = parts.findIndex(p => p.startsWith('Location:'));
    if (locIdx !== -1) location = parts[locIdx].replace('Location: ', '');

    processedLabels.add(label);
    events.push({
      title, startTime: startTime.toISOString(), endTime: endTime?.toISOString() || new Date(startTime.getTime() + 3600000).toISOString(),
      isAllDay, location, rsvpStatus: status
    });
  }

  console.log('Google Calendar direct scraper found', events.length, 'events');
  return { events, count: events.length, url: window.location.href };
}

function navigateGoogleCalendarNextWeek() {
  const nextButton = document.querySelector('[data-value="next"]') ||
                     document.querySelector('button[aria-label*="Next"]') ||
                     document.querySelector('button[aria-label*="Forward"]');
  if (nextButton) {
    (nextButton as HTMLElement).click();
    return { success: true };
  }
  return { success: false, error: 'Next button not found' };
}

console.log('Calipso: Service worker initialized');
