# Unified Calendar Chrome Extension

A privacy-focused Chrome extension that creates a unified calendar view across multiple Gmail accounts, with intelligent meeting detection powered by local LLM inference.

## Features

- **Multi-account support**: Aggregate calendar events from multiple Gmail/Google Calendar accounts
- **Email meeting detection**: Automatically extracts meeting information from emails
- **Privacy-safe AI**: Uses WebLLM for on-device inference - your data never leaves your browser
- **iCal integration**: Import events via Google Calendar's private iCal URLs
- **Conflict detection**: Identifies scheduling conflicts across accounts
- **Offline-capable**: All processing happens locally

## Architecture

### Why These Choices?

#### 1. Manifest V3 Service Worker Architecture

Chrome extensions are migrating to Manifest V3, which replaces background pages with service workers. This extension embraces this architecture:

```
src/
├── background/
│   └── service-worker.ts    # Central coordinator
├── content/
│   ├── gmail-adapter.js     # Gmail page integration
│   └── calendar-setup.js    # Calendar page integration
├── popup/
│   └── popup.html/js        # Extension popup UI
├── calendar-view/
│   └── index.html/calendar.js  # Full calendar view
└── lib/
    ├── db.ts                # IndexedDB via idb
    ├── ical-parser.ts       # iCal feed parsing
    └── meeting-extractor.ts # Text analysis utilities
```

**Why service worker?** Service workers provide better performance and security, but they're ephemeral - they can be terminated at any time. This influenced our design to:
- Use IndexedDB (via `idb` library) for persistent storage instead of in-memory state
- Implement stateless message handlers
- Cache LLM models in IndexedDB for persistence across restarts

#### 2. WebLLM for On-Device AI

**The Problem**: We want intelligent meeting detection from email text, but sending email content to external APIs creates privacy concerns.

**The Solution**: [WebLLM](https://github.com/mlc-ai/web-llm) runs LLMs directly in the browser using WebGPU acceleration.

**Why This Model**: We use `Phi-3.5-mini-instruct-q4f16_1-MLC` because:
- Small enough to download quickly (~2GB)
- Fast inference on consumer GPUs
- Good at instruction-following and structured output
- Quantized (q4f16) for reduced memory usage

**CSP Challenges Solved**: Chrome extensions have strict Content Security Policy. We solved this by:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; default-src 'self' data:; connect-src 'self' data: https://huggingface.co https://cdn-lfs.huggingface.co ..."
}
```
- `wasm-unsafe-eval` allows WebAssembly compilation (required for WebLLM)
- `connect-src` whitelist allows model downloads from Hugging Face CDN
- Parcel bundler packages WebLLM into the extension rather than loading from CDN

#### 3. Parcel Bundler with @parcel/config-webextension

**Why Parcel?** Chrome extension development has unique requirements:
- Must transform TypeScript
- Must bundle node_modules into the extension
- Must handle manifest.json specially (rewriting paths)
- Must support web_accessible_resources

Parcel's `@parcel/config-webextension` handles all of this automatically. The build command:
```bash
parcel build src/manifest.json --config @parcel/config-webextension
```

This transforms `src/manifest.json` → `dist/manifest.json` with hashed filenames and correct paths.

#### 4. IndexedDB via `idb` Library

**Why IndexedDB?**
- Only persistent storage available in service workers (localStorage not available)
- Can store structured data (calendar entries, mailbox configs)
- Good performance for read-heavy workloads

**Why `idb` wrapper?**
- IndexedDB's native API is callback-based and verbose
- `idb` provides a clean Promise-based interface

Database schema:
```typescript
interface CalipsoDB {
  mailboxes: {
    key: string;
    value: Mailbox;
  };
  entries: {
    key: string;
    value: CalendarEntry;
    indexes: {
      byDate: [string, string];      // [mailboxId, start]
      byMailbox: string;              // mailboxId
    };
  };
}
```

#### 5. Content Script Architecture

Gmail and Google Calendar pages are accessed via content scripts:

**Gmail Adapter** (`gmail-adapter.js`):
- Runs on `https://mail.google.com/*`
- Extracts email metadata from the DOM
- Uses Gmail's `#all` view for complete email access (not just inbox)
- Communicates with service worker via `chrome.runtime.sendMessage`

**Calendar Setup** (`calendar-setup.js`):
- Runs on `https://calendar.google.com/*`
- Could be extended to scrape calendar DOM or assist with iCal URL retrieval

#### 6. Hybrid Event Detection Strategy

Events come from three sources:

1. **iCal Feeds** (highest confidence): Direct calendar data via private URLs
2. **Calendar DOM Scraping**: Parses visible events from Google Calendar
3. **Email Analysis** (lowest confidence → "tentative"):
   - Keyword matching as fallback
   - LLM-powered extraction when model is loaded

This layered approach ensures functionality even without AI, while AI provides better accuracy when available.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interaction                          │
│  popup.html → "Run Scan" → chrome.runtime.sendMessage            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Service Worker                              │
│  1. Fetch iCal feeds (if configured)                            │
│  2. Open background Gmail tab → navigate to #all                 │
│  3. Inject content script → extract emails                       │
│  4. Analyze emails with LLM (or keyword fallback)               │
│  5. Store results in IndexedDB                                   │
│  6. Broadcast status updates                                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Calendar View                                 │
│  Reads from IndexedDB → Renders unified calendar                 │
│  Shows conflicts, tentative meetings, confirmed events           │
└─────────────────────────────────────────────────────────────────┘
```

## Development

### Prerequisites
- Node.js 18+
- npm or yarn

### Build
```bash
cd Chrome/unified-calendar
npm install
npm run build
```

### Watch Mode (Development)
```bash
npm run watch
```

### Load in Chrome
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder

## Configuration

### Adding a Mailbox
1. Navigate to Gmail in Chrome
2. Click the extension icon
3. Click "Add Current Mailbox"
4. Optionally add your private iCal URL for more accurate calendar data

### Getting Your iCal URL

Google Calendar offers two types of iCal URL:

**Personal Google accounts** typically show a "Secret address in iCal format" in Calendar Settings → (your calendar) → Integrate calendar. This URL contains an unguessable token and provides full event details without making your calendar public.

**Google Workspace accounts** may not show the secret address (depends on admin policy). In this case you have two options:

1. **Public iCal URL** (Settings → Integrate calendar → "Public address in iCal format"):
   - Requires enabling "Make available to public" in Access permissions
   - By default only exposes free/busy information (events show as "Busy")
   - To get full details, change the public access dropdown to "See all event details"
   - See **Security: Public Calendar Access** below

2. **Web scraping fallback**: If no iCal URL is configured, the extension falls back to scraping the Google Calendar web UI, which shows full event details for the logged-in user.

To add an iCal URL:
1. Go to Google Calendar Settings
2. Select your calendar → "Integrate calendar"
3. Copy the secret or public iCal address
4. Paste into the "Private iCal URL" field in the extension popup

### Loading the AI Model
1. Click "Load Model" in the extension popup
2. Wait for download (~2GB, cached after first load)
3. Subsequent scans will use AI-powered meeting detection

## Privacy

- **No external API calls**: All AI inference runs locally via WebGPU
- **No telemetry**: No usage data is collected
- **Data stays local**: Calendar and email data only stored in browser IndexedDB
- **iCal URLs are secrets**: Treat your private iCal URL like a password

### Security: Public Calendar Access

If you use the **public iCal URL** (because your Workspace admin doesn't expose the secret address), be aware of the following:

- **Making a calendar public** means anyone on the internet can view it via the public URL. The URL contains your email address (e.g. `https://calendar.google.com/calendar/ical/you%40example.com/public/basic.ics`) so it is guessable - there is **no security through obscurity**.
- **Default public access is free/busy only**: Google defaults to "See only free/busy (hide details)", which means the public iCal feed will only show time slots as "Busy" without event titles, descriptions, or attendees.
- **Changing to "See all event details"** exposes full event information (titles, locations, descriptions, attendees) to anyone who requests the public URL. This may leak sensitive meeting information.
- **The secret iCal URL** (available on personal Google accounts) contains a long random token that is not guessable. This is the safer option when available.
- **Recommendation**: If privacy is a concern, leave the iCal URL blank and rely on the web scraping fallback, which accesses calendar data through your authenticated browser session without making anything public.

## Limitations

- WebLLM requires a GPU with WebGPU support (most modern GPUs)
- Initial model download is ~2GB
- Service worker may need to reinitialize LLM after browser restart
- Email scanning requires Gmail tab to be open (even if in background)

## License

MIT
