import { api, downloadText, el, notice } from './common.js';
import { animateChange } from './motion.js';

const contexts = {
  resumer: { title: 'Research the blocker, then pick a next step', example: 'Playwright keyboard accessibility testing documentation', description: 'Find current documentation for a task you want to resume, and keep the useful passages beside a cited checklist.', boundary: 'Research does not inspect your project or resolve a saved blocker. Review the suggestions before adding them to your continuation.', label: 'Blocked-task documentation query', checks: 'Next steps to review' },
};
const panel = document.querySelector('[data-research-product]');
if (panel && contexts[panel.dataset.researchProduct]) initialize(panel);

function initialize(panel) {
  if (!document.querySelector('link[href="/research.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/research.css' }));
  const product = panel.dataset.researchProduct;
  const context = contexts[product];
  let configuration; let busy = false; let search; let brief; let savedRecords = []; let activeRecordId;
  const selected = new Set();
  const query = el('input', { id: 'research-query', name: 'research-query', type: 'text', maxlength: 500, required: true, autocomplete: 'off', placeholder: context.example, 'aria-describedby': 'research-disclosure' });
  const searchConsent = el('input', { id: 'research-search-consent', type: 'checkbox' });
  const modelConsent = el('input', { id: 'research-model-consent', type: 'checkbox' });
  const searchButton = el('button', { id: 'research-search', className: 'button primary', type: 'submit', disabled: true, textContent: 'Search with Tavily · 1 credit' });
  const briefButton = el('button', { id: 'research-brief', className: 'button secondary', type: 'button', disabled: true, textContent: 'Draft cited checklist with Nemotron' });
  const status = el('p', { id: 'research-status', className: 'research-status', role: 'status', textContent: 'Checking local configuration. No provider request is made on page load.' });
  const feedback = el('p', { id: 'research-feedback', className: 'research-feedback', role: 'status', 'aria-live': 'polite', hidden: true });
  const historySelect = el('select', { id: 'research-history', 'aria-label': 'Saved research', disabled: true });
  const openSaved = el('button', { id: 'research-open-saved', className: 'button secondary', type: 'button', disabled: true, textContent: 'Open saved research' });
  const historyNote = el('p', { className: 'research-note', textContent: 'Loading saved research from this device. This does not call a provider.' });
  const failureSummary = el('summary');
  const failureReceipts = el('pre', { tabindex: 0 });
  const savedFailures = el('details', { id: 'research-failures', className: 'research-receipt-details', hidden: true }, [failureSummary,
    el('p', { className: 'research-note', textContent: 'These attempts produced no accepted checklist. Reported usage is retained because a rejected result can still consume allowance. No failed request is retried automatically.' }), failureReceipts]);
  const historySection = el('section', { className: 'research-history', 'aria-label': 'Saved research history' }, [
    el('label', { for: 'research-history', textContent: 'Saved searches and checklists' }), historyNote,
    el('div', { className: 'research-history-controls' }, [historySelect, openSaved]), savedFailures,
  ]);
  const results = el('div', { id: 'research-results', className: 'research-results' });
  const checklist = el('div', { id: 'research-checklist', className: 'research-checklist', hidden: true });
  const receipt = el('pre', { id: 'research-receipt', tabindex: 0 });
  const downloads = el('div', { className: 'research-actions', hidden: true });
  const sourceQuery = el('p', { id: 'research-source-query', className: 'research-note' });
  const sourceReview = el('section', { className: 'research-source-review', 'aria-labelledby': 'research-sources-title', hidden: true }, [
    el('h3', { id: 'research-sources-title', tabindex: -1, textContent: 'Review source passages' }),
    sourceQuery,
    el('p', { className: 'research-note', textContent: 'Choose up to three passages for Nemotron. Search snippets are untrusted source material; inspect the original pages before relying on their claims.' }), results,
    el('label', { className: 'research-consent' }, [modelConsent, el('span', { textContent: 'Send this research query and the selected source titles, URLs and passages to the configured Nemotron model.' })]), briefButton,
  ]);
  const form = el('form', { className: 'research-form' }, [
    el('label', { for: 'research-query', textContent: context.label }), query,
    el('p', { id: 'research-disclosure', className: 'research-note', textContent: 'Only the query you enter is sent to Tavily. No project files, quote fields, saved blockers or map data are included. Do not put credentials or private client details in your query.' }),
    el('label', { className: 'research-consent' }, [searchConsent, el('span', { textContent: 'Send this query in one basic search, using at most one Tavily credit from a verified free-only allowance.' })]), searchButton,
  ]);
  panel.hidden = false;
  panel.classList.add('research-panel');
  panel.setAttribute('aria-labelledby', 'research-title');
  panel.replaceChildren(el('div', { className: 'research-heading' }, [
    el('div', {}, [el('p', { className: 'research-eyebrow', textContent: 'Tavily sources → NVIDIA Nemotron checklist' }), el('h2', { id: 'research-title', textContent: context.title })]),
    el('span', { className: 'research-mode', textContent: 'Explicit research' }),
  ]), el('p', { className: 'research-description', textContent: context.description }), status, historySection, form, feedback, sourceReview, checklist, downloads,
  el('details', { className: 'research-receipt-details' }, [el('summary', { textContent: 'Provider receipts and limits' }), el('p', { className: 'research-note', textContent: 'Search and inference have separate receipts. Local configuration is not a verified provider balance. A fixture is never labeled a live call. No automatic retries or decisions.' }), receipt]),
  el('p', { className: 'research-boundary', textContent: context.boundary }));

  function update() {
    panel.setAttribute('aria-busy', String(busy));
    query.disabled = busy; searchConsent.disabled = busy; modelConsent.disabled = busy;
    historySelect.disabled = busy || !savedRecords.length; openSaved.disabled = busy || !historySelect.value;
    searchButton.disabled = busy || !configuration?.available || !searchConsent.checked || !query.value.trim();
    briefButton.disabled = busy || !configuration?.inference?.configured || !modelConsent.checked || selected.size < 1 || selected.size > 3;
    results.querySelectorAll('input').forEach((input) => { input.disabled = busy || (selected.size >= 3 && !input.checked); });
  }
  function resetBrief() {
    brief = null; modelConsent.checked = false; checklist.hidden = true; checklist.replaceChildren();
    renderDownloads(); update();
  }
  function renderDownloads() {
    downloads.hidden = !search;
    downloads.replaceChildren();
    if (!search) return;
    downloads.append(el('button', { className: 'button secondary', type: 'button', textContent: 'Download research evidence JSON', onclick: () => downloadText(`${product}-research-${search.id}.json`, JSON.stringify(brief ?? search, null, 2), 'application/json') }));
    if (brief) downloads.append(el('button', { className: 'button secondary', type: 'button', textContent: 'Download cited checklist', onclick: () => downloadText(`${product}-checklist-${brief.id}.md`, checklistMarkdown(brief)) }));
    receipt.textContent = JSON.stringify(brief ? { search: brief.searchReceipt, inference: brief.inference, disclosure: brief.disclosure, actionExecuted: false } : search.receipt, null, 2);
  }
  function renderHistory() {
    historySelect.replaceChildren(...savedRecords.map((record) => el('option', { value: record.id,
      textContent: `${record.kind === 'tavily-search' ? 'Sources' : 'Checklist'} · ${new Date(record.savedAt).toLocaleString()} · ${record.query.slice(0, 90)}${record.query.length > 90 ? '…' : ''}` })));
    if (savedRecords.some((record) => record.id === activeRecordId)) historySelect.value = activeRecordId;
    historyNote.textContent = savedRecords.length ? 'Recent research for this product, saved on this device. Opening a record uses no provider credits.' : 'No saved research for this product yet. Searches and checklists will remain available after reload.';
    update();
  }
  function applyHistory(value) {
    savedRecords = value.records;
    renderHistory();
    const failures = value.failures ?? [];
    savedFailures.hidden = failures.length === 0;
    failureSummary.textContent = `${failures.length} saved failed checklist attempt${failures.length === 1 ? '' : 's'}`;
    failureReceipts.textContent = JSON.stringify(failures, null, 2);
    if (value.unavailable) historyNote.textContent += ' Some saved records could not be validated and were omitted.';
  }
  function remember(record) {
    activeRecordId = record.id;
    savedRecords = [{ id: record.id, kind: record.kind, query: record.query, savedAt: record.createdAt ?? record.receipt.completedAt }, ...savedRecords.filter((entry) => entry.id !== record.id)].slice(0, 20);
    renderHistory();
  }
  function renderSources() {
    results.replaceChildren();
    sourceQuery.textContent = `Sources for the approved query: “${search.query}”`;
    for (const source of search.results) {
      const checkbox = el('input', { id: `research-source-${source.id}`, type: 'checkbox', value: source.id, checked: selected.has(source.id) });
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(source.id); else selected.delete(source.id); resetBrief(); });
      results.append(el('article', { className: 'research-source' }, [
        el('div', { className: 'research-source-top' }, [el('label', { className: 'research-consent', for: checkbox.id }, [checkbox, el('span', { textContent: `Select ${source.id}` })]),
          el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', textContent: source.title })]),
        el('p', { className: 'research-source-url', textContent: source.url }), el('blockquote', { textContent: source.content }),
      ]));
    }
    sourceReview.hidden = search.results.length === 0;
  }
  function renderChecklist() {
    checklist.hidden = !brief;
    checklist.replaceChildren();
    if (!brief) return;
    const statement = (entry) => el('li', {}, [el('p', { textContent: entry.text }), ...entry.citations.map((citation) => {
      const source = brief.sources.find((item) => item.id === citation.sourceId);
      return el('div', { className: 'research-citation' }, [el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', textContent: `${source.id} · ${source.title}` }), el('q', { textContent: citation.quote })]);
    })]);
    const weak = hasWeakQuotations(brief);
    checklist.replaceChildren(el('h3', { tabindex: -1, textContent: context.checks }), el('p', { className: 'research-note', textContent: `${brief.inference.model} · ${brief.inference.liveInferenceVerified ? 'Live inference response recorded' : 'Live inference not verified'}. Quotes match selected passages; semantic correctness still needs your review.` }),
      ...(weak ? [el('p', { id: 'research-quotation-warning', className: 'research-feedback', role: 'note' }, [el('strong', { textContent: 'Weak quotations detected; do not use these claims until reviewed.' }), ' A citation contains only a list marker, punctuation, or a heading. The original saved receipt is unchanged.'])] : []),
      el('ul', {}, [statement(brief.brief.summary)]), el('h4', { textContent: 'Checks' }), el('ol', {}, brief.brief.checks.map(statement)), el('h4', { textContent: 'Open questions' }),
      brief.brief.questions.length ? el('ul', {}, brief.brief.questions.map(statement)) : el('p', { textContent: 'The model returned no additional questions. This does not establish that the sources are complete.' }));
  }
  async function restore(id) {
    const record = await api('research', 'record', { id, product });
    const restoredSearch = record.kind === 'tavily-search' ? record : await api('research', 'record', { id: record.searchId, product });
    search = restoredSearch; brief = record.kind === 'tavily-nemotron-research' ? record : null;
    activeRecordId = record.id; historySelect.value = record.id;
    query.value = search.query; searchConsent.checked = false; modelConsent.checked = false;
    selected.clear(); brief?.sources.forEach((source) => selected.add(source.id));
    renderSources(); renderChecklist(); renderDownloads();
    notice(feedback, `Restored saved ${brief ? 'checklist and sources' : 'sources'} from this device. No provider request was made. Review the saved date before using these sources.`);
  }
  async function task(work) {
    if (busy) return;
    busy = true; update();
    try { await work(); }
    catch (error) { notice(feedback, error.message, true); }
    finally { busy = false; update(); }
  }
  query.addEventListener('input', () => { searchConsent.checked = false; update(); });
  searchConsent.addEventListener('change', update);
  modelConsent.addEventListener('change', update);
  historySelect.addEventListener('change', update);
  openSaved.addEventListener('click', () => {
    if (openSaved.disabled) return;
    task(async () => { await restore(historySelect.value); (brief ? checklist.querySelector('h3') : document.getElementById('research-sources-title')).focus({ preventScroll: true }); });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (searchButton.disabled) return;
    task(async () => {
      const consent = searchConsent.checked;
      searchConsent.checked = false;
      search = null; selected.clear(); resetBrief(); sourceReview.hidden = true; results.replaceChildren(); receipt.textContent = '';
      notice(feedback, 'Searching the query you approved. One request; no automatic retry.');
      search = await api('research', 'search', { product, query: query.value, consent });
      renderSources(); renderDownloads(); remember(search);
      notice(feedback, `${search.results.length} sources returned. ${search.receipt.liveSearchVerified ? 'Live Tavily response recorded.' : 'Fixture response; live Tavily search was not verified.'} Reported usage: ${search.receipt.usage.credits} credit(s).${search.results.length ? ' Select useful passages before requesting a checklist.' : ' No model checklist can be generated from an empty search.'}`);
      if (search.results.length) {
        document.getElementById('research-sources-title').focus({ preventScroll: true });
        animateChange(results, [{ opacity: .35, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220 });
      }
    });
  });
  briefButton.addEventListener('click', () => {
    if (briefButton.disabled || !search) return;
    task(async () => {
      const consent = modelConsent.checked;
      brief = null; modelConsent.checked = false; checklist.hidden = true; renderDownloads();
      notice(feedback, 'Drafting a checklist from only the selected source passages. No workflow action will be executed.');
      try { brief = await api('research', 'brief', { searchId: search.id, selectedSourceIds: [...selected], consent }); }
      catch (error) {
        try { applyHistory(await api('research', 'history', { product })); } catch { /* Keep the original failure visible. */ }
        throw error;
      }
      renderChecklist(); renderDownloads(); remember(brief);
      notice(feedback, 'Cited checklist saved locally. No saved action ran or blocker was resolved.');
      checklist.querySelector('h3').focus({ preventScroll: true });
      animateChange(checklist, [{ opacity: .35 }, { opacity: 1 }], { duration: 200 });
    });
  });
  task(async () => {
    const [configurationResult, historyResult] = await Promise.allSettled([api('research', 'status'), api('research', 'history', { product })]);
    if (configurationResult.status === 'fulfilled') {
      const value = configuration = configurationResult.value;
      status.textContent = !value.configured ? 'Tavily is not configured. Add TAVILY_API_KEY on the server to search; saved research remains readable.'
      : value.transport === 'test-fixture' ? 'Fixture transport. Searches here do not verify live Tavily access.'
      : value.available ? 'Local free-only controls are configured. Remaining credits and billing settings still require account verification. Each search reserves one attempt.'
      : 'Live search is blocked until free-only account settings, sufficient credits and a bounded local allowance are confirmed.';
    } else status.textContent = configurationResult.reason.message;
    if (historyResult.status !== 'fulfilled') { historyNote.textContent = historyResult.reason.message; return; }
    applyHistory(historyResult.value);
    if (savedRecords.length) await restore(savedRecords[0].id);
  });
}

function hasWeakQuotations(record) {
  return [record.brief.summary, ...record.brief.checks, ...record.brief.questions].some((entry) => entry.citations.some((citation) => {
    const quote = citation.quote.trim();
    if (/^[\p{P}\p{S}\s]+$/u.test(quote) || /^(?:\d+(?:\.\d+)*[.)]?|[a-z][.)]|[ivxlcdm]+[.)]|\((?:\d+|[a-z]|[ivxlcdm]+)\))$/i.test(quote)
      || /^#{1,6}(?:\s|$)|^<h[1-6](?:\s|>)/i.test(quote) || /^(?:\*\*[^*.!?]+\*\*|__[^_.!?]+__):?$/.test(quote)) return true;
    const lines = record.sources.find((source) => source.id === citation.sourceId)?.content.split(/[\r\n]+/u) ?? [];
    return lines.some((line, index) => line.trim() === quote && /^(?:={3,}|-{3,})$/.test(lines[index + 1]?.trim() ?? ''));
  }));
}

function checklistMarkdown(record) {
  const escape = (value) => value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  const statement = (entry) => [`- ${escape(entry.text)}`, ...entry.citations.map((citation) => `  - ${citation.sourceId}: “${escape(citation.quote)}”`)];
  return [`# Research checklist · ${record.product}`, '', `Query: ${escape(record.query)}`, '',
    `Tavily: ${record.searchReceipt.liveSearchVerified ? 'live search response recorded' : 'fixture; live search not verified'}. Nemotron: ${record.inference.liveInferenceVerified ? 'live inference response recorded' : 'live inference not verified'}.`,
    'Quotes are checked for literal membership, not semantic correctness. No workflow action was executed.', '', record.boundary, '',
    '## Summary', ...statement(record.brief.summary), '', '## Checks', ...record.brief.checks.flatMap(statement), '', '## Open questions', ...record.brief.questions.flatMap(statement), '',
    '## Selected sources', ...record.sources.flatMap((source) => [`- ${source.id}: ${escape(source.title)} — <${source.url}>`]), '',
    `Search receipt: ${record.searchReceipt.requestId}`, `Inference receipt: ${record.inference.responseId}`, `Model output SHA-256: ${record.inference.outputSha256}`, '',
  ].join('\n');
}
