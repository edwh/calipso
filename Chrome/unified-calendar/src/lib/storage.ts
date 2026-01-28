/**
 * Storage layer using IndexedDB for persistent data
 */

const DB_NAME = 'unified-calendar';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Initialize and get database connection
 */
async function getDb() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Mailbox configurations
      if (!db.objectStoreNames.contains('mailboxes')) {
        const mailboxStore = db.createObjectStore('mailboxes', { keyPath: 'id' });
        mailboxStore.createIndex('email', 'email', { unique: false });
      }

      // Calendar entries (confirmed and tentative)
      if (!db.objectStoreNames.contains('entries')) {
        const entriesStore = db.createObjectStore('entries', { keyPath: 'id' });
        entriesStore.createIndex('mailboxId', 'mailboxId', { unique: false });
        entriesStore.createIndex('startTime', 'startTime', { unique: false });
        entriesStore.createIndex('status', 'status', { unique: false });
      }

      // Scan state tracking
      if (!db.objectStoreNames.contains('scanState')) {
        db.createObjectStore('scanState', { keyPath: 'mailboxId' });
      }

      // Scan logs for debugging
      if (!db.objectStoreNames.contains('scanLogs')) {
        const logsStore = db.createObjectStore('scanLogs', { keyPath: 'id', autoIncrement: true });
        logsStore.createIndex('timestamp', 'timestamp', { unique: false });
        logsStore.createIndex('mailboxId', 'mailboxId', { unique: false });
      }
    };
  });
}

// ============ Mailbox Operations ============

/**
 * Save a mailbox configuration
 * @param {Object} mailbox - Mailbox config object
 */
export async function saveMailbox(mailbox) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mailboxes', 'readwrite');
    const store = tx.objectStore('mailboxes');
    const request = store.put(mailbox);
    request.onsuccess = () => resolve(mailbox);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all configured mailboxes
 * @returns {Promise<Array>} List of mailbox configs
 */
export async function getAllMailboxes() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mailboxes', 'readonly');
    const store = tx.objectStore('mailboxes');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get a mailbox by ID
 * @param {string} id - Mailbox ID
 * @returns {Promise<Object|null>} Mailbox config or null
 */
export async function getMailbox(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mailboxes', 'readonly');
    const store = tx.objectStore('mailboxes');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a mailbox and all its entries
 * @param {string} id - Mailbox ID
 */
export async function deleteMailbox(id) {
  const db = await getDb();

  // Delete mailbox config
  await new Promise((resolve, reject) => {
    const tx = db.transaction('mailboxes', 'readwrite');
    const store = tx.objectStore('mailboxes');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Delete all entries for this mailbox
  await deleteEntriesByMailbox(id);
}

// ============ Calendar Entry Operations ============

/**
 * Save a calendar entry
 * @param {Object} entry - Calendar entry object
 */
export async function saveEntry(entry) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    const request = store.put(entry);
    request.onsuccess = () => resolve(entry);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save multiple entries in a batch
 * @param {Array} entries - Array of calendar entries
 */
export async function saveEntries(entries) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');

    let completed = 0;
    for (const entry of entries) {
      const request = store.put(entry);
      request.onsuccess = () => {
        completed++;
        if (completed === entries.length) resolve();
      };
      request.onerror = () => reject(request.error);
    }

    if (entries.length === 0) resolve();
  });
}

/**
 * Get all entries for a time range
 * @param {Date} start - Start of range
 * @param {Date} end - End of range
 * @returns {Promise<Array>} Entries in range
 */
export async function getEntriesInRange(start, end) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const store = tx.objectStore('entries');
    const index = store.index('startTime');
    const range = IDBKeyRange.bound(start.toISOString(), end.toISOString());
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all entries (for conflict detection)
 * @returns {Promise<Array>} All entries
 */
export async function getAllEntries() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const store = tx.objectStore('entries');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete all entries for a mailbox
 * @param {string} mailboxId - Mailbox ID
 */
export async function deleteEntriesByMailbox(mailboxId) {
  const db = await getDb();
  const entries = await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const store = tx.objectStore('entries');
    const index = store.index('mailboxId');
    const request = index.getAll(mailboxId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    let deleted = 0;
    for (const entry of entries) {
      const request = store.delete(entry.id);
      request.onsuccess = () => {
        deleted++;
        if (deleted === entries.length) resolve();
      };
      request.onerror = () => reject(request.error);
    }
    if (entries.length === 0) resolve();
  });
}

/**
 * Clear all entries with a specific source type for a mailbox
 * Used to clear calendar entries before re-fetching
 * @param {string} mailboxId - Mailbox ID
 * @param {string} sourceType - 'calendar' or 'email'
 */
export async function clearEntriesBySource(mailboxId, sourceType) {
  const entries = await getAllEntries();
  const toDelete = entries.filter(e =>
    e.mailboxId === mailboxId && e.source?.type === sourceType
  );

  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    let deleted = 0;
    for (const entry of toDelete) {
      const request = store.delete(entry.id);
      request.onsuccess = () => {
        deleted++;
        if (deleted === toDelete.length) resolve();
      };
      request.onerror = () => reject(request.error);
    }
    if (toDelete.length === 0) resolve();
  });
}

// ============ Scan State Operations ============

/**
 * Get scan state for a mailbox
 * @param {string} mailboxId - Mailbox ID
 * @returns {Promise<Object|null>} Scan state or null
 */
export async function getScanState(mailboxId) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scanState', 'readonly');
    const store = tx.objectStore('scanState');
    const request = store.get(mailboxId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update scan state for a mailbox
 * @param {Object} state - Scan state object
 */
export async function updateScanState(state) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scanState', 'readwrite');
    const store = tx.objectStore('scanState');
    const request = store.put(state);
    request.onsuccess = () => resolve(state);
    request.onerror = () => reject(request.error);
  });
}

// ============ Scan Log Operations ============

/**
 * Add a log entry
 * @param {Object} log - Log entry
 */
export async function addScanLog(log) {
  const db = await getDb();
  const entry = {
    ...log,
    timestamp: new Date().toISOString()
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scanLogs', 'readwrite');
    const store = tx.objectStore('scanLogs');
    const request = store.add(entry);
    request.onsuccess = () => resolve(entry);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get recent scan logs
 * @param {number} limit - Max logs to return
 * @returns {Promise<Array>} Recent log entries
 */
export async function getRecentLogs(limit = 100) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scanLogs', 'readonly');
    const store = tx.objectStore('scanLogs');
    const index = store.index('timestamp');
    const request = index.openCursor(null, 'prev');
    const results = [];

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear old logs (keep last N entries)
 * @param {number} keep - Number of entries to keep
 */
export async function clearOldLogs(keep = 500) {
  const logs = await getRecentLogs(keep + 1000);
  if (logs.length <= keep) return;

  const toDelete = logs.slice(keep);
  const db = await getDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('scanLogs', 'readwrite');
    const store = tx.objectStore('scanLogs');
    let deleted = 0;
    for (const log of toDelete) {
      const request = store.delete(log.id);
      request.onsuccess = () => {
        deleted++;
        if (deleted === toDelete.length) resolve();
      };
      request.onerror = () => reject(request.error);
    }
  });
}

/**
 * Clear all entries from the database
 */
export async function clearAllEntries() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ============ Utility Functions ============

/**
 * Generate a unique ID
 * @returns {string} UUID-like ID
 */
export function generateId() {
  return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

/**
 * Detect conflicts between entries
 * @param {Array} entries - All calendar entries
 * @returns {Map} Map of entry ID to array of conflicting entry IDs
 */
export function detectConflicts(entries) {
  const conflicts = new Map();

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];

      const aStart = new Date(a.startTime);
      const aEnd = new Date(a.endTime);
      const bStart = new Date(b.startTime);
      const bEnd = new Date(b.endTime);

      // Check for overlap
      if (aStart < bEnd && aEnd > bStart) {
        if (!conflicts.has(a.id)) conflicts.set(a.id, []);
        if (!conflicts.has(b.id)) conflicts.set(b.id, []);
        conflicts.get(a.id).push(b.id);
        conflicts.get(b.id).push(a.id);
      }
    }
  }

  return conflicts;
}
