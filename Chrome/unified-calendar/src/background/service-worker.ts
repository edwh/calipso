/**
 * Background service worker
 * Orchestrates scanning, manages tabs, and coordinates all extension activities
 * Includes WebLLM integration for meeting detection
 */

import * as storage from '../lib/storage';
import { fetchAndParseIcal } from '../lib/ics-parser';
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

    llmEngine = await CreateMLCEngine('Llama-3.2-1B-Instruct-q4f16_1-MLC', {
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

async function analyzeEmailWithLLM(email: Email): Promise<MeetingAnalysis | null> {
  if (!llmReady || !llmEngine) {
    return null;
  }

  const prompt = `Analyze this email for meeting/appointment scheduling content.

From: ${email.from || 'unknown'}
Date: ${email.dateText || email.parsedDate || 'unknown'}
Subject: ${email.subject}
Snippet: ${email.snippet || ''}

If this email discusses a specific meeting, appointment, or scheduled event, respond with JSON:
{
  "isMeeting": true,
  "title": "meeting title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "duration": 60,
  "confidence": "high|medium|low"
}

If NOT about a specific scheduled meeting/appointment, respond with:
{"isMeeting": false}

Important:
- Only mark as meeting if there's a SPECIFIC date/time mentioned or clearly implied
- Interpret relative dates (e.g., "next Wednesday", "tomorrow") relative to the email date
- Generic mentions of "let's meet sometime" without a specific time are NOT meetings
- Scheduled calls, appointments, deliveries etc. ARE meetings
- Respond with JSON only, no other text`;

  try {
    const response = await llmEngine.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a meeting detection assistant. Output JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 200
    });

    const result = response.choices[0]?.message?.content || '';

    // Parse JSON from response
    let jsonStr = result;
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    try {
      return JSON.parse(jsonStr.trim());
    } catch (e) {
      // Try to extract JSON object from the text
      const objMatch = result.match(/\{[\s\S]*\}/);
      if (objMatch) {
        return JSON.parse(objMatch[0]);
      }
      console.warn('Failed to parse LLM response:', result);
      return null;
    }
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

    // If iCal URL is configured, use it
    if (mailbox.icalUrl) {
      const entries = await fetchAndParseIcal(
        mailbox.icalUrl,
        mailbox.id,
        mailbox.name
      );
      for (const entry of entries) {
        await storage.saveEntry(entry);
        broadcastNewEntry(entry);
      }
      await storage.addScanLog({
        mailboxId: mailbox.id,
        action: 'calendar_ical_scanned',
        details: { entriesFound: entries.length }
      });
      return;
    }

    // Otherwise, scrape from Google Calendar web page
    const calUrl = `https://calendar.google.com/calendar/u/${mailbox.accountIndex}/r/week`;

    // Try to find an existing calendar tab
    const existingTabs = await chrome.tabs.query({
      url: `https://calendar.google.com/calendar/u/${mailbox.accountIndex}/*`
    });

    let tab: chrome.tabs.Tab;
    let createdTab = false;

    if (existingTabs.length > 0) {
      tab = existingTabs[0];
      await chrome.tabs.update(tab.id!, { url: calUrl });
      await sleep(4000);
      console.log('Reusing existing Calendar tab:', tab.id);
    } else {
      tab = await chrome.tabs.create({ url: calUrl, active: false });
      createdTab = true;
      await waitForTabLoad(tab.id!);
      await sleep(5000);
      console.log('Created new Calendar tab:', tab.id);
    }

    // Scrape events from the calendar page
    let response: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await chrome.tabs.sendMessage(tab.id!, {
          type: 'SCRAPE_CALENDAR_EVENTS'
        });
        console.log(`Calendar scrape attempt ${attempt + 1}: ${response?.count || 0} events`);
        if (response?.count > 0) break;
      } catch (e: any) {
        console.log(`Calendar scrape attempt ${attempt + 1} failed:`, e.message);
      }
      await sleep(3000);
    }

    if (response?.events) {
      currentScan!.progress.total = response.events.length;
      for (let i = 0; i < response.events.length; i++) {
        const event = response.events[i];
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
      details: { entriesFound: response?.count || 0 }
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

async function scanEmails(mailbox: any, lookbackDays: number) {
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

        // Try LLM analysis first, fall back to keyword matching
        let meetingInfo: MeetingAnalysis | null = null;

        if (llmReady) {
          meetingInfo = await analyzeEmailWithLLM(email);
          if (meetingInfo && !meetingInfo.isMeeting) {
            meetingInfo = null;
          }
          if (meetingInfo?.confidence === 'low') {
            meetingInfo = null; // Skip low confidence matches
          }
        }

        // Keyword fallback when LLM is not available or didn't find a meeting
        if (!meetingInfo) {
          const meetingKeywords = ['meet', 'call', 'schedule', 'available', 'calendar', 'appointment', 'invite', 'zoom', 'teams', 'webex'];
          const hasKeyword = meetingKeywords.some(kw =>
            email.subject.toLowerCase().includes(kw) ||
            email.snippet.toLowerCase().includes(kw)
          );
          if (hasKeyword) {
            meetingInfo = { isMeeting: true, title: email.subject, confidence: 'low' };
          }
        }

        if (meetingInfo?.isMeeting) {
          const emailDate = email.parsedDate ? new Date(email.parsedDate) : new Date();

          let startTime: Date, endTime: Date;
          if (meetingInfo.date && meetingInfo.time) {
            // LLM extracted specific date/time
            const [year, month, day] = meetingInfo.date.split('-').map(Number);
            const [hour, minute] = meetingInfo.time.split(':').map(Number);
            startTime = new Date(year, month - 1, day, hour, minute);
            const duration = meetingInfo.duration || 60;
            endTime = new Date(startTime.getTime() + duration * 60 * 1000);
          } else {
            // Fallback: use email date
            startTime = new Date(emailDate);
            endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
          }

          const tentativeEntry = {
            id: `email-${mailbox.id}-${email.id}`,
            mailboxId: mailbox.id,
            title: meetingInfo.title || email.subject,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            status: 'tentative',
            source: {
              type: 'email',
              emailSubject: email.subject,
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
      console.log(`Unified Calendar: Removed duplicate mailbox for ${mb.email}`);
    } else {
      seen.set(mb.email, mb);
    }
  }
})();

console.log('Unified Calendar: Service worker initialized');
