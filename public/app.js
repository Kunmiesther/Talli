const SESSION_ID = 'default';
const TIMEZONE = 'Africa/Lagos';
const STORAGE_KEYS = {
  conversation: 'talli:conversation',
  selectedCustomer: 'talli:selectedCustomer',
  autoSeeded: 'talli:autoSeeded',
};

const DEFAULT_WORKSPACE_NOTE = 'Demo data is synthetic. Seed or reset from here.';

const moneyFormatter = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const longDateFormatter = new Intl.DateTimeFormat('en-NG', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dom = {};

const state = {
  loading: true,
  sending: false,
  listening: false,
  apiOnline: false,
  health: null,
  ledger: null,
  customerDetails: new Map(),
  selectedCustomerId: loadStoredJson(STORAGE_KEYS.selectedCustomer, null),
  conversation: loadStoredJson(STORAGE_KEYS.conversation, []),
  clarification: null,
  transcriptPreview: '',
  voiceSupport: {
    supported: false,
    note: 'Speech recognition is not available in this browser. Type your update instead.',
    status: 'ready',
  },
  resetArmed: false,
  notice: '',
};

let recognition = null;
let finalTranscript = '';
let interimTranscript = '';

function loadStoredJson(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveStoredJson(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    void 0;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(minorUnits) {
  if (typeof minorUnits !== 'number' || Number.isNaN(minorUnits)) {
    return moneyFormatter.format(0);
  }
  return moneyFormatter.format(minorUnits / 100);
}

function formatDate(value) {
  if (!value) {
    return 'No due date';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No due date';
  }
  return dateFormatter.format(date);
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return dateTimeFormatter.format(date);
}

function formatLongDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return longDateFormatter.format(date);
}

function detectLanguage(text) {
  return /\b(don|wey|na|carry|dey|dem|im|una|fit|oo|eh|sha)\b/i.test(text) ? 'pcm' : 'en';
}

function statusLabel(status) {
  switch (status) {
    case 'applied':
      return 'Recorded';
    case 'clarification_required':
      return 'Clarification';
    case 'no_action':
      return 'No action';
    case 'error':
      return 'Safe failure';
    default:
      return 'Update';
  }
}

function statusIcon(status) {
  switch (status) {
    case 'applied':
      return 'fa-circle-check';
    case 'clarification_required':
      return 'fa-shield-halved';
    case 'no_action':
      return 'fa-circle-info';
    case 'error':
      return 'fa-triangle-exclamation';
    default:
      return 'fa-comment-dots';
  }
}

function actionLabel(actionType) {
  switch (actionType) {
    case 'CREATE_OBLIGATION':
      return 'Credit sale';
    case 'RECORD_PAYMENT':
      return 'Payment';
    case 'CORRECT_OBLIGATION':
      return 'Correction';
    case 'SETTLE_OBLIGATION':
      return 'Settlement';
    case 'REQUEST_CLARIFICATION':
      return 'Clarification';
    case 'NO_ACTION':
      return 'No action';
    default:
      return 'Update';
  }
}

function responseSummary(response) {
  if (!response) {
    return '';
  }

  if (response.status === 'error') {
    return response.message || 'Nothing was changed.';
  }

  if (response.status === 'clarification_required' && response.clarification) {
    const candidates = response.clarification.candidates
      .map((candidate) => candidate.displayName)
      .join(', ');
    return candidates ? `${response.message} Candidates: ${candidates}.` : response.message;
  }

  if (response.ledgerChange?.customerName) {
    const amount =
      typeof response.ledgerChange.outstandingMinor === 'number'
        ? formatMoney(response.ledgerChange.outstandingMinor)
        : null;
    if (amount) {
      return `${response.message} ${response.ledgerChange.customerName} balance: ${amount}.`;
    }
  }

  return response.message;
}

function renderMetricCard(label, value, note) {
  return `
    <article class="metric">
      <span class="metric__label">${escapeHtml(label)}</span>
      <span class="metric__value">${escapeHtml(value)}</span>
      <span class="metric__note">${escapeHtml(note)}</span>
    </article>
  `;
}

function computeCustomerSummary(customerId) {
  const detail = state.customerDetails.get(customerId);
  const obligations = detail?.obligations ?? [];
  const open = obligations.filter((obligation) => obligation.status === 'open');
  const settled = obligations.filter((obligation) => obligation.status === 'settled');
  const outstandingMinor = open.reduce((sum, obligation) => sum + obligation.outstandingMinor, 0);
  const nextDue =
    open
      .map((obligation) => obligation.dueAt)
      .filter(Boolean)
      .sort((left, right) => String(left).localeCompare(String(right)))[0] ?? null;

  return {
    open,
    settled,
    outstandingMinor,
    nextDue,
  };
}

function aggregatePaymentCount() {
  let count = 0;
  for (const detail of state.customerDetails.values()) {
    for (const event of detail.events ?? []) {
      if (event.kind === 'payment.recorded') {
        count += 1;
      }
    }
  }
  return count;
}

function renderHealth() {
  const healthPill = dom.apiHealthPill;
  const modelPill = dom.modelPill;

  if (state.loading) {
    healthPill.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Checking API';
    modelPill.innerHTML = '<i class="fa-solid fa-circle-info"></i> Waiting for data';
    return;
  }

  if (!state.apiOnline) {
    healthPill.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> API offline';
    modelPill.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Type only';
    return;
  }

  const health = state.health;
  if (!health) {
    healthPill.innerHTML = '<i class="fa-solid fa-circle-info"></i> API ready';
    modelPill.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Safe demo mode';
    return;
  }

  healthPill.innerHTML = '<i class="fa-solid fa-circle-check"></i> API online';
  if (health.modelAvailable) {
    const provider = health.provider ? `Provider: ${health.provider}` : 'Provider connected';
    const model = health.model ? `Model: ${health.model}` : 'Model connected';
    modelPill.innerHTML = `<i class="fa-solid fa-wave-square"></i> ${escapeHtml(provider)} · ${escapeHtml(model)}`;
  } else {
    modelPill.innerHTML =
      '<i class="fa-solid fa-shield-halved"></i> Provider unavailable, ledger stays safe';
  }
}

function renderMetrics() {
  const ledger = state.ledger;
  if (!ledger) {
    dom.metricsGrid.innerHTML = `
      ${renderMetricCard('Total outstanding', formatMoney(0), 'Waiting for the ledger')}
      ${renderMetricCard('Customers owing', '0', 'No customer loaded yet')}
      ${renderMetricCard('Settled debts', '0', 'Seed the demo to inspect history')}
      ${renderMetricCard('Payments recorded', '0', 'Derived from customer histories')}
    `;
    dom.ledgerCount.textContent = '0 customers';
    dom.customerCount.textContent = '0 owing';
    return;
  }

  const owingCustomers = ledger.customers.filter(
    (customer) => computeCustomerSummary(customer.id).outstandingMinor > 0,
  ).length;
  const paymentCount = aggregatePaymentCount();
  const settledDebts = ledger.obligations.filter(
    (obligation) => obligation.status === 'settled',
  ).length;

  dom.metricsGrid.innerHTML = `
    ${renderMetricCard('Total outstanding', formatMoney(ledger.totals.openOutstandingMinor), `${ledger.obligations.length} obligations tracked`)}
    ${renderMetricCard('Customers owing', String(owingCustomers), 'Customers with open balances')}
    ${renderMetricCard('Settled debts', String(settledDebts), 'Closed obligations in history')}
    ${renderMetricCard('Payments recorded', String(paymentCount), 'Derived from customer histories')}
  `;

  dom.ledgerCount.textContent = `${ledger.customers.length} customers`;
  dom.customerCount.textContent = `${owingCustomers} owing`;
}

function renderCustomerList() {
  const ledger = state.ledger;
  if (!ledger || ledger.customers.length === 0) {
    dom.customerList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-users"></i>
        <p>Seed the synthetic demo ledger to inspect customer balances.</p>
      </div>
    `;
    return;
  }

  const customers = [...ledger.customers].sort((left, right) => {
    const leftSummary = computeCustomerSummary(left.id);
    const rightSummary = computeCustomerSummary(right.id);
    const balanceDelta = rightSummary.outstandingMinor - leftSummary.outstandingMinor;
    if (balanceDelta !== 0) {
      return balanceDelta;
    }
    return left.displayName.localeCompare(right.displayName);
  });

  dom.customerList.innerHTML = customers
    .map((customer) => {
      const summary = computeCustomerSummary(customer.id);
      const selected = customer.id === state.selectedCustomerId ? ' customer-row--selected' : '';
      const statusText = summary.outstandingMinor > 0 ? 'Open balance' : 'Settled';
      const dueText = summary.nextDue
        ? `Due ${formatDate(summary.nextDue)}`
        : summary.outstandingMinor > 0
          ? 'No due date'
          : 'Closed';
      const balance =
        summary.outstandingMinor > 0 ? formatMoney(summary.outstandingMinor) : 'Settled';
      return `
        <button
          class="customer-row${selected}"
          type="button"
          data-customer-id="${escapeHtml(customer.id)}"
          aria-pressed="${customer.id === state.selectedCustomerId ? 'true' : 'false'}"
        >
          <span class="customer-row__name">${escapeHtml(customer.displayName)}</span>
          <span class="customer-row__balance">${escapeHtml(balance)}</span>
          <span class="customer-row__status">${escapeHtml(statusText)} &middot; ${customer.aliases?.length ? `${customer.aliases.length} alias${customer.aliases.length === 1 ? '' : 'es'}` : `${customerSummaryObligationCount(customer.id)} obligation${customerSummaryObligationCount(customer.id) === 1 ? '' : 's'}`}</span>
          <span class="customer-row__due">${escapeHtml(dueText)}</span>
        </button>
      `;
    })
    .join('');
}

function customerSummaryObligationCount(customerId) {
  const detail = state.customerDetails.get(customerId);
  return detail?.obligations?.length ?? 0;
}

function renderActivityFeed() {
  const items = state.conversation;
  dom.turnCount.textContent = `${items.length} turn${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    dom.activityFeed.innerHTML = '';
    dom.activityEmpty.hidden = false;
    return;
  }

  dom.activityEmpty.hidden = true;
  dom.activityFeed.innerHTML = items
    .map((item) => {
      const response = item.response;
      const responseHtml = renderResponseBlock(response, item);
      const statusClass = `turn--${response.status}`;
      return `
        <article class="turn card ${statusClass}">
          <div class="turn__meta">
            <span class="turn__badge">
              <i class="fa-solid ${statusIcon(response.status)}"></i>
              ${escapeHtml(statusLabel(response.status))}
              · ${escapeHtml(actionLabel(response.action?.type))}
            </span>
            <time class="turn__time">${escapeHtml(formatDateTime(item.timestamp))}</time>
          </div>
          <p class="turn__input">${escapeHtml(item.text)}</p>
          <div class="turn__response">${responseHtml}</div>
        </article>
      `;
    })
    .join('');
}

function renderResponseBlock(response, item) {
  const summary = escapeHtml(responseSummary(response));
  const extra = [];

  if (response.status === 'clarification_required' && response.clarification?.candidates?.length) {
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Candidates</span>
        <span class="turn-chip__copy">${escapeHtml(
          response.clarification.candidates.map((candidate) => candidate.displayName).join(', '),
        )}</span>
      </div>`,
    );
  }

  if (response.ledgerChange?.customerName) {
    const outstanding =
      typeof response.ledgerChange.outstandingMinor === 'number'
        ? formatMoney(response.ledgerChange.outstandingMinor)
        : 'Updated';
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Ledger update</span>
        <span class="turn-chip__copy">${escapeHtml(response.ledgerChange.customerName)} &middot; ${escapeHtml(outstanding)}</span>
      </div>`,
    );
  }

  if (item.response.status === 'error' && item.response.errorCode) {
    extra.push(
      `<div class="turn-chip">
        <span class="turn-chip__label">Safe failure</span>
        <span class="turn-chip__copy">${escapeHtml(item.response.errorCode)}</span>
      </div>`,
    );
  }

  const extraMarkup = extra.length ? `<div class="turn-list">${extra.join('')}</div>` : '';
  return `<p>${summary}</p>${extraMarkup}`;
}

function renderClarification() {
  if (!state.clarification) {
    dom.clarificationPanel.hidden = true;
    dom.clarificationQuestion.textContent = '';
    dom.clarificationCandidates.innerHTML = '';
    dom.clarificationTitle.textContent = 'Talli needs one safe answer';
    return;
  }

  dom.clarificationPanel.hidden = false;
  dom.clarificationTitle.textContent = 'Clarification required';
  dom.clarificationQuestion.textContent = state.clarification.response.message;
  const candidates = state.clarification.response.clarification?.candidates ?? [];
  dom.clarificationCandidates.innerHTML = candidates
    .map((candidate) => {
      const kindLabel = candidate.kind === 'obligation' ? 'Debt' : 'Customer';
      const suggestion = buildCandidateSuggestion(candidate);
      return `
        <button class="candidate" type="button" data-candidate-suggestion="${escapeHtml(suggestion)}">
          <strong class="candidate__title">${escapeHtml(candidate.displayName)}</strong>
          <span class="candidate__detail">${escapeHtml(kindLabel)} · tap to fill a safe follow-up</span>
        </button>
      `;
    })
    .join('');
}

function buildCandidateSuggestion(candidate) {
  if (candidate.kind === 'obligation') {
    return `The one with ${candidate.displayName}.`;
  }

  if (candidate.displayName.toLowerCase().includes('musa')) {
    return `The first ${candidate.displayName}.`;
  }

  return `I mean ${candidate.displayName}.`;
}

function renderCustomerDetail() {
  const customerId = state.selectedCustomerId;
  const ledger = state.ledger;
  const detail = customerId ? state.customerDetails.get(customerId) : null;

  if (!ledger || !detail || !detail.customer) {
    dom.detailTitle.textContent = 'Select a customer';
    dom.detailStatus.textContent = 'Waiting';
    dom.customerDetail.innerHTML = `
      <div class="empty-state empty-state--detail">
        <i class="fa-solid fa-user-tag"></i>
        <p>Choose a customer to inspect obligations, payments, corrections, and history.</p>
      </div>
    `;
    return;
  }

  const customer = detail.customer;
  const summary = computeCustomerSummary(customer.id);
  const openObligations = [...summary.open].sort((left, right) => {
    const leftDue = left.dueAt ?? left.createdAt;
    const rightDue = right.dueAt ?? right.createdAt;
    return String(leftDue).localeCompare(String(rightDue));
  });
  const settledObligations = [...summary.settled].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const events = [...(detail.events ?? [])].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const recentTurns = [...(detail.recentTurns ?? [])].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const totalOriginalMinor = detail.obligations.reduce(
    (sum, obligation) => sum + obligation.originalAmountMinor,
    0,
  );
  const totalPaidMinor = detail.obligations.reduce(
    (sum, obligation) => sum + obligation.totalPaidMinor,
    0,
  );
  const lastUpdated = events.at(-1)?.timestamp ?? customer.updatedAt;

  dom.detailTitle.textContent = customer.displayName;
  dom.detailStatus.textContent = summary.outstandingMinor > 0 ? 'Open' : 'Settled';

  dom.customerDetail.innerHTML = `
    <div class="detail-hero">
      <div>
        <h4>${escapeHtml(customer.displayName)}</h4>
        <div class="detail-hero__meta">
          <span>${escapeHtml(customer.aliases?.length ? `${customer.aliases.length} alias${customer.aliases.length === 1 ? '' : 'es'}` : 'No aliases recorded')}</span>
          <span>Updated ${escapeHtml(formatLongDate(lastUpdated) || 'recently')}</span>
        </div>
      </div>
      <span class="status-pill ${summary.outstandingMinor > 0 ? 'status-pill--warning' : ''}">
        <i class="fa-solid ${summary.outstandingMinor > 0 ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i>
        ${escapeHtml(summary.outstandingMinor > 0 ? `${formatMoney(summary.outstandingMinor)} outstanding` : 'Settled')}
      </span>
    </div>

    <div class="detail-stats">
      <div class="detail-stat">
        <span class="detail-stat__label">Open obligations</span>
        <span class="detail-stat__value">${escapeHtml(String(openObligations.length))}</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat__label">Settled obligations</span>
        <span class="detail-stat__value">${escapeHtml(String(settledObligations.length))}</span>
      </div>
      <div class="detail-stat">
        <span class="detail-stat__label">Total paid</span>
        <span class="detail-stat__value">${escapeHtml(formatMoney(totalPaidMinor))}</span>
      </div>
    </div>

    <div class="detail-sections">
      <section class="detail-section">
        <h5>Open obligations</h5>
        <div class="obligation-list">
          ${
            openObligations.length
              ? openObligations.map(renderObligationItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-circle-check"></i><p>No open obligations.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Settled obligations</h5>
        <div class="obligation-list">
          ${
            settledObligations.length
              ? settledObligations.map(renderObligationItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-circle-check"></i><p>No settled obligations yet.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Timeline</h5>
        <div class="event-list">
          ${
            events.length
              ? events.map(renderEventItem).join('')
              : `<div class="empty-state"><i class="fa-solid fa-clock"></i><p>No historical events yet.</p></div>`
          }
        </div>
      </section>

      <section class="detail-section">
        <h5>Recent turns</h5>
        <div class="turn-list">
          ${
            recentTurns.length
              ? recentTurns.map(renderTurnChip).join('')
              : `<div class="empty-state"><i class="fa-solid fa-comment-dots"></i><p>No recent turns for this customer.</p></div>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderObligationItem(obligation) {
  const title = `${formatMoney(obligation.originalAmountMinor)} original`;
  const balance =
    obligation.status === 'settled'
      ? 'Settled'
      : `${formatMoney(obligation.outstandingMinor)} remaining`;
  const meta = [
    obligation.dueAt ? `Due ${formatDate(obligation.dueAt)}` : 'No due date',
    `${formatMoney(obligation.totalPaidMinor)} paid`,
  ].join(' · ');

  return `
    <article class="obligation-item">
      <div>
        <div class="obligation-item__title">${escapeHtml(title)}</div>
        <div class="obligation-item__meta">${escapeHtml(meta)}</div>
      </div>
      <div class="obligation-item__status">${escapeHtml(balance)}</div>
    </article>
  `;
}

function renderEventItem(event) {
  const title = eventTitle(event);
  const copy = eventCopy(event);
  return `
    <article class="event-item">
      <div class="event-item__title">${escapeHtml(title)}</div>
      <div class="event-item__copy">${escapeHtml(copy)}</div>
    </article>
  `;
}

function eventTitle(event) {
  switch (event.kind) {
    case 'customer.created':
      return 'Customer recorded';
    case 'obligation.created':
      return `Debt opened for ${formatMoney(event.originalAmountMinor)}`;
    case 'payment.recorded':
      return `Payment of ${formatMoney(event.amountMinor)} recorded`;
    case 'obligation.corrected':
      return `Correction from ${formatMoney(event.previousAmountMinor)} to ${formatMoney(event.correctedAmountMinor)}`;
    case 'decision.clarification_requested':
      return 'Clarification requested';
    case 'decision.no_action':
      return 'No action recorded';
    default:
      return 'Event';
  }
}

function eventCopy(event) {
  switch (event.kind) {
    case 'customer.created':
      return `${event.displayName} added on ${formatDateTime(event.timestamp)}.`;
    case 'obligation.created':
      return `${formatMoney(event.originalAmountMinor)} opened${event.dueAt ? ` · due ${formatDate(event.dueAt)}` : ''}.`;
    case 'payment.recorded':
      return `${formatMoney(event.amountMinor)} moved from ${formatMoney(event.outstandingBeforeMinor)} to ${formatMoney(event.outstandingAfterMinor)} outstanding.`;
    case 'obligation.corrected':
      return `${formatMoney(event.previousAmountMinor)} corrected to ${formatMoney(event.correctedAmountMinor)}. Outstanding changed from ${formatMoney(event.previousOutstandingMinor)} to ${formatMoney(event.correctedOutstandingMinor)}.`;
    case 'decision.clarification_requested':
      return event.question;
    case 'decision.no_action':
      return event.reason ?? 'No action was taken.';
    default:
      return 'Recorded in the audit trail.';
  }
}

function renderTurnChip(turn) {
  return `
    <article class="turn-chip">
      <span class="turn-chip__label">${escapeHtml(turn.status.replaceAll('_', ' '))}</span>
      <span class="turn-chip__copy">${escapeHtml(turn.inputText)}</span>
      <span class="turn-chip__label">${escapeHtml(formatDateTime(turn.timestamp))}</span>
    </article>
  `;
}

function renderConversationEmpty() {
  dom.activityFeed.innerHTML = '';
  dom.activityEmpty.hidden = false;
}

function renderComposerState() {
  const voiceNote = dom.voiceSupportNote;
  const stateChip = dom.composerState;
  const transcript = dom.transcriptPreview;
  const mic = dom.micToggle;
  const sendDisabled = state.sending || state.listening || !dom.composerInput.value.trim();

  if (!state.voiceSupport.supported) {
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = 'unsupported';
    mic.disabled = false;
  } else if (state.listening) {
    voiceNote.textContent =
      'Listening. Speak naturally, then stop to review the text before sending.';
    mic.dataset.state = 'listening';
  } else if (state.voiceSupport.status === 'error') {
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = 'error';
  } else {
    voiceNote.textContent = state.voiceSupport.note;
    mic.dataset.state = '';
  }

  if (state.listening) {
    stateChip.innerHTML = '<i class="fa-solid fa-wave-square"></i> Listening';
  } else if (state.sending) {
    stateChip.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Recording ledger update';
  } else if (state.transcriptPreview) {
    stateChip.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Transcript ready';
  } else if (state.clarification) {
    stateChip.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Clarification waiting';
  } else {
    stateChip.innerHTML = '<i class="fa-solid fa-circle-info"></i> Ready to record';
  }

  transcript.textContent =
    state.transcriptPreview ||
    (state.listening ? 'Listening for speech...' : 'Speech will appear here before you send it.');
  mic.setAttribute('aria-pressed', String(state.listening));
  mic.setAttribute('aria-label', state.listening ? 'Stop voice input' : 'Start voice input');
  mic.querySelector('span').textContent = state.listening ? 'Stop' : 'Voice';
  dom.sendMessage.disabled = sendDisabled;
  dom.micToggle.disabled = state.sending;
}

function renderNotice() {
  dom.workspaceToolbarNote.textContent = state.notice || DEFAULT_WORKSPACE_NOTE;
}

function renderAll() {
  renderHealth();
  renderMetrics();
  renderCustomerList();
  renderActivityFeed();
  renderClarification();
  renderCustomerDetail();
  renderComposerState();
  if (state.notice) {
    renderNotice();
  }
  saveStoredJson(STORAGE_KEYS.conversation, state.conversation);
  saveStoredJson(STORAGE_KEYS.selectedCustomer, state.selectedCustomerId);
}

function setNotice(message) {
  state.notice = message;
  dom.workspaceToolbarNote.textContent = message;
}

function clearNotice() {
  state.notice = '';
  dom.workspaceToolbarNote.textContent = DEFAULT_WORKSPACE_NOTE;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok && path !== '/api/message') {
    const error = new Error(`Request failed with status ${response.status}`);
    error.body = body;
    throw error;
  }

  return body;
}

const api = {
  async health() {
    return apiRequest('/api/health');
  },
  async ledger() {
    return apiRequest(`/api/ledger?sessionId=${encodeURIComponent(SESSION_ID)}`);
  },
  async customers() {
    return apiRequest(`/api/customers?sessionId=${encodeURIComponent(SESSION_ID)}`);
  },
  async customer(customerId) {
    return apiRequest(
      `/api/customers/${encodeURIComponent(customerId)}?sessionId=${encodeURIComponent(SESSION_ID)}`,
    );
  },
  async message(text) {
    return apiRequest('/api/message', {
      method: 'POST',
      body: JSON.stringify({
        text,
        sessionId: SESSION_ID,
        referenceTime: new Date().toISOString(),
        timezone: TIMEZONE,
        language: detectLanguage(text),
      }),
    });
  },
  async seedDemo() {
    return apiRequest('/api/demo/seed', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
  },
  async resetDemo() {
    return apiRequest('/api/demo/reset', {
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
  },
};

async function loadDashboard() {
  state.loading = true;
  document.body.dataset.loading = 'true';
  renderAll();

  try {
    const health = await api.health();
    state.apiOnline = true;
    state.health = health;
    state.notice = '';

    let ledger = await api.ledger();
    if (
      ledger.customers.length === 0 &&
      ledger.obligations.length === 0 &&
      !sessionStorage.getItem(STORAGE_KEYS.autoSeeded)
    ) {
      await api.seedDemo();
      sessionStorage.setItem(STORAGE_KEYS.autoSeeded, '1');
      ledger = await api.ledger();
      state.notice = 'Synthetic demo ledger loaded.';
    }

    state.ledger = ledger;
    await loadCustomerDetails(ledger.customers);

    if (
      !state.selectedCustomerId ||
      !ledger.customers.some((customer) => customer.id === state.selectedCustomerId)
    ) {
      state.selectedCustomerId = ledger.customers[0]?.id ?? null;
    }

    if (state.selectedCustomerId) {
      await ensureCustomerDetail(state.selectedCustomerId);
    }

    if (state.conversation.length > 0) {
      const last = state.conversation[state.conversation.length - 1];
      state.clarification = last.response.status === 'clarification_required' ? last : null;
      if (state.clarification) {
        state.transcriptPreview = '';
      }
    }
  } catch (error) {
    state.apiOnline = false;
    state.health = null;
    state.notice =
      'The API is offline. Typed updates still remain available once the server returns.';
    console.error(error);
  } finally {
    state.loading = false;
    document.body.dataset.loading = 'false';
    document.body.dataset.ready = 'true';
    renderAll();
  }
}

async function loadCustomerDetails(customers) {
  const entries = await Promise.all(
    customers.map(async (customer) => {
      try {
        const detail = await api.customer(customer.id);
        return [customer.id, detail];
      } catch {
        return [customer.id, { customer, obligations: [], events: [], recentTurns: [] }];
      }
    }),
  );
  state.customerDetails = new Map(entries);
}

async function ensureCustomerDetail(customerId) {
  const detail = state.customerDetails.get(customerId);
  if (detail?.customer) {
    return detail;
  }

  try {
    const fetched = await api.customer(customerId);
    state.customerDetails.set(customerId, fetched);
    return fetched;
  } catch {
    return null;
  }
}

function setSelectedCustomer(customerId) {
  state.selectedCustomerId = customerId;
  saveStoredJson(STORAGE_KEYS.selectedCustomer, customerId);
  renderCustomerList();
  renderCustomerDetail();
}

function setComposerText(value) {
  dom.composerInput.value = value;
  state.transcriptPreview = value.trim();
  renderComposerState();
}

function clearComposer() {
  dom.composerInput.value = '';
  state.transcriptPreview = '';
  finalTranscript = '';
  interimTranscript = '';
  renderComposerState();
  dom.composerInput.focus();
}

async function submitComposer() {
  const text = dom.composerInput.value.trim();
  if (!text || state.sending) {
    return;
  }

  state.sending = true;
  state.transcriptPreview = text;
  clearRecognitionBuffer();
  renderComposerState();
  clearNotice();

  const pendingConversationItem = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    text,
    response: {
      status: 'no_action',
      message: 'Sending...',
      action: { type: 'NO_ACTION' },
      ledgerChange: null,
      clarification: null,
      turnId: null,
      sessionId: SESSION_ID,
      errorCode: null,
      modelAvailable: Boolean(state.health?.modelAvailable),
    },
  };

  try {
    const response = await api.message(text);
    pendingConversationItem.response = response;
    state.conversation = [...state.conversation, pendingConversationItem].slice(-24);

    if (response.status === 'clarification_required') {
      state.clarification = pendingConversationItem;
      state.transcriptPreview = '';
    } else {
      state.clarification = null;
    }

    if (response.ledgerChange?.customerId) {
      state.selectedCustomerId = response.ledgerChange.customerId;
      saveStoredJson(STORAGE_KEYS.selectedCustomer, state.selectedCustomerId);
    }

    dom.composerInput.value = '';
    state.transcriptPreview = '';
    clearRecognitionBuffer();
    await refreshLedgerData();
    setNotice(
      response.status === 'applied'
        ? 'Ledger updated.'
        : response.status === 'clarification_required'
          ? 'Clarification stays visible until you resolve it.'
          : response.status === 'no_action'
            ? 'No ledger change was made.'
            : 'The backend returned a safe failure.',
    );
  } catch (error) {
    const safeMessage = 'The API is offline right now. Nothing was changed.';
    state.conversation = [
      ...state.conversation,
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        text,
        response: {
          status: 'error',
          message: safeMessage,
          action: { type: 'NO_ACTION' },
          ledgerChange: null,
          clarification: null,
          turnId: null,
          sessionId: SESSION_ID,
          errorCode: 'API_OFFLINE',
          modelAvailable: false,
        },
      },
    ].slice(-24);
    state.apiOnline = false;
    state.health = null;
    state.notice = safeMessage;
    console.error(error);
  } finally {
    state.sending = false;
    renderAll();
    dom.composerInput.focus();
  }
}

async function refreshLedgerData() {
  const ledger = await api.ledger();
  state.ledger = ledger;
  await loadCustomerDetails(ledger.customers);
  if (state.selectedCustomerId) {
    await ensureCustomerDetail(state.selectedCustomerId);
  }
}

function clearRecognitionBuffer() {
  finalTranscript = '';
  interimTranscript = '';
  state.listening = false;
  state.voiceSupport.status = 'ready';
}

function initSpeechRecognition() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    state.voiceSupport.supported = false;
    state.voiceSupport.note =
      'Voice input is not available in this browser. Type your update instead.';
    renderComposerState();
    return;
  }

  state.voiceSupport.supported = true;
  state.voiceSupport.note = 'Voice input is ready. Speak, then review the text before sending.';
  recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-NG';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.addEventListener('start', () => {
    state.listening = true;
    state.voiceSupport.status = 'listening';
    state.transcriptPreview = '';
    interimTranscript = '';
    finalTranscript = '';
    renderComposerState();
  });

  recognition.addEventListener('result', (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript?.trim() ?? '';
      if (result.isFinal) {
        finalTranscript = `${finalTranscript} ${transcript}`.trim();
      } else {
        interim = transcript;
      }
    }

    interimTranscript = interim;
    const combined = [finalTranscript, interimTranscript].filter(Boolean).join(' ').trim();
    dom.composerInput.value = combined;
    state.transcriptPreview = combined;
    renderComposerState();
  });

  recognition.addEventListener('error', (event) => {
    state.listening = false;
    state.voiceSupport.status = 'error';
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.voiceSupport.note = 'Microphone permission was denied. Type your update instead.';
    } else if (event.error === 'network') {
      state.voiceSupport.note = 'Speech recognition could not connect. Type your update instead.';
    } else {
      state.voiceSupport.note = 'Voice input failed safely. Type your update instead.';
    }
    renderComposerState();
  });

  recognition.addEventListener('end', () => {
    state.listening = false;
    const hadError = state.voiceSupport.status === 'error';
    if (finalTranscript || interimTranscript) {
      const combined = [finalTranscript, interimTranscript].filter(Boolean).join(' ').trim();
      dom.composerInput.value = combined;
      state.transcriptPreview = combined;
      state.voiceSupport.note = 'Transcript ready. Review the text before sending.';
    } else if (!hadError) {
      state.voiceSupport.note = 'No final transcript captured. Try again or type your update.';
      state.transcriptPreview = '';
    }
    state.voiceSupport.status = hadError ? 'error' : 'ready';
    renderComposerState();
  });
}

function toggleRecognition() {
  if (!recognition || !state.voiceSupport.supported || state.sending) {
    return;
  }

  if (state.listening) {
    recognition.stop();
    return;
  }

  try {
    recognition.start();
  } catch {
    state.voiceSupport.status = 'error';
    state.voiceSupport.note = 'Voice input could not start. Type your update instead.';
    renderComposerState();
  }
}

function bindEvents() {
  dom.navToggle.addEventListener('click', () => {
    const isOpen = dom.primaryNav.dataset.open === 'true';
    dom.primaryNav.dataset.open = String(!isOpen);
    dom.navToggle.setAttribute('aria-expanded', String(!isOpen));
  });

  dom.primaryNav.addEventListener('click', (event) => {
    if (
      event.target instanceof HTMLAnchorElement &&
      event.target.getAttribute('href')?.startsWith('#')
    ) {
      dom.primaryNav.dataset.open = 'false';
      dom.navToggle.setAttribute('aria-expanded', 'false');
      if (event.target.getAttribute('href') === '#workspace') {
        window.setTimeout(() => dom.composerInput.focus(), 200);
      }
    }
  });

  for (const button of dom.tryButtons) {
    button.addEventListener('click', () => {
      window.setTimeout(() => dom.composerInput.focus(), 160);
    });
  }

  dom.micToggle.addEventListener('click', toggleRecognition);
  dom.clearComposer.addEventListener('click', clearComposer);
  dom.composerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitComposer();
  });

  dom.customerList.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('[data-customer-id]') : null;
    if (!button) {
      return;
    }
    const customerId = button.getAttribute('data-customer-id');
    if (customerId) {
      setSelectedCustomer(customerId);
    }
  });

  dom.clarificationCandidates.addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('[data-candidate-suggestion]') : null;
    if (!button) {
      return;
    }
    const suggestion = button.getAttribute('data-candidate-suggestion') ?? '';
    if (suggestion) {
      setComposerText(suggestion);
      dom.composerInput.focus();
    }
  });

  dom.seedDemo.addEventListener('click', async () => {
    state.sending = true;
    renderComposerState();
    try {
      await api.seedDemo();
      sessionStorage.setItem(STORAGE_KEYS.autoSeeded, '1');
      state.conversation = [];
      state.clarification = null;
      state.selectedCustomerId = null;
      state.notice = 'Synthetic demo ledger seeded.';
      await refreshLedgerData();
      if (state.ledger?.customers?.[0]?.id) {
        state.selectedCustomerId = state.ledger.customers[0].id;
        await ensureCustomerDetail(state.selectedCustomerId);
      }
      dom.composerInput.focus();
    } catch (error) {
      state.notice = 'Could not seed the demo ledger.';
      console.error(error);
    } finally {
      state.sending = false;
      renderAll();
    }
  });

  dom.resetDemo.addEventListener('click', () => {
    state.resetArmed = true;
    dom.confirmBackdrop.hidden = false;
  });

  dom.cancelReset.addEventListener('click', () => {
    state.resetArmed = false;
    dom.confirmBackdrop.hidden = true;
  });

  dom.confirmReset.addEventListener('click', async () => {
    dom.confirmBackdrop.hidden = true;
    state.resetArmed = false;
    state.sending = true;
    renderComposerState();
    try {
      await api.resetDemo();
      sessionStorage.removeItem(STORAGE_KEYS.conversation);
      sessionStorage.removeItem(STORAGE_KEYS.selectedCustomer);
      state.conversation = [];
      state.clarification = null;
      state.selectedCustomerId = null;
      state.customerDetails = new Map();
      state.notice = 'Synthetic demo ledger reset.';
      await refreshLedgerData();
      dom.composerInput.value = '';
      state.transcriptPreview = '';
      clearRecognitionBuffer();
      dom.composerInput.focus();
    } catch (error) {
      state.notice = 'Could not reset the demo ledger.';
      console.error(error);
    } finally {
      state.sending = false;
      renderAll();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.confirmBackdrop.hidden) {
      dom.confirmBackdrop.hidden = true;
      state.resetArmed = false;
      dom.composerInput.focus();
    }
  });
}

function cacheDom() {
  dom.apiHealthPill = document.querySelector('[data-role="api-health-pill"]');
  dom.modelPill = document.querySelector('[data-role="model-pill"]');
  dom.workspaceToolbarNote = document.querySelector('.workspace-toolbar__note');
  dom.ledgerCount = document.querySelector('[data-role="ledger-count"]');
  dom.customerCount = document.querySelector('[data-role="customer-count"]');
  dom.turnCount = document.querySelector('[data-role="turn-count"]');
  dom.activityFeed = document.querySelector('[data-role="activity-feed"]');
  dom.activityEmpty = document.querySelector('[data-role="activity-empty"]');
  dom.metricsGrid = document.querySelector('[data-role="metrics-grid"]');
  dom.customerList = document.querySelector('[data-role="customer-list"]');
  dom.customerDetail = document.querySelector('[data-role="customer-detail"]');
  dom.detailTitle = document.querySelector('[data-role="detail-title"]');
  dom.detailStatus = document.querySelector('[data-role="detail-status"]');
  dom.clarificationPanel = document.querySelector('[data-role="clarification-panel"]');
  dom.clarificationTitle = document.querySelector('[data-role="clarification-title"]');
  dom.clarificationQuestion = document.querySelector('[data-role="clarification-question"]');
  dom.clarificationCandidates = document.querySelector('[data-role="clarification-candidates"]');
  dom.composerForm = document.querySelector('[data-role="composer-form"]');
  dom.composerInput = document.querySelector('[data-role="composer-input"]');
  dom.micToggle = document.querySelector('[data-role="mic-toggle"]');
  dom.clearComposer = document.querySelector('[data-role="clear-composer"]');
  dom.sendMessage = document.querySelector('[data-role="send-message"]');
  dom.composerState = document.querySelector('[data-role="composer-state"]');
  dom.voiceSupportNote = document.querySelector('[data-role="voice-support-note"]');
  dom.transcriptPreview = document.querySelector('[data-role="transcript-preview"]');
  dom.seedDemo = document.querySelector('[data-role="seed-demo"]');
  dom.resetDemo = document.querySelector('[data-role="reset-demo"]');
  dom.confirmBackdrop = document.querySelector('[data-role="confirm-backdrop"]');
  dom.cancelReset = document.querySelector('[data-role="cancel-reset"]');
  dom.confirmReset = document.querySelector('[data-role="confirm-reset"]');
  dom.navToggle = document.querySelector('[data-role="nav-toggle"]');
  dom.primaryNav = document.querySelector('[data-role="primary-nav"]');
  dom.tryButtons = document.querySelectorAll('a[href="#workspace"]');
}

async function init() {
  cacheDom();
  initSpeechRecognition();
  bindEvents();
  await loadDashboard();
}

window.addEventListener('DOMContentLoaded', () => {
  void init();
});
