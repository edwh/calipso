# Unified Calendar Chrome Extension - Design Document

## Overview

A Chrome extension that creates a unified calendar view across multiple Gmail accounts by:
1. Fetching calendar data via private iCal URLs
2. Scanning emails to detect meeting negotiations in progress
3. Using an in-browser LLM (WebLLM) for privacy-safe email analysis
4. Displaying a week view with confirmed and tentative appointments

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                          │
├─────────────────────────────────────────────────────────────┤
│  Toolbar Icon (Browser Action)                              │
│  - Click on Gmail → "Add this mailbox"                      │
│  - Click elsewhere → Popup menu (scan, view calendar, etc.) │
├─────────────────────────────────────────────────────────────┤
│  Content Scripts                                             │
│  - gmail-adapter.ts (uses InboxSDK/gmail.js)                │
│  - calendar-setup.ts (navigates to find iCal URL)           │
├─────────────────────────────────────────────────────────────┤
│  Background Service Worker                                   │
│  - Orchestrates scans, manages tabs                         │
│  - Fetches iCal URLs, parses ICS                            │
│  - Coordinates WebLLM processing                            │
├─────────────────────────────────────────────────────────────┤
│  WebLLM Engine                                               │
│  - Runs Phi-3-mini or Gemma-2B in-browser                   │
│  - Analyzes emails for meeting negotiations                 │
├─────────────────────────────────────────────────────────────┤
│  Storage (IndexedDB)                                         │
│  - Mailbox configs (name, iCal URL, account index)          │
│  - Calendar entries (with provenance)                       │
│  - Scan state (last scanned email ID per mailbox)           │
├─────────────────────────────────────────────────────────────┤
│  Week View Tab                                               │
│  - Renders unified calendar                                 │
│  - Color = mailbox, solid/dashed = confirmed/tentative      │
└─────────────────────────────────────────────────────────────┘
```

## Progress Indicators

```
┌─────────────────────────────────────────────────────────────┐
│  Progress System                                             │
├─────────────────────────────────────────────────────────────┤
│  Toolbar Badge                                               │
│  - Shows scan status icon (spinning when active)            │
│  - Badge text: "23%" or "142" (emails remaining)            │
├─────────────────────────────────────────────────────────────┤
│  Popup Progress Panel                                        │
│  - Current phase: "Scanning work@gmail.com"                 │
│  - Progress bar: "Email 142 of 856"                         │
│  - Current action: "Analyzing thread: Re: Q1 Planning"      │
│  - Time elapsed / estimated remaining                       │
│  - Pause / Cancel buttons                                   │
├─────────────────────────────────────────────────────────────┤
│  Notification on Completion                                  │
│  - "Scan complete: Found 12 tentative meetings"             │
│  - Click to open week view                                  │
├─────────────────────────────────────────────────────────────┤
│  Scan Log (in settings/debug)                                │
│  - Detailed log of what was scanned                         │
│  - Any errors or skipped items                              │
└─────────────────────────────────────────────────────────────┘
```

## Data Models

### Mailbox Configuration
```typescript
interface MailboxConfig {
  id: string;
  name: string;                    // User-friendly name
  email: string;                   // Email address
  accountIndex: number;            // Gmail /u/0/, /u/1/ etc.
  icalUrl: string;                 // Private iCal URL
  color: string;                   // Display color
  lastScanTimestamp: number;       // When last scanned
  lastScannedEmailId: string;      // For incremental scanning
}
```

### Calendar Entry
```typescript
interface CalendarEntry {
  id: string;
  mailboxId: string;               // Which mailbox this came from
  title: string;
  startTime: Date;
  endTime: Date;
  status: 'confirmed' | 'tentative';
  source: {
    type: 'calendar' | 'email';
    // For calendar source:
    calendarName?: string;
    eventId?: string;
    // For email source:
    emailSubject?: string;
    emailDate?: Date;
    emailThreadId?: string;
    negotiationState?: NegotiationState;
  };
  conflicts: string[];             // IDs of conflicting entries
}

interface NegotiationState {
  proposedTimes: ProposedTime[];
  status: 'proposed' | 'counter-proposed' | 'awaiting-response' | 'confirmed' | 'declined';
  participants: string[];
  lastUpdate: Date;
}

interface ProposedTime {
  start: Date;
  end: Date;
  proposedBy: string;
  status: 'pending' | 'accepted' | 'rejected';
}
```

### Scan State
```typescript
interface ScanState {
  mailboxId: string;
  status: 'idle' | 'scanning' | 'paused' | 'error';
  phase: 'calendar' | 'emails' | 'analyzing' | 'complete';
  progress: {
    current: number;
    total: number;
    currentItem: string;           // Current email subject
  };
  startTime: number;
  errors: string[];
}
```

## Key Workflows

### Adding a Mailbox
1. User navigates to Gmail
2. Clicks toolbar icon → "Add this mailbox"
3. Extension detects account from URL (/u/0/, /u/1/)
4. Opens Google Calendar settings in new tab
5. Navigates to find private iCal URL
6. Stores mailbox config, closes setup tab

### Running a Scan
1. User clicks "Run Scan" in toolbar popup
2. For each configured mailbox:
   a. Fetch iCal URL → Parse ICS → Store confirmed entries
   b. Open Gmail tab in background
   c. Navigate through emails (from last scan point or configurable lookback)
   d. Extract email content via InboxSDK/gmail.js
   e. Send to WebLLM for meeting detection
   f. Store tentative entries with provenance
3. Detect conflicts across all entries
4. Show completion notification

### Viewing Calendar
1. User clicks "View Calendar" in toolbar popup
2. Opens new tab with week view
3. Fetches all entries from IndexedDB
4. Renders with:
   - Color = mailbox
   - Solid = confirmed, Dashed = tentative
   - Labels showing mailbox name
   - Click to see source details (email thread link or calendar event)

## Technology Choices

- **Gmail Access**: InboxSDK (auto-updates with Gmail changes)
- **Calendar Access**: Private iCal URLs + ical.js parser
- **LLM**: WebLLM with Phi-3-mini (small, runs in-browser)
- **Storage**: IndexedDB via idb library
- **Build**: Vite + TypeScript
- **UI**: Vanilla JS/CSS (keep it simple for v1)

## Extensibility (Future)

- Outlook adapter module (same interface as Gmail adapter)
- Export to Google Calendar
- Real-time monitoring (not just weekly batch)
- Larger LLM models for better accuracy
- Mobile companion app

## Entry Approval & Rejection System

### Requirements
1. **Initial sync**: Automatically add all detected entries to the calendar
2. **Manual rejection**: User can remove entries from the calendar, and the system remembers to never re-add them in future syncs
3. **New sync approval**: For subsequent syncs, new entries require manual approval before appearing on the calendar

### Data Model Additions
```typescript
interface CalendarEntry {
  // ... existing fields ...
  approvalStatus: 'auto-approved' | 'pending' | 'approved' | 'rejected';
  rejectedAt?: Date;
  rejectionReason?: string;  // Optional user note
}

interface RejectionRule {
  id: string;
  type: 'email-thread' | 'email-subject-pattern' | 'sender';
  value: string;              // Thread ID, regex pattern, or email address
  createdAt: Date;
  mailboxId?: string;         // Optional: only applies to specific mailbox
}
```

### Workflows

#### Initial Sync Behavior
- First scan for a mailbox: all entries get `approvalStatus: 'auto-approved'`
- Entries appear immediately on calendar

#### Rejecting an Entry
1. User clicks entry in calendar view
2. Modal shows entry details + "Remove" button
3. On remove:
   - Set `approvalStatus: 'rejected'`
   - Create `RejectionRule` for this email thread
   - Entry is hidden from calendar view
   - Future scans skip this thread

#### Subsequent Sync Behavior
- New entries (not previously seen) get `approvalStatus: 'pending'`
- Pending entries shown in a separate "Needs Review" section
- User can:
  - **Approve**: Move to calendar (`approvalStatus: 'approved'`)
  - **Reject**: Hide and create rejection rule
  - **Approve All**: Batch approve all pending

### UI Changes Needed
- Calendar view: "Pending Review" badge/section
- Entry modal: "Remove from Calendar" button
- Settings: "Rejection Rules" management (view/delete rules)

## Initial Scope (MVP)

- Gmail only (2 accounts for testing)
- Manual scan trigger
- Configurable lookback period
- Week view display
- Basic progress indicators
