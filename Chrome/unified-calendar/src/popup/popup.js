/**
 * Popup script - handles UI interactions
 */

// DOM Elements
const mailboxList = document.getElementById('mailbox-list');
const progressSection = document.getElementById('progress-section');
const progressPhase = document.getElementById('progress-phase');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const progressItem = document.getElementById('progress-item');
const btnAdd = document.getElementById('btn-add');
const btnScan = document.getElementById('btn-scan');
const btnView = document.getElementById('btn-view');
const btnPause = document.getElementById('btn-pause');
const btnCancel = document.getElementById('btn-cancel');
const lookbackDays = document.getElementById('lookback-days');

// LLM elements
const btnInitLlm = document.getElementById('btn-init-llm');
const llmStatus = document.getElementById('llm-status');

// Add mailbox form elements
const addMailboxForm = document.getElementById('add-mailbox-form');
const mailboxEmailInput = document.getElementById('mailbox-email');
const mailboxNameInput = document.getElementById('mailbox-name');
const btnSaveMailbox = document.getElementById('btn-save-mailbox');
const btnCancelAdd = document.getElementById('btn-cancel-add');
const statusMessage = document.getElementById('status-message');

// Keyword settings elements
const btnEditKeywords = document.getElementById('btn-edit-keywords');
const keywordsEditor = document.getElementById('keywords-editor');
const keywordsInput = document.getElementById('keywords-input');
const btnSaveKeywords = document.getElementById('btn-save-keywords');
const btnResetKeywords = document.getElementById('btn-reset-keywords');

// Store current Gmail info
let currentGmailInfo = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadMailboxes();
  await checkScanStatus();
  await checkCurrentTab();
  await checkLlmStatus();
});

// Load and display mailboxes
async function loadMailboxes() {
  const mailboxes = await chrome.runtime.sendMessage({ type: 'GET_MAILBOXES' });

  if (!mailboxes || mailboxes.length === 0) {
    mailboxList.innerHTML = '<div class="no-mailboxes">No mailboxes configured</div>';
    return;
  }

  mailboxList.innerHTML = mailboxes.map(mb => `
    <div class="mailbox-item" data-id="${mb.id}">
      <div class="mailbox-color" style="background: ${mb.color}"></div>
      <div class="mailbox-info">
        <div class="mailbox-name">${escapeHtml(mb.name)}</div>
        <div class="mailbox-email">${escapeHtml(mb.email)}</div>
      </div>
      <button class="btn-edit-mailbox" data-id="${mb.id}" style="background:none;border:none;cursor:pointer;font-size:16px" title="Edit">✏️</button>
    </div>
  `).join('');

  // Add edit handlers
  mailboxList.querySelectorAll('.btn-edit-mailbox').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editMailbox(btn.dataset.id, mailboxes.find(m => m.id === btn.dataset.id));
    });
  });
}

// Check if we're on a Gmail page
async function checkCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.url?.includes('mail.google.com')) {
    btnAdd.textContent = '+ Add This Mailbox';
    btnAdd.disabled = false;
  } else {
    btnAdd.textContent = '+ Add Mailbox (Go to Gmail first)';
    btnAdd.disabled = true;
  }
}

// Check scan status
async function checkScanStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_SCAN_STATUS' });
  updateScanUI(status);
}

// Update UI based on scan status
function updateScanUI(status) {
  if (!status || status.status === 'idle') {
    progressSection.classList.remove('active');
    btnScan.disabled = false;
    btnScan.innerHTML = '<span>🔄</span> Run Scan';
    return;
  }

  if (status.status === 'complete') {
    progressSection.classList.remove('active');
    btnScan.disabled = false;
    btnScan.innerHTML = '<span>🔄</span> Run Scan';
    // Show how many entries were found
    chrome.runtime.sendMessage({ type: 'GET_ALL_ENTRIES' }).then(entries => {
      if (entries?.length > 0) {
        const confirmed = entries.filter(e => e.status === 'confirmed').length;
        const tentative = entries.filter(e => e.status === 'tentative').length;
        showStatus(`Scan complete: ${confirmed} calendar events, ${tentative} email matches`, 'success');
      }
    });
    return;
  }

  progressSection.classList.add('active');
  btnScan.disabled = true;

  const phaseLabels = {
    starting: 'Starting scan...',
    calendar: 'Fetching calendars...',
    emails: 'Scanning emails...',
    analyzing: 'Analyzing meetings...'
  };

  progressPhase.textContent = phaseLabels[status.phase] || status.phase;

  const percent = status.progress?.total > 0
    ? Math.round((status.progress.current / status.progress.total) * 100)
    : 0;

  progressPercent.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  progressItem.textContent = status.progress?.currentItem || 'Processing...';

  if (status.status === 'paused') {
    btnPause.textContent = 'Resume';
  } else {
    btnPause.textContent = 'Pause';
  }
}

// Show status message
function showStatus(message, type = 'success') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message active ${type}`;

  // Auto-hide after 5 seconds
  setTimeout(() => {
    statusMessage.classList.remove('active');
  }, 5000);
}

// Show add mailbox form
function showAddForm() {
  addMailboxForm.classList.add('active');
  btnAdd.style.display = 'none';
  mailboxEmailInput.focus();
}

// Hide add mailbox form
function hideAddForm() {
  addMailboxForm.classList.remove('active');
  btnAdd.style.display = 'flex';
  mailboxEmailInput.value = '';
  mailboxNameInput.value = '';
  currentGmailInfo = null;
  editingMailboxId = null;
  btnSaveMailbox.textContent = 'Save Mailbox';
}

// Edit existing mailbox (reuses the add form)
let editingMailboxId = null;

function editMailbox(id, mb) {
  editingMailboxId = id;
  mailboxEmailInput.value = mb.email;
  mailboxNameInput.value = mb.name;
  addMailboxForm.classList.add('active');
  btnAdd.style.display = 'none';
  btnSaveMailbox.textContent = 'Update Mailbox';
  mailboxNameInput.focus();
}

// Button handlers
btnAdd.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('mail.google.com')) {
    showStatus('Please navigate to Gmail first', 'error');
    return;
  }

  // Get account info from content script
  try {
    currentGmailInfo = await chrome.tabs.sendMessage(tab.id, { type: 'GET_GMAIL_INFO' });
  } catch (e) {
    currentGmailInfo = { isGmail: true, accountIndex: 0 };
  }

  if (!currentGmailInfo?.isGmail) {
    showStatus('Could not detect Gmail page', 'error');
    return;
  }

  // Show the inline form
  showAddForm();
});

// Save mailbox button
btnSaveMailbox.addEventListener('click', async () => {
  const email = mailboxEmailInput.value.trim();
  const name = mailboxNameInput.value.trim() || email.split('@')[0];

  if (!email) {
    showStatus('Please enter an email address', 'error');
    return;
  }

  if (editingMailboxId) {
    // Update existing mailbox
    const mailbox = await chrome.runtime.sendMessage({
      type: 'UPDATE_MAILBOX',
      mailbox: { id: editingMailboxId, name, email }
    });

    if (mailbox?.id) {
      await loadMailboxes();
      showStatus('Mailbox updated!', 'success');
      editingMailboxId = null;
      hideAddForm();
    } else {
      showStatus('Failed to update mailbox', 'error');
    }
    return;
  }

  // Add new mailbox
  const mailbox = await chrome.runtime.sendMessage({
    type: 'ADD_MAILBOX',
    mailbox: {
      name,
      email,
      accountIndex: currentGmailInfo?.accountIndex || 0,
      color: getRandomColor()
    }
  });

  if (mailbox?.id) {
    await loadMailboxes();
    showStatus('Mailbox added successfully!', 'success');

    hideAddForm();
  } else {
    showStatus('Failed to add mailbox', 'error');
  }
});

// Cancel add button
btnCancelAdd.addEventListener('click', () => {
  hideAddForm();
});

// Clear data and rescan
document.getElementById('btn-clear-rescan').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_ENTRIES' });
  showStatus('Data cleared. Starting scan...', 'success');

  const days = parseInt(lookbackDays.value) || 14;
  const result = await chrome.runtime.sendMessage({
    type: 'START_SCAN',
    options: { lookbackDays: days }
  });

  if (result?.error) {
    showStatus(result.error, 'error');
    return;
  }

  await checkScanStatus();
});

btnScan.addEventListener('click', async () => {
  const days = parseInt(lookbackDays.value) || 14;

  const result = await chrome.runtime.sendMessage({
    type: 'START_SCAN',
    options: { lookbackDays: days }
  });

  if (result?.error) {
    showStatus(result.error, 'error');
    return;
  }

  // Open calendar view to show progress
  await chrome.runtime.sendMessage({ type: 'OPEN_CALENDAR_VIEW' });

  await checkScanStatus();
});

btnView.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_CALENDAR_VIEW' });
  window.close();
});

btnPause.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'PAUSE_SCAN' });
  await checkScanStatus();
});

btnCancel.addEventListener('click', async () => {
  // Just cancel without confirmation - the button is clear enough
  await chrome.runtime.sendMessage({ type: 'CANCEL_SCAN' });
  await checkScanStatus();
  showStatus('Scan cancelled', 'success');
});

// LLM initialization handler
btnInitLlm.addEventListener('click', async () => {
  btnInitLlm.disabled = true;
  btnInitLlm.innerHTML = '<span class="spinner"></span>';
  llmStatus.textContent = 'Initializing AI model...';

  const result = await chrome.runtime.sendMessage({ type: 'INIT_LLM' });

  if (result?.error) {
    llmStatus.textContent = `Error: ${result.error}`;
    llmStatus.style.color = '#ea4335';
    btnInitLlm.disabled = false;
    btnInitLlm.textContent = 'Retry';
  } else if (result?.ready) {
    llmStatus.textContent = 'AI model ready! Scans will now use smart meeting detection.';
    llmStatus.style.color = '#34a853';
    btnInitLlm.textContent = 'Loaded ✓';
  }
});

// Check LLM status on load
async function checkLlmStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_LLM_STATUS' });
  if (status?.ready) {
    llmStatus.textContent = 'AI model ready!';
    llmStatus.style.color = '#34a853';
    btnInitLlm.textContent = 'Loaded ✓';
    btnInitLlm.disabled = true;
  } else if (status?.loading) {
    llmStatus.textContent = `Loading AI model... ${status.progress || ''}`;
    btnInitLlm.disabled = true;
    btnInitLlm.innerHTML = '<span class="spinner"></span>';
  }
}

// Listen for status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCAN_STATUS_UPDATE') {
    updateScanUI(message.status);
  }

  if (message.type === 'LLM_INIT_PROGRESS') {
    llmStatus.textContent = message.text || 'Loading AI model...';
    if (message.progress !== undefined) {
      llmStatus.textContent += ` (${Math.round(message.progress * 100)}%)`;
    }
  }
});

// Keyword settings
const DEFAULT_KEYWORDS = ['meet', 'call', 'schedule', 'available', 'calendar', 'appointment', 'invite', 'zoom', 'teams', 'webex'];

btnEditKeywords.addEventListener('click', async () => {
  const visible = keywordsEditor.style.display !== 'none';
  if (visible) {
    keywordsEditor.style.display = 'none';
    return;
  }
  keywordsEditor.style.display = 'block';
  const result = await chrome.storage.local.get('meetingKeywords');
  const keywords = result.meetingKeywords || DEFAULT_KEYWORDS;
  keywordsInput.value = keywords.join('\n');
});

btnSaveKeywords.addEventListener('click', async () => {
  const keywords = keywordsInput.value
    .split('\n')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0);
  await chrome.storage.local.set({ meetingKeywords: keywords });
  showStatus(`Saved ${keywords.length} keywords`, 'success');
  keywordsEditor.style.display = 'none';
});

btnResetKeywords.addEventListener('click', async () => {
  await chrome.storage.local.set({ meetingKeywords: DEFAULT_KEYWORDS });
  keywordsInput.value = DEFAULT_KEYWORDS.join('\n');
  showStatus('Keywords reset to defaults', 'success');
});

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getRandomColor() {
  const colors = ['#4285f4', '#34a853', '#ea4335', '#fbbc04', '#9c27b0', '#00bcd4'];
  return colors[Math.floor(Math.random() * colors.length)];
}
