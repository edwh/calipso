/**
 * Calendar View - Interactive week view with live updates
 */

// State
let entries = [];
let mailboxes = [];
let weekStart = getWeekStart(new Date());

// DOM Elements
const weekHeader = document.getElementById('week-header');
const weekGrid = document.getElementById('week-grid');
const timeColumn = document.getElementById('time-column');
const legend = document.getElementById('legend');
const progressBanner = document.getElementById('progress-banner');
const progressText = document.getElementById('progress-text');
const progressDetail = document.getElementById('progress-detail');
const progressBar = document.getElementById('progress-bar');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalContent = document.getElementById('modal-content');
const statConfirmed = document.getElementById('stat-confirmed');
const statTentative = document.getElementById('stat-tentative');
const statConflicts = document.getElementById('stat-conflicts');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadMailboxes();
  buildCalendarStructure();
  await loadEntries();
  checkScanStatus();
});

// Load mailboxes for color mapping
async function loadMailboxes() {
  mailboxes = await chrome.runtime.sendMessage({ type: 'GET_MAILBOXES' }) || [];
  updateLegend();
}

// Load entries
async function loadEntries() {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  entries = await chrome.runtime.sendMessage({
    type: 'GET_ENTRIES',
    start: weekStart.toISOString(),
    end: weekEnd.toISOString()
  }) || [];

  renderEntries();
  updateStats();
}

// Build calendar grid structure
function buildCalendarStructure() {
  // Build header
  let headerHtml = '<div class="week-header-cell"></div>';
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + i);
    const isToday = isSameDay(date, new Date());

    headerHtml += `
      <div class="week-header-cell ${isToday ? 'today' : ''}">
        <div class="day-name">${getDayName(date)}</div>
        <div class="day-number">${date.getDate()}</div>
      </div>
    `;
  }
  weekHeader.innerHTML = headerHtml;

  // Build time column
  let timeHtml = '';
  for (let hour = 0; hour < 24; hour++) {
    timeHtml += `<div class="time-slot">${formatHour(hour)}</div>`;
  }
  timeColumn.innerHTML = timeHtml;

  // Build day columns
  let gridHtml = '<div class="time-column" id="time-column">' + timeHtml + '</div>';
  for (let i = 0; i < 7; i++) {
    let hourLines = '';
    for (let hour = 0; hour < 24; hour++) {
      hourLines += `<div class="hour-line" style="top: ${hour * 48}px"></div>`;
    }
    gridHtml += `<div class="day-column" data-day="${i}">${hourLines}</div>`;
  }
  weekGrid.innerHTML = gridHtml;
}

// Render all entries
function renderEntries() {
  // Clear existing entries
  document.querySelectorAll('.calendar-entry').forEach(el => el.remove());

  // Group entries by day
  const entriesByDay = new Map();
  for (let i = 0; i < 7; i++) {
    entriesByDay.set(i, []);
  }

  for (const entry of entries) {
    const startDate = new Date(entry.startTime);
    const dayIndex = getDayIndex(startDate);

    if (dayIndex >= 0 && dayIndex < 7) {
      entriesByDay.get(dayIndex).push(entry);
    }
  }

  // Render each day's entries
  entriesByDay.forEach((dayEntries, dayIndex) => {
    const column = weekGrid.querySelector(`[data-day="${dayIndex}"]`);
    if (!column) return;

    for (const entry of dayEntries) {
      const element = createEntryElement(entry);
      column.appendChild(element);
    }
  });
}

// Create entry DOM element
function createEntryElement(entry, isNew = false) {
  const startDate = new Date(entry.startTime);
  const endDate = new Date(entry.endTime);

  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
  const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();
  const duration = Math.max(endMinutes - startMinutes, 30);

  const top = (startMinutes / 60) * 48;
  const height = (duration / 60) * 48;

  const mailbox = mailboxes.find(m => m.id === entry.mailboxId);
  const color = mailbox?.color || '#4285f4';

  const el = document.createElement('div');
  el.className = `calendar-entry ${entry.status}`;
  if (isNew) el.classList.add('new');
  if (entry.conflicts?.length > 0) el.classList.add('conflict');

  el.style.top = `${top}px`;
  el.style.height = `${Math.max(height, 24)}px`;
  el.style.backgroundColor = hexToRgba(color, entry.status === 'tentative' ? 0.7 : 0.9);
  el.style.borderColor = color;
  el.style.color = getContrastColor(color);

  el.innerHTML = `
    <div class="entry-title">${escapeHtml(entry.title)}</div>
    <div class="entry-time">${formatTime(startDate)} - ${formatTime(endDate)}</div>
    ${entry.source?.type === 'email' ? '<div class="entry-source">From email</div>' : ''}
  `;

  el.addEventListener('click', () => showEntryDetails(entry));

  return el;
}

// Add new entry with animation
function addNewEntry(entry) {
  // Check if entry already exists
  const existing = entries.find(e => e.id === entry.id);
  if (existing) return;

  entries.push(entry);

  const startDate = new Date(entry.startTime);
  const dayIndex = getDayIndex(startDate);

  if (dayIndex >= 0 && dayIndex < 7) {
    const column = weekGrid.querySelector(`[data-day="${dayIndex}"]`);
    if (column) {
      const element = createEntryElement(entry, true);
      column.appendChild(element);

      // Remove 'new' class after animation
      setTimeout(() => {
        element.classList.remove('new');
      }, 3000);
    }
  }

  updateStats();
}

// Update statistics
function updateStats() {
  const confirmed = entries.filter(e => e.status === 'confirmed').length;
  const tentative = entries.filter(e => e.status === 'tentative').length;
  const conflicts = entries.filter(e => e.conflicts?.length > 0).length;

  statConfirmed.textContent = confirmed;
  statTentative.textContent = tentative;
  statConflicts.textContent = conflicts;
}

// Update legend with mailbox colors
function updateLegend() {
  let html = '';

  for (const mailbox of mailboxes) {
    html += `
      <div class="legend-item">
        <div class="legend-color" style="background: ${mailbox.color}"></div>
        <span>${escapeHtml(mailbox.name)}</span>
      </div>
    `;
  }

  html += `
    <div class="legend-item">
      <div class="legend-color tentative"></div>
      <span>Tentative</span>
    </div>
  `;

  legend.innerHTML = html;
}

// Show entry details modal
function showEntryDetails(entry) {
  const mailbox = mailboxes.find(m => m.id === entry.mailboxId);

  modalTitle.textContent = entry.title;

  let content = `
    <div class="modal-row">
      <div class="modal-label">Time</div>
      <div class="modal-value">
        ${formatDateTime(new Date(entry.startTime))} - ${formatTime(new Date(entry.endTime))}
      </div>
    </div>
    <div class="modal-row">
      <div class="modal-label">Status</div>
      <div class="modal-value">${entry.status === 'confirmed' ? 'Confirmed' : 'Tentative'}</div>
    </div>
    <div class="modal-row">
      <div class="modal-label">Mailbox</div>
      <div class="modal-value">${escapeHtml(mailbox?.name || 'Unknown')}</div>
    </div>
    <div class="modal-row">
      <div class="modal-label">Source</div>
      <div class="modal-value">${entry.source?.type === 'calendar' ? 'Calendar' : 'Email'}</div>
    </div>
  `;

  if (entry.source?.type === 'email') {
    content += `
      <div class="modal-row">
        <div class="modal-label">Email Subject</div>
        <div class="modal-value">${escapeHtml(entry.source.emailSubject || 'Unknown')}</div>
      </div>
      <div class="modal-row">
        <div class="modal-label">Email Date</div>
        <div class="modal-value">${entry.source.emailDate || 'Unknown'}</div>
      </div>
    `;
  }

  if (entry.conflicts?.length > 0) {
    const conflictingEntries = entry.conflicts
      .map(cid => entries.find(e => e.id === cid))
      .filter(Boolean);

    const conflictList = conflictingEntries
      .map(e => `<div style="margin: 2px 0">- ${escapeHtml(e.title)} (${formatTime(new Date(e.startTime))})</div>`)
      .join('');

    content += `
      <div class="modal-row">
        <div class="modal-label">Conflicts with</div>
        <div class="modal-value" style="color: #ea4335">
          ${conflictList || `${entry.conflicts.length} event(s)`}
        </div>
      </div>
    `;
  }

  modalContent.innerHTML = content;
  modalOverlay.classList.add('active');
}

// Check scan status
async function checkScanStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_SCAN_STATUS' });
  updateProgressUI(status);
}

// Update progress UI
function updateProgressUI(status) {
  if (!status || status.status === 'idle' || status.status === 'complete') {
    progressBanner.classList.remove('active');
    return;
  }

  progressBanner.classList.add('active');

  const phaseLabels = {
    starting: 'Starting scan...',
    calendar: 'Fetching calendars',
    emails: 'Scanning emails',
    analyzing: 'Analyzing meetings'
  };

  progressText.textContent = phaseLabels[status.phase] || status.phase;
  progressDetail.textContent = status.progress?.currentItem || 'Processing...';

  const percent = status.progress?.total > 0
    ? Math.round((status.progress.current / status.progress.total) * 100)
    : 0;

  progressBar.style.width = `${percent}%`;
}

// Message listener for live updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCAN_STATUS_UPDATE') {
    updateProgressUI(message.status);
  }

  if (message.type === 'NEW_ENTRY') {
    addNewEntry(message.entry);
  }
});

// Modal close handlers
document.getElementById('modal-close').addEventListener('click', () => {
  modalOverlay.classList.remove('active');
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.classList.remove('active');
  }
});

// Refresh button
document.getElementById('btn-refresh').addEventListener('click', async () => {
  await loadEntries();
});

// ============ Utility Functions ============

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getDayIndex(date) {
  const diff = date.getTime() - weekStart.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function getDayName(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getContrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 128 ? '#202124' : '#ffffff';
}
