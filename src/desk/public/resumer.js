import { api, notice as writeNotice, downloadText, el } from '/common.js';
import { animateChange } from '/motion.js';

const $ = (id) => document.getElementById(id);
let checkpoints = [];
let currentArtifact = null;
let busy = false;
let inferenceConfigured = false;
let currentAnalysis = null;
let analysisSelectionId = null;
let watchSelectionId = null;
let workingButton = null;
let workingLabel = '';

const pendingLabels = {
  'save-checkpoint': 'Saving checkpoint…', resume: 'Comparing selected files…',
  refresh: 'Refreshing checkpoints…', 'try-example': 'Creating example…',
  'change-example': 'Changing example files…', 'enable-watch': 'Enabling local watch…',
  'disable-watch': 'Disabling local watch…', 'refresh-watch': 'Checking watch status…',
  'open-watch-artifact': 'Opening continuation…', analyze: 'Analyzing selected evidence…',
};

function notice(element, message, isError = false) {
  writeNotice(element, message, isError);
  if (message) animateChange(element, [
    { backgroundColor: isError ? '#f7dcd7' : '#dce2fa' },
    { backgroundColor: isError ? '#fff0ed' : '#f4f5fc' },
  ], { duration: 300 });
}

function paperChange(element) {
  animateChange(element, [
    { clipPath: 'inset(0 0 4% 0)', transform: 'translateY(6px)' },
    { clipPath: 'inset(0)', transform: 'translateY(0)' },
  ], { duration: 320 });
}

function focusJournal(id) {
  if (document.hidden) return;
  const heading = $(id);
  heading.focus({ preventScroll: true });
  const bounds = heading.getBoundingClientRect();
  if (bounds.top < 20 || bounds.bottom > window.innerHeight - 20) {
    heading.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}

function syncJournalPath() {
  const path = document.querySelector('.resumer-path');
  const state = currentArtifact && currentArtifact.checkpointId === selected()?.id ? 'continuation' : selected() ? 'checkpoint' : 'entry';
  path.dataset.state = state;
  for (const [index, step] of [...path.children].entries()) {
    const current = index === ({ entry: 0, checkpoint: 1, continuation: 2 })[state];
    step.dataset.current = String(current);
    if (current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
}

const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const date = (value) => new Date(value).toLocaleString();
const selected = () => checkpoints.find((checkpoint) => checkpoint.id === $('checkpoint-select').value);

function syncControls() {
  const checkpoint = selected();
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  $('checkpoint-select').disabled = busy || checkpoints.length === 0;
  $('resume').disabled = busy || !checkpoint;
  $('change-example').disabled = busy || !checkpoint?.synthetic;
  $('download').disabled = busy || !currentArtifact;
  $('analyze').disabled = busy || !checkpoint || !inferenceConfigured || !$('analysis-consent').checked || !document.querySelector('#analysis-files input:checked');
  $('download-analysis').disabled = busy || !currentAnalysis;
  $('analysis-consent').disabled = busy;
  for (const input of document.querySelectorAll('#analysis-selection input')) input.disabled = busy;
  $('enable-watch').disabled = busy || !checkpoint || checkpoint.watch?.enabled || !$('watch-consent').checked;
  $('disable-watch').disabled = busy || !checkpoint?.watch?.enabled;
  $('open-watch-artifact').disabled = busy || !checkpoint?.watch?.lastArtifactId;
  $('watch-consent').disabled = busy || !checkpoint || Boolean(checkpoint.watch?.enabled);
  $('watch-interval').disabled = busy || !checkpoint || Boolean(checkpoint.watch?.enabled);
  syncJournalPath();
  document.querySelector('main').setAttribute('aria-busy', String(busy));
}

async function work(action, trigger = document.activeElement) {
  if (busy) return;
  workingButton = trigger?.tagName === 'BUTTON' ? trigger : null;
  workingLabel = workingButton?.textContent ?? '';
  if (workingButton) {
    workingButton.textContent = pendingLabels[workingButton.id] ?? 'Opening saved evidence…';
    workingButton.setAttribute('aria-busy', 'true');
  }
  busy = true;
  syncControls();
  notice($('notice'), 'Working with local files…');
  try { await action(); } catch (error) {
    notice($('notice'), error.message || 'The request failed. Check your selection and try again.', true);
  } finally {
    busy = false;
    if (workingButton) {
      workingButton.textContent = workingLabel;
      workingButton.removeAttribute('aria-busy');
    }
    workingButton = null;
    syncControls();
  }
}

function contextSection(title, contents, fallback) {
  const container = el('section', { class: 'resumer-context-entry' }, [el('h3', {}, [title])]);
  if (Array.isArray(contents)) container.append(contents.length
    ? el('ul', {}, contents.map((value) => el('li', {}, [value])))
    : el('p', { class: 'muted' }, [fallback]));
  else container.append(el('p', {}, [contents]));
  return container;
}

function renderSelection() {
  const checkpoint = selected();
  if (watchSelectionId !== checkpoint?.id) {
    watchSelectionId = checkpoint?.id;
    $('watch-consent').checked = false;
    $('watch-interval').value = checkpoint?.watch?.intervalSeconds ?? 30;
  }
  const watch = checkpoint?.watch;
  $('watch-status').textContent = !checkpoint ? 'Select a checkpoint to configure a local watch.' : watch
    ? `${watch.enabled ? 'Enabled while the desk is running' : 'Disabled'} · ${watch.paths.length} selected files · every ${watch.intervalSeconds} seconds. Last checked: ${watch.lastCheckedAt ? date(watch.lastCheckedAt) : 'not yet'}. ${watch.lastArtifactAt ? `Latest continuation: ${date(watch.lastArtifactAt)}.` : 'No changed observation has produced a continuation yet.'}`
    : `No local watch configured. This checkpoint contains ${checkpoint.files.length} selected files.`;
  $('watch-error').hidden = !watch?.lastError;
  $('watch-error').textContent = watch?.lastError ? `${watch.lastError} Last error: ${date(watch.lastErrorAt)}.` : '';
  if (currentAnalysis && currentAnalysis.checkpointId !== checkpoint?.id) { currentAnalysis = null; $('analysis-result').hidden = true; }
  if (analysisSelectionId !== checkpoint?.id) {
    analysisSelectionId = checkpoint?.id;
    $('analysis-files').replaceChildren(...(checkpoint ? checkpoint.files.map((path) => el('label', {}, [el('input', { type: 'checkbox', value: path, name: 'analysis-file' }), ` ${path}`])) : [el('p', { class: 'muted' }, 'Select a checkpoint first.')]));
    for (const input of document.querySelectorAll('[name="analysis-context"]')) input.checked = false;
    $('analysis-consent').checked = false;
  }
  $('saved-analyses').replaceChildren(...(checkpoint?.analyses ?? []).map((analysis) => el('button', { type: 'button', class: 'button secondary', onclick: () => work(async () => {
    const response = await api('resumer', 'analysis', { analysisId: analysis.id });
    showAnalysis(response.analysis);
    notice($('notice'), 'Opened a saved model suggestion. Its cited observations have not been refreshed.');
  }) }, `Open cited plan from ${date(analysis.createdAt)}`)));
  if (currentArtifact && currentArtifact.checkpointId !== checkpoint?.id) {
    currentArtifact = null;
    $('result').hidden = true;
  }
  $('checkpoint-details').replaceChildren();
  $('artifact-list').replaceChildren();
  $('saved-artifacts').hidden = !checkpoint?.artifacts?.length;
  if (!checkpoint) {
    $('checkpoint-details').append(el('p', { class: 'muted' }, ['Save your goal and selected files to make a first checkpoint, or try the synthetic example.']));
    syncControls();
    return;
  }
  $('checkpoint-details').append(
    el('p', { class: 'resumer-entry-title' }, [el('strong', {}, [checkpoint.synthetic ? 'Synthetic example' : `Project: ${checkpoint.projectDirectory}`])]),
    el('p', { class: 'muted resumer-entry-time' }, [`Saved ${date(checkpoint.createdAt)} · ${checkpoint.files.length} selected files`]),
    contextSection('Saved goal', checkpoint.goal),
    contextSection('Starting action to recheck', checkpoint.nextAction),
  );
  const details = el('details', {}, [el('summary', {}, ['Selected files, decisions, and blockers'])]);
  details.append(
    contextSection('Selected files', checkpoint.files),
    contextSection('Saved decisions', checkpoint.decisions, 'No decisions recorded.'),
    contextSection('Blockers to revalidate', checkpoint.blockers.map((blocker) => `Unvalidated: ${blocker}`), 'No blockers recorded. This does not establish that the project is unblocked.'),
  );
  $('checkpoint-details').append(details);
  for (const artifact of checkpoint.artifacts ?? []) {
    const button = el('button', { type: 'button', class: 'button secondary' }, [`Open continuation from ${date(artifact.createdAt)}`]);
    button.addEventListener('click', () => work(async () => {
      const response = await api('resumer', 'artifact', { artifactId: artifact.id });
      showResult(response);
      notice($('notice'), 'Opened a previously saved continuation. Its observations have not been refreshed.');
    }));
    $('artifact-list').append(button);
  }
  paperChange($('checkpoint-details'));
  syncControls();
}

async function refresh(preferredId = $('checkpoint-select').value) {
  const response = await api('resumer', 'list');
  checkpoints = response.checkpoints;
  $('workspace-root').textContent = response.workspaceRoot;
  const options = checkpoints.map((checkpoint) => el('option', { value: checkpoint.id }, [
    `${checkpoint.synthetic ? 'Example' : checkpoint.projectDirectory} · ${date(checkpoint.createdAt)} · ${checkpoint.goal.slice(0, 90)}`,
  ]));
  $('checkpoint-select').replaceChildren(...(options.length ? options : [el('option', { value: '' }, ['No saved checkpoints'])]));
  if (checkpoints.some((checkpoint) => checkpoint.id === preferredId)) $('checkpoint-select').value = preferredId;
  renderSelection();
}

function showResult(response) {
  currentArtifact = response.artifact;
  $('result').hidden = false;
  $('result-title').textContent = 'Continuation prepared';
  const count = (status) => response.comparisons.filter((file) => file.status === status).length;
  $('result-summary').textContent = `${count('changed')} changed · ${count('deleted')} deleted · ${count('unchanged')} unchanged. Observed ${date(response.artifact.createdAt)}.`;
  $('result-source').textContent = `${response.checkpoint.synthetic ? 'Synthetic example' : `Project: ${response.checkpoint.projectDirectory}`} · Checkpoint saved ${date(response.checkpoint.createdAt)}.`;
  $('comparison-body').replaceChildren(...response.comparisons.map((file) => el('tr', { 'data-status': file.status }, [
    el('td', {}, [el('code', {}, [file.path])]), el('td', {}, [el('span', { class: 'resumer-observation', 'data-status': file.status }, [file.status])]),
  ])));
  $('artifact-preview').textContent = response.artifact.markdown;
  syncJournalPath();
  paperChange($('result'));
  for (const [index, row] of [...$('comparison-body').children].entries()) {
    if (row.dataset.status === 'unchanged') continue;
    animateChange(row, [
      { backgroundColor: row.dataset.status === 'deleted' ? '#f1dcd8' : '#eee3b9' },
      { backgroundColor: row.dataset.status === 'deleted' ? '#fdf7f5' : '#fcfbf3' },
    ], { duration: 420, delay: Math.min(index * 30, 120) });
  }
  animateChange(document.querySelector('.resumer-document-receipt path'), [
    { strokeDashoffset: 24 }, { strokeDashoffset: 0 },
  ], { duration: 280 });
  focusJournal('result-title');
}

$('checkpoint-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  work(async () => {
    const response = await api('resumer', 'checkpoint', {
      projectDirectory: values.get('projectDirectory').trim(),
      files: lines(values.get('files')),
      goal: values.get('goal').trim(),
      nextAction: values.get('nextAction').trim(),
      decisions: lines(values.get('decisions')),
      blockers: lines(values.get('blockers')),
    });
    await refresh(response.checkpoint.id);
    notice($('notice'), `Checkpoint saved with ${response.checkpoint.files.length} selected files. Compare it whenever you return.`);
    focusJournal('saved-title');
  }, $('save-checkpoint'));
});
$('checkpoint-select').addEventListener('change', renderSelection);
$('refresh').addEventListener('click', () => work(async () => { await refresh(); notice($('notice'), 'Saved checkpoints refreshed.'); }));
$('resume').addEventListener('click', () => work(async () => {
  const checkpointId = selected().id;
  const response = await api('resumer', 'resume', { checkpointId });
  await refresh(checkpointId);
  showResult(response);
  notice($('notice'), 'Continuation saved. Review the literal changes and revalidate your starting action and blockers.');
}));
$('try-example').addEventListener('click', () => work(async () => {
  const response = await api('resumer', 'demo', { operation: 'create' });
  await refresh(response.checkpoint.id);
  notice($('notice'), 'Synthetic checkpoint saved. Choose “Change example files”, then compare to see a changed plan and a deleted handoff.');
  focusJournal('saved-title');
}));
$('change-example').addEventListener('click', () => work(async () => {
  const response = await api('resumer', 'demo', { operation: 'change', checkpointId: selected().id });
  await refresh(response.checkpoint.id);
  notice($('notice'), 'Synthetic plan changed and handoff file deleted. Compare this checkpoint to inspect the evidence.');
}));
$('download').addEventListener('click', () => {
  if (currentArtifact) {
    downloadText(currentArtifact.name, currentArtifact.markdown, 'text/markdown;charset=utf-8');
    notice($('notice'), 'Markdown download prepared from this saved continuation.');
    animateChange($('download'), [{ backgroundColor: '#5c66ae' }, { backgroundColor: '#373f8e' }], { duration: 240 });
  }
});

$('watch-consent').addEventListener('change', syncControls);
$('watch-interval').addEventListener('input', () => { $('watch-consent').checked = false; syncControls(); });
$('enable-watch').addEventListener('click', () => {
  if (!$('watch-consent').checked || !selected()) return;
  const checkpointId = selected().id;
  const intervalSeconds = Number($('watch-interval').value);
  work(async () => {
    try {
      await api('resumer', 'watch', { checkpointId, enabled: true, intervalSeconds, consent: true });
      await refresh(checkpointId);
      notice($('notice'), 'Local watch enabled. It will prepare a continuation for changed selected files while the desk server runs.');
    } finally { $('watch-consent').checked = false; }
  });
});
$('disable-watch').addEventListener('click', () => work(async () => {
  const checkpointId = selected().id;
  await api('resumer', 'watch', { checkpointId, enabled: false, consent: true });
  await refresh(checkpointId);
  notice($('notice'), 'Local watch disabled. Previously prepared continuations remain available.');
}));
$('refresh-watch').addEventListener('click', () => work(async () => { await refresh(); notice($('notice'), 'Local watch status refreshed.'); }));
$('open-watch-artifact').addEventListener('click', () => work(async () => {
  const response = await api('resumer', 'artifact', { artifactId: selected().watch.lastArtifactId });
  showResult(response);
  notice($('notice'), 'Opened the saved local watch continuation. No saved action was executed.');
}));

function showAnalysis(analysis) {
  currentAnalysis = analysis;
  $('analysis-result').hidden = false;
  $('analysis-receipt').textContent = `${analysis.inference.provider} / ${analysis.inference.model} · ${analysis.inference.liveInferenceVerified ? 'Live inference response recorded' : 'Live inference not verified; fixture or unverified transport'} · Evidence observed ${date(analysis.observedAt)}.`;
  $('analysis-markdown').textContent = analysis.markdown;
  const statement = (entry) => el('div', { class: 'stack' }, [el('p', {}, entry.text), ...entry.citations.map((citation) => {
    const evidence = analysis.evidence.find((entry) => entry.id === citation.evidenceId);
    return el('blockquote', {}, `${citation.quote} — ${evidence.path ?? evidence.field}${evidence.side ? ` (${evidence.side})` : ''}${evidence.startLine ? `, lines ${evidence.startLine}–${evidence.endLine}` : ''}${evidence.truncated ? '; excerpt is bounded' : ''}`);
  })]);
  $('analysis-plan').replaceChildren(statement(analysis.plan.summary), el('h3', {}, 'Suggested actions to review'), ...analysis.plan.actions.map(statement), el('h3', {}, 'Questions to revalidate'), ...analysis.plan.questions.map(statement), el('p', { class: 'muted' }, 'Citation text matches the selected evidence. That does not verify the model’s interpretation. No action was executed and no blocker was validated.'));
  paperChange($('analysis-result'));
  focusJournal('analysis-result-title');
}
$('analysis-selection').addEventListener('change', () => { $('analysis-consent').checked = false; syncControls(); });
$('analysis-consent').addEventListener('change', syncControls);
$('analyze').addEventListener('click', () => {
  if (!$('analysis-consent').checked || !inferenceConfigured) return;
  const checkpointId = selected()?.id;
  const selectedPaths = [...document.querySelectorAll('#analysis-files input:checked')].map((input) => input.value);
  const contextFields = [...document.querySelectorAll('[name="analysis-context"]:checked')].map((input) => input.value);
  work(async () => {
    notice($('notice'), 'Sending only the selected excerpts and saved context for a cited suggestion…');
    try {
      const response = await api('resumer', 'analyze', { checkpointId, selectedPaths, contextFields, consent: true });
      await refresh(checkpointId);
      showAnalysis(response.analysis);
      notice($('notice'), 'Cited suggestion saved. Review the proposed actions and questions against their evidence.');
    } finally { $('analysis-consent').checked = false; }
  });
});
$('download-analysis').addEventListener('click', () => { if (currentAnalysis) downloadText(`resume-plan-${currentAnalysis.id}.md`, currentAnalysis.markdown, 'text/markdown;charset=utf-8'); });

work(async () => {
  await Promise.all([refresh(), api('inference', 'status').then((status) => {
    inferenceConfigured = status.configured;
    $('resumer-provider').textContent = status.configured ? `Destination: ${status.provider} · ${status.endpoint}. Model: ${status.model ?? 'NVIDIA Nemotron, selected when you request inference'}.` : 'Nemotron inference is not configured. Local comparison remains available.';
  }).catch(() => { $('resumer-provider').textContent = 'Inference destination is unavailable. Reload before sending any content.'; })]);
  $('notice').hidden = true;
});
