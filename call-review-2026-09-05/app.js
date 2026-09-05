'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const clean = (value) => String(value ?? '').replace(/[\u2013\u2014]/g, ' - ');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = clean(text);
    return node;
  };
  const labels = { pending: 'Pending review', approved: 'Approved', changes_requested: 'Changes requested' };
  const sourceLabels = { explicit_request: 'Requested in the call', developer_commitment: 'Commitment in the call', reported_incident: 'Reported issue', claimed_existing_capability: 'Existing capability to verify', proposed_approach: 'Approach discussed', inferred_guardrail: 'Proposed safeguard', explicit_decision: 'Decision in the call', prior_chat_request: 'Earlier discussion', prior_conversation: 'Earlier discussion' };
  const basisLabels = { proposed_verification: 'Proposed check', explicit_call_criterion: 'Criterion from the call', inferred_guardrail: 'Proposed safeguard', explicit_request: 'Requested in the call', explicit_call_target: 'Target discussed in the call' };
  Object.assign(sourceLabels, {
    claimed_already_done: 'Reported as already done', client_agreement: 'Agreement in the call',
    client_stated_condition: 'Condition stated in the call', developer_suggestion: 'Suggestion in the call',
    disputed_existing_claim: 'Existing result disputed', efficiency_aspiration: 'Efficiency goal',
    existing_capability_claim: 'Existing capability to verify', explicit_agreement: 'Agreement in the call',
    explicit_aspirational_target: 'Desired target, not a guarantee', explicit_constraint: 'Required constraint',
    explicit_desired_outcome: 'Desired outcome', explicit_priority: 'Priority stated in the call',
    explicit_proposal: 'Proposal in the call', explicit_requested_outcome: 'Requested outcome',
    explicit_requested_output: 'Requested output', illustrative_example_in_call: 'Illustrative example',
    inferred_verification_task: 'Suggested verification', prior_user_instruction: 'Earlier instruction',
    proposed_design_in_call: 'Design approach discussed', verify_existing_tracker_work: 'Existing work to recheck',
  });
  Object.assign(basisLabels, { inferred_guardrail_for_approval: 'Proposed safeguard for approval', call_criterion: 'Criterion from the call' });
  let data = null;
  let config = null;
  let saved = null;
  const fingerprints = new Map();
  let token = null;
  let apiBase = '';
  let tokenKey = '';
  let busy = false;
  let revisionMismatch = false;
  let pendingRetry = null;
  let toastTimer;
  let category = 'all';
  let statusFilter = 'all';
  let query = '';
  let selected = new Set();
  let feedbackItem = null;
  let feedbackMode = 'comment';
  let approvalItems = [];
  let approvalNeedsResolution = false;
  let returnFocus = null;

  // Capability never enters a query string, export, log, localStorage or DOM.
  let incomingToken = new URLSearchParams(location.hash.slice(1)).get('review');
  if (incomingToken !== null) history.replaceState(null, '', location.pathname + location.search);

  function notice(message, tone = '', refresh = false) {
    $('connection-banner').className = `notice ${tone}`;
    $('connection-text').textContent = message;
    $('refresh-state').hidden = !refresh;
    $('retry-save').hidden = !pendingRetry;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }

  function itemState(item) {
    const entry = saved?.items?.[item.id];
    const stale = !!entry && (String(entry.revision) !== String(item.revision) || entry.fingerprint !== fingerprints.get(item.id));
    const status = stale ? 'pending' : (labels[entry?.status] ? entry.status : 'pending');
    return { ...entry, status, stale, comments: Array.isArray(entry?.comments) ? entry.comments : [] };
  }

  function canSave() {
    return !!(token && apiBase && saved && !busy && !revisionMismatch && !pendingRetry);
  }

  function requiresResolution(item) {
    const state = itemState(item);
    return state.status === 'changes_requested' || !!item.clarification_required || !!item.comments_needed
      || !!state.clarification_required || !!state.comments_needed || !!state.resolution_required;
  }

  function eligible(item) {
    const state = itemState(item);
    return state.status === 'pending' && !state.comments.length && !requiresResolution(item);
  }

  function filteredItems() {
    return data.requirements.filter((item) => (category === 'all' || item.category === category)
      && (statusFilter === 'all' || itemState(item).status === statusFilter)
      && (!query || [item.id, item.title, item.category, item.problem, item.requested_outcome].join(' ').toLowerCase().includes(query)));
  }

  function timeLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(date) + ' IST';
  }

  function makeButton(text, className, onClick, disabled = false) {
    const button = el('button', className, text);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function detailSection(container, title, content) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', title), content);
    container.append(section);
  }

  function createCard(item) {
    const state = itemState(item);
    const card = el('article', `requirement-card ${state.status === 'approved' ? 'is-approved' : ''} ${selected.has(item.id) ? 'is-selected' : ''}`);
    card.id = item.id;
    card.setAttribute('aria-labelledby', `title-${item.id}`);
    const top = el('div', 'card-top');
    const meta = el('div', 'card-meta');
    meta.append(el('span', 'item-id', item.id));
    meta.append(el('span', 'priority', { P0: 'First priority', P1: 'Next priority', P2: 'Follow-on' }[item.priority] || 'For review'));
    meta.append(el('span', `status-pill ${state.status}`, (state.status === 'approved' ? '✓ ' : '') + labels[state.status]));
    top.append(meta, el('p', 'category-label', item.category));
    const titleRow = el('div', 'card-title-row');
    if (eligible(item)) {
      const check = el('input', 'card-select');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `Select ${item.id}: ${clean(item.title)}`);
      check.checked = selected.has(item.id);
      check.disabled = !canSave();
      check.addEventListener('change', () => {
        if (check.checked) selected.add(item.id); else selected.delete(item.id);
        card.classList.toggle('is-selected', check.checked);
        renderSelection();
      });
      titleRow.append(check);
    }
    const title = el('h3', '', item.title);
    title.id = `title-${item.id}`;
    titleRow.append(title);
    top.append(titleRow, el('p', 'card-outcome', item.requested_outcome));
    if (state.stale) top.append(el('p', 'revision-note', 'This wording has changed since the previous review. Please review it again. Earlier feedback is retained.'));
    if (item.clarification_required || item.comments_needed || state.clarification_required || state.comments_needed) {
      const decision = el('p', 'decision-note');
      decision.append(el('strong', '', 'Please clarify: '), document.createTextNode(clean(item.comment_prompt || item.decision_needed || 'Add a short note confirming this decision before approval.')));
      top.append(decision);
    }
    card.append(top);

    const details = el('details', 'card-details');
    details.append(el('summary', '', 'Context, source and acceptance checks'));
    const body = el('div', 'details-body');
    if (item.problem) detailSection(body, 'Why this matters', el('p', '', item.problem));
    if (item.decision_needed && !item.clarification_required && !item.comments_needed) detailSection(body, 'Review note', el('p', '', item.decision_needed));
    if (Array.isArray(item.acceptance_checks) && item.acceptance_checks.length) {
      const checks = el('ul', 'check-list');
      for (const check of item.acceptance_checks) {
        const li = el('li', '', check.text || check);
        if (check.basis) li.append(el('span', 'basis', basisLabels[check.basis] || 'Proposed check for review'));
        checks.append(li);
      }
      detailSection(body, 'How we will check the result', checks);
    }
    if (Array.isArray(item.evidence) && item.evidence.length) {
      const evidence = el('div');
      for (const source of item.evidence) {
        const block = el('blockquote', 'evidence');
        block.append(el('p', '', source.summary || source.quote || 'Discussed in the source conversation.'));
        const where = source.time_range ? `Call section ${clean(source.time_range)}. Approximate section timing.` : item.source?.label || 'Earlier discussion';
        block.append(el('cite', '', where));
        evidence.append(block);
      }
      detailSection(body, 'Where this came from', evidence);
    }
    if (item.source?.label || item.source_classification?.length) {
      const tags = el('div', 'source-tags');
      if (item.source?.label) tags.append(el('span', 'source-tag', item.source.label));
      for (const source of item.source_classification || []) tags.append(el('span', 'source-tag', sourceLabels[source] || 'Source interpretation for review'));
      detailSection(body, 'Source notes', tags);
    }
    if (item.dependencies?.length) {
      const dep = el('p', 'dependency', 'Related requirements: ');
      item.dependencies.forEach((id, index) => {
        if (index) dep.append(document.createTextNode(', '));
        const link = el('a', '', id);
        link.href = '#' + encodeURIComponent(id);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          category = 'all'; statusFilter = 'all'; query = ''; $('search').value = '';
          render();
          const target = document.getElementById(id);
          if (target) { target.scrollIntoView({ behavior: 'auto', block: 'center' }); target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
        });
        dep.append(link);
      });
      detailSection(body, 'Connections', dep);
    }
    if (item.implementation_status) detailSection(body, 'Implementation status', el('p', '', item.implementation_status));
    details.append(body);
    card.append(details);

    if (state.comments.length) {
      const history = el('section', 'feedback-history');
      history.append(el('h4', '', 'Saved feedback'));
      for (const comment of state.comments) {
        const block = el('div', 'comment');
        block.append(el('p', '', (comment.kind === 'resolution' ? 'Review resolution: ' : '') + comment.text));
        if (timeLabel(comment.at)) { const time = el('time', '', timeLabel(comment.at)); time.dateTime = comment.at; block.append(time); }
        history.append(block);
      }
      if (state.resolution) { const resolution = el('div', 'comment'); resolution.append(el('p', '', 'Review resolution: ' + state.resolution)); history.append(resolution); }
      card.append(history);
    }
    const actions = el('div', 'card-actions');
    actions.append(makeButton('Comment', 'button ghost', () => openFeedback(item, 'comment'), !canSave()));
    actions.append(makeButton('Propose change', 'button secondary', () => openFeedback(item, 'request_changes'), !canSave()));
    if (state.status === 'approved') {
      actions.append(el('span', 'saved-tag', '✓ Approval saved'));
      actions.append(makeButton('Reopen', 'text-button reopen-button', () => saveActions([{ id: item.id, action: 'reopen', revision: item.revision }], 'Requirement reopened.'), !canSave()));
    } else {
      const label = state.stale ? 'Approve revised requirement' : state.status === 'changes_requested' || state.resolution_required ? 'Revalidate & approve' : requiresResolution(item) ? 'Clarify & approve' : 'Approve';
      actions.append(makeButton(label, 'button primary', () => {
        if (requiresResolution(item) || state.stale) openApproval([item]);
        else saveActions([{ id: item.id, action: 'approve', revision: item.revision }], 'Approval saved to the shared review.');
      }, !canSave()));
    }
    card.append(actions);
    return card;
  }

  function renderSelection() {
    for (const id of selected) {
      const item = data.requirements.find((r) => r.id === id);
      if (!item || !eligible(item)) selected.delete(id);
    }
    $('bulk-bar').hidden = selected.size === 0;
    $('selected-count').textContent = selected.size;
    $('approve-selected').disabled = !canSave();
    const visible = filteredItems().filter(eligible);
    const count = visible.filter((item) => selected.has(item.id)).length;
    $('select-visible').checked = visible.length > 0 && count === visible.length;
    $('select-visible').indeterminate = count > 0 && count < visible.length;
    $('select-visible').disabled = !canSave() || !visible.length;
  }

  function render() {
    if (!data) return;
    const counts = { pending: 0, approved: 0, changes_requested: 0 };
    for (const item of data.requirements) counts[itemState(item).status]++;
    const total = data.requirements.length;
    const percent = total ? Math.round(counts.approved / total * 100) : 0;
    $('approved-number').textContent = saved ? counts.approved : '0';
    $('total-number').textContent = `of ${total} approved`;
    $('progress-percent').textContent = saved ? `${percent}%` : 'Not connected';
    $('review-progress').value = saved ? percent : 0;
    $('review-progress').textContent = `${percent}%`;
    $('pending-number').textContent = `${counts.pending} pending`;
    $('changes-number').textContent = `${counts.changes_requested} need changes`;
    $('count-all').textContent = total;
    $('count-pending').textContent = counts.pending;
    $('count-approved').textContent = counts.approved;
    $('count-changes').textContent = counts.changes_requested;
    $('sync-label').textContent = saved ? (busy ? 'Saving to the shared review...' : `Shared review${timeLabel(saved.updated_at) ? '. Updated ' + timeLabel(saved.updated_at) : ' loaded'}.`) : 'Read-only view. Open your secure review link to load and save shared decisions.';
    if (revisionMismatch) $('sync-label').textContent = 'The document has changed. Refresh the page before approving.';
    if (pendingRetry) $('sync-label').textContent = 'Save not yet confirmed. Retry the save to check its result.';
    $('end-session').hidden = !token;
    $('document-version').textContent = config ? `· Revision ${config.document_revision}` : '';
    $('export-json').disabled = !saved || revisionMismatch || busy || !!pendingRetry;
    $('export-markdown').disabled = !saved || revisionMismatch || busy || !!pendingRetry;
    all('.status-tab').forEach((button) => { const active = button.dataset.status === statusFilter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
    all('.category-nav button').forEach((button) => { const active = button.dataset.category === category; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
    $('category-select').value = category;
    const visible = filteredItems();
    $('list-title').textContent = category === 'all' ? 'All requirements' : category;
    $('result-count').textContent = `${visible.length} of ${total} requirements shown`;
    const fragment = document.createDocumentFragment();
    visible.forEach((item) => fragment.append(createCard(item)));
    $('requirements').replaceChildren(fragment);
    $('no-results').hidden = visible.length !== 0;
    renderSelection();
  }

  function populateCategories() {
    const categories = [...new Set(data.requirements.map((item) => item.category))];
    for (const name of ['all', ...categories]) {
      const count = name === 'all' ? data.requirements.length : data.requirements.filter((item) => item.category === name).length;
      const button = makeButton(name === 'all' ? 'All requirements' : name, '', () => { category = name; render(); });
      button.dataset.category = name;
      button.append(el('span', '', count));
      $('category-nav').append(button);
      if (name !== 'all') { const option = el('option', '', name); option.value = name; $('category-select').append(option); }
    }
  }

  function populateDecisions() {
    if (!data.decisions?.length) return;
    const foldout = el('details', 'document-notes');
    foldout.append(el('summary', '', 'Call decisions and open questions'));
    const body = el('div', 'document-notes-body');
    for (const decision of data.decisions) {
      const block = el('section');
      block.append(el('h3', '', decision.title), el('p', '', decision.detail));
      const relatedClarification = (decision.related_requirements || []).some((id) => {
        const item = data.requirements.find((requirement) => requirement.id === id);
        return item && (item.clarification_required || item.comments_needed);
      });
      block.append(el('span', 'source-tag', relatedClarification ? 'Needs confirmation in the related requirement' : 'Review context'));
      body.append(block);
    }
    if (data.tracker_overlay?.links?.length) {
      const tracker = el('section');
      tracker.append(el('h3', '', 'Work already linked to the tracker'));
      tracker.append(el('p', '', 'Related work still needs verification against these requirements. A linked change is not client acceptance.'));
      for (const link of data.tracker_overlay.links) {
        const paragraph = el('p', '', link.summary);
        if (link.prs?.length) {
          paragraph.append(document.createTextNode(' Related changes: '));
          link.prs.filter((number) => Number.isInteger(number) && number > 0).forEach((number, index) => {
            if (index) paragraph.append(document.createTextNode(', '));
            const pr = el('a', '', '#' + number);
            pr.href = 'https://github.com/TranquilVedaPvtLtd/algoveda-platform/pull/' + number;
            pr.target = '_blank';
            pr.rel = 'noopener noreferrer';
            paragraph.append(pr);
          });
        }
        tracker.append(paragraph);
      }
      body.append(tracker);
    }
    foldout.append(body);
    $('connection-banner').insertAdjacentElement('afterend', foldout);
  }

  function showDialog(dialog) {
    returnFocus = document.activeElement;
    dialog.showModal();
  }

  function closeDialog(dialog) {
    if (busy) return;
    dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  function setFeedbackMode(mode) {
    feedbackMode = mode;
    const change = mode === 'request_changes';
    $('mode-comment').setAttribute('aria-pressed', !change);
    $('mode-change').setAttribute('aria-pressed', change);
    $('feedback-title').textContent = change ? 'Propose a change' : 'Add a comment';
    $('feedback-label').textContent = change ? 'What should change, and why?' : 'Your comment';
    $('submit-feedback').textContent = change ? 'Save proposed change' : 'Save comment';
    $('proposed-wording-wrap').hidden = !change;
  }

  function openFeedback(item, mode) {
    if (!canSave()) return;
    feedbackItem = item;
    $('feedback-id').textContent = item.id;
    $('feedback-subtitle').textContent = clean(item.title);
    $('feedback-text').value = '';
    $('proposed-wording').value = '';
    $('feedback-error').hidden = true;
    setFeedbackMode(mode);
    showDialog($('feedback-dialog'));
    $('feedback-text').focus();
  }

  function openApproval(items) {
    if (!canSave()) return;
    approvalItems = items;
    approvalNeedsResolution = items.some(requiresResolution);
    $('approve-title').textContent = items.length > 1 ? `Approve ${items.length} requirements?` : (itemState(items[0]).stale ? 'Approve revised requirement?' : approvalNeedsResolution ? 'Revalidate this requirement?' : 'Approve this requirement?');
    $('approve-description').textContent = approvalNeedsResolution ? 'Read the feedback or open question. Explain the resolution before approving the current wording. Earlier comments stay in the review history.' : 'This confirms the proposed wording and checks. It does not confirm that the work is finished.';
    $('approve-list').replaceChildren(...items.map((item) => el('li', '', `${item.id}: ${item.title}`)));
    $('resolution-wrap').hidden = !approvalNeedsResolution;
    $('resolution').required = approvalNeedsResolution;
    $('resolution').value = '';
    $('approve-confirm').checked = false;
    $('approve-confirm-label').textContent = approvalNeedsResolution ? 'I have reviewed the feedback and confirm that the current wording is acceptable.' : 'I have read these requirements and agree with the proposed wording and checks.';
    $('approve-error').hidden = true;
    showDialog($('approve-dialog'));
  }

  async function fetchTimed(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try { return await fetch(url, { ...options, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  }

  async function fingerprint(item) {
    const encoded = new TextEncoder().encode(JSON.stringify(canonical(item)));
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function acceptState(next) {
    if (!next || !Number.isInteger(next.version) || !next.items || typeof next.items !== 'object') throw new Error('Invalid review response');
    if (String(next.document_revision) !== String(config.document_revision)) {
      revisionMismatch = true;
      notice('The document has changed since this page was opened. Reload the page before making another decision.', 'warning', true);
    }
    const mismatchedItem = data.requirements.some((item) => next.items[item.id]?.fingerprint !== fingerprints.get(item.id));
    if (mismatchedItem) {
      revisionMismatch = true;
      notice('The requirement wording on this page does not match the shared review. Reload the page before making decisions.', 'warning', true);
    }
    saved = next;
  }

  async function refreshState(options = {}) {
    if (!token || !apiBase) return false;
    try {
      const response = await fetchTimed(`${apiBase}/state?document_id=${encodeURIComponent(config.document_id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) {
        token = null; saved = null;
        try { sessionStorage.removeItem(tokenKey); } catch (_) { /* no durable token fallback */ }
        notice('This secure review link is not valid or has expired. Please ask the project team for a new link.', 'warning');
        render(); return false;
      }
      if (!response.ok) throw new Error('Review unavailable');
      acceptState(await response.json());
      if (!revisionMismatch && !options.keepNotice && !pendingRetry) notice('Connected to the shared review. Approvals and comments are saved only after confirmation.', 'success', true);
      render(); return true;
    } catch (_) {
      notice('The shared review is unavailable. No new decision has been saved. Refresh to reconnect.', 'warning', true);
      render(); return false;
    }
  }

  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function saveActions(actions, successMessage, formError = null, retry = false) {
    if ((!retry && !canSave()) || busy) return false;
    const request = retry ? pendingRetry : {
      body: { document_id: config.document_id, document_revision: config.document_revision, expected_version: saved.version, request_id: requestId(), actions: actions.map((action) => ({ ...action, fingerprint: fingerprints.get(action.id) })) },
      successMessage,
    };
    if (!request) return false;
    busy = true;
    $('submit-feedback').disabled = true;
    $('confirm-approve').disabled = true;
    $('retry-save').disabled = true;
    if (formError) formError.hidden = true;
    render();
    let result = false;
    try {
      const response = await fetchTimed(`${apiBase}/review`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) });
      if (response.status === 409) {
        pendingRetry = null;
        await refreshState({ keepNotice: true });
        const message = 'Another review change was saved first. We refreshed the shared status. Check it, then submit your decision again. Your unsent text is still here.';
        notice(message, 'warning', true);
        if (formError) { formError.textContent = message; formError.hidden = false; }
      } else if (!response.ok) {
        pendingRetry = null;
        const message = response.status === 401 || response.status === 403 ? 'Your review link is no longer valid. Please reopen a current secure link.' : 'This change was not saved. Please refresh the review and check the current requirement before trying again.';
        notice(message, 'warning', true);
        if (formError) { formError.textContent = message; formError.hidden = false; }
      } else {
        acceptState(await response.json());
        pendingRetry = null;
        request.body.actions.forEach((action) => selected.delete(action.id));
        if (!revisionMismatch) notice('Connected to the shared review. The latest decision has been saved.', 'success', true);
        toast(request.successMessage);
        result = true;
      }
    } catch (_) {
      // Keep the SAME request_id for ambiguous outcomes. Never invent success
      // or resend a comment under a new id after a lost server response.
      pendingRetry = request;
      const message = 'We could not confirm the save. Retry save to check the same request safely. No further changes can be submitted until its result is confirmed.';
      notice(message, 'warning', true);
      if (formError) { formError.textContent = message; formError.hidden = false; }
    } finally {
      busy = false;
      $('submit-feedback').disabled = !canSave();
      $('confirm-approve').disabled = !canSave();
      $('retry-save').disabled = false;
      render();
    }
    if (result) { $('feedback-dialog').close(); $('approve-dialog').close(); }
    return result;
  }

  function exportReview(format) {
    if (!saved || revisionMismatch || busy || pendingRetry) return;
    const approved = data.requirements.filter((item) => itemState(item).status === 'approved' && !itemState(item).stale);
    const feedback = data.requirements.filter((item) => itemState(item).comments.length).map((item) => ({ id: item.id, title: item.title, status: itemState(item).status, revision: item.revision, comments: itemState(item).comments, resolution: itemState(item).resolution || null }));
    const report = { document_id: config.document_id, document_revision: config.document_revision, title: data.document_title, exported_at: new Date().toISOString(), saved_review_version: saved.version, saved_review_updated_at: saved.updated_at, approval_scope: 'Agreement with requirements only. Not completion, deployment or trading approval.', total_requirements: data.requirements.length,
      pending_requirement_ids: data.requirements.filter((item) => itemState(item).status === 'pending').map((item) => item.id),
      changes_requested_requirement_ids: data.requirements.filter((item) => itemState(item).status === 'changes_requested').map((item) => item.id),
      approved_requirements: approved.map((item) => ({ ...item, status: 'approved', fingerprint: itemState(item).fingerprint,
        comments: itemState(item).comments, history: itemState(item).history || [], resolution: itemState(item).resolution || null })), feedback };
    let content;
    if (format === 'json') content = JSON.stringify(report, null, 2);
    else {
      const lines = ['# AlgoVeda requirements review', '', `Document revision: ${config.document_revision}`, `Saved review version: ${saved.version}`, `Exported: ${report.exported_at}`, '', report.approval_scope, '', `This export contains ${approved.length} approved requirements out of ${report.total_requirements} total.`, `Pending: ${report.pending_requirement_ids.join(', ') || 'None'}`, `Changes requested: ${report.changes_requested_requirement_ids.join(', ') || 'None'}`, '', `## Approved requirements (${approved.length})`, ''];
      if (!approved.length) lines.push('No requirements are currently approved.', '');
      approved.forEach((item) => {
        lines.push(`### ${item.id}: ${item.title}`, '', item.requested_outcome, '',
          `Category: ${item.category}. Priority: ${item.priority}. Requirement revision: ${item.revision}.`,
          `Source: ${item.source?.label || 'Review source'}${item.source_classification?.length ? '; ' + item.source_classification.map((source) => sourceLabels[source] || 'Source interpretation for review').join('; ') : ''}.`);
        if (item.dependencies?.length) lines.push('Dependencies: ' + item.dependencies.join(', ') + '.');
        if (item.timing) lines.push('Timing: ' + (typeof item.timing === 'string' ? item.timing : [item.timing.phrases?.join('; '), item.timing.note].filter(Boolean).join('. ')));
        if (item.decision_needed) lines.push('Review note: ' + item.decision_needed);
        lines.push('', 'Acceptance checks:', '');
        (item.acceptance_checks || []).forEach((check) => lines.push(`- ${check.text || check}${check.basis ? ' (' + (basisLabels[check.basis] || 'Proposed check for review') + ')' : ''}`));
        if (itemState(item).resolution) lines.push('', 'Review resolution: ' + itemState(item).resolution);
        lines.push('');
      });
      lines.push('## Saved feedback', '');
      if (!feedback.length) lines.push('No feedback has been saved.');
      feedback.forEach((item) => {
        lines.push(`### ${item.id}: ${item.title}`, '', `Status: ${labels[item.status]}`, '');
        item.comments.forEach((comment) => lines.push(`- ${timeLabel(comment.at)}: ${comment.kind === 'resolution' ? 'Review resolution: ' : ''}${comment.text}`, ''));
        if (item.resolution) lines.push('Review resolution: ' + item.resolution, '');
      });
      content = clean(lines.join('\n'));
    }
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a'); link.href = url; link.download = `algoveda-approved-review-r${config.document_revision}.${format === 'json' ? 'json' : 'md'}`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.querySelector('.export-menu').open = false;
  }

  function resetFilters() { category = 'all'; statusFilter = 'all'; query = ''; $('search').value = ''; render(); }
  $('search').addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); render(); });
  $('category-select').addEventListener('change', (event) => { category = event.target.value; render(); });
  all('.status-tab').forEach((button) => button.addEventListener('click', () => { statusFilter = button.dataset.status; render(); }));
  $('clear-filters').addEventListener('click', resetFilters);
  $('no-results-reset').addEventListener('click', resetFilters);
  $('reload-page').addEventListener('click', () => location.reload());
  $('refresh-state').addEventListener('click', () => { if (revisionMismatch) location.reload(); else refreshState(); });
  $('retry-save').addEventListener('click', () => saveActions([], '', null, true));
  $('select-visible').addEventListener('change', (event) => { filteredItems().filter(eligible).forEach((item) => { if (event.target.checked) selected.add(item.id); else selected.delete(item.id); }); render(); });
  $('clear-selection').addEventListener('click', () => { selected.clear(); render(); });
  $('approve-selected').addEventListener('click', () => openApproval(data.requirements.filter((item) => selected.has(item.id) && eligible(item))));
  $('mode-comment').addEventListener('click', () => setFeedbackMode('comment'));
  $('mode-change').addEventListener('click', () => setFeedbackMode('request_changes'));
  all('.close-dialog').forEach((button) => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
  all('dialog').forEach((dialog) => dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); }));
  $('feedback-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!feedbackItem || !canSave()) return;
    let comment = $('feedback-text').value.trim();
    if (!comment) { $('feedback-text').setCustomValidity('Please add your feedback.'); $('feedback-text').reportValidity(); return; }
    $('feedback-text').setCustomValidity('');
    if (feedbackMode === 'request_changes' && $('proposed-wording').value.trim()) comment += '\n\nProposed wording:\n' + $('proposed-wording').value.trim();
    if (comment.length > 4000) {
      $('feedback-error').textContent = 'Your feedback and suggested wording must total 4,000 characters or fewer. Please shorten them before saving.';
      $('feedback-error').hidden = false;
      return;
    }
    await saveActions([{ id: feedbackItem.id, action: feedbackMode, comment, revision: feedbackItem.revision }], feedbackMode === 'request_changes' ? 'Proposed change saved. This requirement needs review.' : 'Comment saved. Any earlier approval has been reopened.', $('feedback-error'));
  });
  $('feedback-text').addEventListener('input', () => $('feedback-text').setCustomValidity(''));
  $('approve-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canSave() || !approvalItems.length || !$('approve-confirm').checked) return;
    const resolution = $('resolution').value.trim();
    if (approvalNeedsResolution && !resolution) { $('resolution').setCustomValidity('Please explain the resolution.'); $('resolution').reportValidity(); return; }
    if (resolution.length > 4000) {
      $('approve-error').textContent = 'Please keep your resolution within 4,000 characters.';
      $('approve-error').hidden = false;
      return;
    }
    $('resolution').setCustomValidity('');
    await saveActions(approvalItems.map((item) => ({ id: item.id, action: 'approve', revision: item.revision, ...(approvalNeedsResolution ? { resolution } : {}) })), approvalItems.length > 1 ? `${approvalItems.length} approvals saved to the shared review.` : 'Approval and resolution saved to the shared review.', $('approve-error'));
  });
  $('resolution').addEventListener('input', () => $('resolution').setCustomValidity(''));
  $('export-json').addEventListener('click', () => exportReview('json'));
  $('export-markdown').addEventListener('click', () => exportReview('markdown'));
  $('end-session').addEventListener('click', () => {
    if (busy) return;
    try { sessionStorage.removeItem(tokenKey); } catch (_) { /* no other token store */ }
    token = null; saved = null; pendingRetry = null; selected.clear();
    $('feedback-dialog').close(); $('approve-dialog').close();
    notice('Review session ended on this browser. Saved approvals remain in the shared review.', '', false);
    render();
  });

  async function init() {
    try {
      const [documentResponse, configResponse] = await Promise.all([fetchTimed('requirements.json'), fetchTimed('config.json')]);
      if (!documentResponse.ok) throw new Error('Requirements unavailable');
      data = await documentResponse.json();
      if (!Array.isArray(data.requirements) || !data.requirements.length) throw new Error('No requirements');
      await Promise.all(data.requirements.map(async (item) => fingerprints.set(item.id, await fingerprint(item))));
      config = configResponse.ok ? await configResponse.json() : null;
      if (!config?.document_id || config.document_revision === undefined) config = { document_id: data.document_id, document_revision: data.document_revision, api_url: '' };
      if (!config.document_id || config.document_revision === undefined) throw new Error('Missing document identity');
      if (String(data.document_revision) !== String(config.document_revision) || data.document_id !== config.document_id) revisionMismatch = true;
      if (config.api_url) {
        const url = new URL(config.api_url);
        if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) apiBase = url.href.replace(/\/$/, '');
      }
      tokenKey = `algoveda-review:${config.document_id}`;
      try {
        if (incomingToken && incomingToken.length <= 4096) sessionStorage.setItem(tokenKey, incomingToken);
        incomingToken = null;
        token = sessionStorage.getItem(tokenKey);
      } catch (_) { incomingToken = null; token = null; }
      populateCategories();
      populateDecisions();
      $('review-layout').hidden = false;
      render();
      if (revisionMismatch) notice('This page and its review version do not match. Reload the page before making decisions.', 'warning', true);
      else if (token && apiBase) await refreshState();
      else notice(apiBase ? 'Read-only view. Use your secure review link to load saved decisions, approve requirements and add feedback.' : 'This review is ready to read. Shared approval is not connected yet, so no decisions can be saved here.', '', false);
    } catch (_) {
      incomingToken = null;
      $('load-error').hidden = false;
      $('connection-banner').hidden = true;
      $('sync-label').textContent = 'The document could not be loaded.';
    }
  }
  init();
})();
