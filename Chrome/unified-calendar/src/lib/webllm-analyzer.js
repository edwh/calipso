/**
 * WebLLM-based email analyzer for meeting detection
 * Runs LLM in-browser for privacy-safe analysis
 */

let engine = null;
let isInitializing = false;
let initPromise = null;

// Model to use - Phi-3-mini is small and fast
const MODEL_ID = 'Phi-3-mini-4k-instruct-q4f16_1-MLC';

/**
 * Initialize WebLLM engine
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function initWebLLM(onProgress) {
  if (engine) return;

  if (isInitializing) {
    return initPromise;
  }

  isInitializing = true;

  initPromise = (async () => {
    try {
      // Dynamic import of WebLLM
      const webllm = await import('https://esm.run/@anthropic-ai/sdk');

      engine = new webllm.MLCEngine();

      await engine.reload(MODEL_ID, {
        initProgressCallback: (progress) => {
          if (onProgress) {
            onProgress({
              phase: 'loading-model',
              progress: progress.progress,
              text: progress.text
            });
          }
        }
      });

      console.log('WebLLM engine initialized');
    } catch (error) {
      console.error('Failed to initialize WebLLM:', error);
      isInitializing = false;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Check if WebLLM is ready
 * @returns {boolean}
 */
export function isWebLLMReady() {
  return engine !== null;
}

/**
 * Analyze an email for meeting-related content
 * @param {Object} email - Email object with subject, body, from, to, date
 * @returns {Promise<Object|null>} Meeting info or null if not meeting-related
 */
export async function analyzeEmail(email) {
  if (!engine) {
    throw new Error('WebLLM not initialized');
  }

  const prompt = buildAnalysisPrompt(email);

  try {
    const response = await engine.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are a meeting detection assistant. Analyze emails to identify meeting proposals, scheduling discussions, and confirmations. Output JSON only.`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 500
    });

    const result = response.choices[0]?.message?.content;
    return parseAnalysisResult(result, email);
  } catch (error) {
    console.error('Error analyzing email:', error);
    return null;
  }
}

/**
 * Build the analysis prompt for an email
 * @param {Object} email
 * @returns {string}
 */
function buildAnalysisPrompt(email) {
  return `Analyze this email for meeting scheduling content.

From: ${email.from}
To: ${email.to}
Date: ${email.date}
Subject: ${email.subject}

Body:
${email.body.substring(0, 2000)}

If this email contains meeting scheduling discussion, respond with JSON:
{
  "isMeetingRelated": true,
  "type": "proposal|counter-proposal|confirmation|decline|inquiry",
  "proposedTimes": [
    {
      "date": "YYYY-MM-DD",
      "time": "HH:MM",
      "duration": "minutes",
      "confidence": "high|medium|low"
    }
  ],
  "participants": ["email1", "email2"],
  "meetingTitle": "suggested title based on context",
  "status": "proposed|awaiting-response|confirmed|declined",
  "summary": "brief description of the scheduling state"
}

If NOT meeting-related, respond with:
{"isMeetingRelated": false}`;
}

/**
 * Parse the LLM analysis result
 * @param {string} result - Raw LLM output
 * @param {Object} email - Original email
 * @returns {Object|null}
 */
function parseAnalysisResult(result, email) {
  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = result;
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const parsed = JSON.parse(jsonStr.trim());

    if (!parsed.isMeetingRelated) {
      return null;
    }

    return {
      ...parsed,
      sourceEmail: {
        subject: email.subject,
        date: email.date,
        threadId: email.threadId
      }
    };
  } catch (error) {
    console.warn('Failed to parse LLM result:', error);
    return null;
  }
}

/**
 * Convert analysis result to tentative calendar entry
 * @param {Object} analysis - Analysis result
 * @param {string} mailboxId - Mailbox ID
 * @returns {Array} Array of tentative entries (one per proposed time)
 */
export function analysisToEntries(analysis, mailboxId) {
  if (!analysis || !analysis.proposedTimes?.length) {
    return [];
  }

  const entries = [];

  for (const time of analysis.proposedTimes) {
    if (time.confidence === 'low') continue;

    try {
      const startTime = parseProposedTime(time);
      if (!startTime) continue;

      const duration = parseInt(time.duration) || 60;
      const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

      // Skip past times
      if (endTime < new Date()) continue;

      entries.push({
        id: `email-${mailboxId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        mailboxId,
        title: analysis.meetingTitle || 'Tentative Meeting',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        status: 'tentative',
        source: {
          type: 'email',
          emailSubject: analysis.sourceEmail.subject,
          emailDate: analysis.sourceEmail.date,
          emailThreadId: analysis.sourceEmail.threadId,
          negotiationState: {
            proposedTimes: analysis.proposedTimes,
            status: analysis.status || 'proposed',
            participants: analysis.participants || [],
            lastUpdate: new Date().toISOString()
          }
        },
        conflicts: []
      });
    } catch (error) {
      console.warn('Failed to create entry from proposed time:', error);
    }
  }

  return entries;
}

/**
 * Parse a proposed time from LLM output
 * @param {Object} time - Time object from LLM
 * @returns {Date|null}
 */
function parseProposedTime(time) {
  try {
    const dateStr = time.date;
    const timeStr = time.time || '09:00';

    const [year, month, day] = dateStr.split('-').map(Number);
    const [hour, minute] = timeStr.split(':').map(Number);

    return new Date(year, month - 1, day, hour, minute);
  } catch (error) {
    return null;
  }
}

/**
 * Batch analyze multiple emails with progress tracking
 * @param {Array} emails - Array of email objects
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} Array of analysis results
 */
export async function batchAnalyzeEmails(emails, onProgress) {
  const results = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];

    if (onProgress) {
      onProgress({
        phase: 'analyzing',
        current: i + 1,
        total: emails.length,
        currentItem: email.subject
      });
    }

    const result = await analyzeEmail(email);
    if (result) {
      results.push(result);
    }

    // Small delay to prevent overwhelming
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}
