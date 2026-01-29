# Unified Calendar Chrome Extension

A privacy-focused Chrome extension that creates a unified calendar view across multiple Gmail accounts, with intelligent meeting detection powered by local LLM inference.

## Features

- **Multi-account support**: Aggregate calendar events from multiple Gmail/Google Calendar accounts
- **Email meeting detection**: Automatically extracts meeting information from emails
- **Privacy-safe AI**: Uses WebLLM for on-device inference - your data never leaves your browser
- **Conflict detection**: Identifies scheduling conflicts across accounts
- **Configurable keywords**: Customise meeting detection keywords when AI isn't available
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

Events come from two sources:

1. **Calendar Scraping** (confirmed): Parses events directly from Google Calendar's web UI via the authenticated session, giving full event details without any public sharing
2. **Email Analysis** (tentative):
   - Configurable keyword matching as fallback
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
│  1. Scrape Google Calendar web UI for events                     │
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
4. Enter email and display name, then save

### Configuring Meeting Keywords
1. Click the extension icon
2. In Settings, click "Edit" next to "Meeting Keywords"
3. Add or remove keywords (one per line)
4. Click "Save"

Emails with subjects or bodies containing any of these keywords will be flagged as potential meetings. Default keywords: meet, call, schedule, available, calendar, appointment, invite, zoom, teams, webex.

### Loading the AI Model
1. Click "Load Model" in the extension popup
2. Wait for download (~2GB, cached after first load)
3. Subsequent scans will use AI-powered meeting detection

## Privacy

- **No external API calls**: All AI inference runs locally via WebGPU
- **No telemetry**: No usage data is collected
- **Data stays local**: Calendar and email data only stored in browser IndexedDB

## Limitations

- WebLLM requires a GPU with WebGPU support (most modern GPUs)
- Initial model download is ~2GB
- Service worker may need to reinitialize LLM after browser restart
- Email scanning requires Gmail tab to be open (even if in background)

## License

MIT
