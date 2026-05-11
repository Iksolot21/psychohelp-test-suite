'use strict';

const finalStatuses = new Set(['passed', 'completed_with_failures', 'error', 'cancelled']);

const state = {
  modes: [],
  defaults: {},
  currentJob: null,
  reports: [],
  selectedReport: null,
  reportFilter: 'all',
  eventSource: null,
  eventJobId: null,
  toastTimer: null,
};

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  init().catch((error) => showToast(error.message || 'Ошибка инициализации'));
});

async function init() {
  await loadConfig();
  await loadCurrentJob();
  await loadReports();
  setInterval(() => {
    loadCurrentJob(true).catch(() => {});
    loadReports(true).catch(() => {});
  }, 5000);
}

function bindEvents() {
  $('runForm').addEventListener('submit', runTests);
  $('stopBtn').addEventListener('click', stopCurrentJob);
  $('refreshReports').addEventListener('click', () => loadReports(false));
  $('modeSelect').addEventListener('change', renderModeDescription);

  $('quiet').addEventListener('change', () => {
    if ($('quiet').checked) $('verbose').checked = false;
  });
  $('verbose').addEventListener('change', () => {
    if ($('verbose').checked) $('quiet').checked = false;
  });

  document.querySelector('.segments').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.reportFilter = button.dataset.status;
    for (const item of document.querySelectorAll('.segment')) item.classList.remove('active');
    button.classList.add('active');
    renderReportRows();
  });

  $('reportSearch').addEventListener('input', renderReportRows);
  $('reportsBody').addEventListener('click', handleReportAction);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json; charset=utf-8', ...(options.headers || {}) } : options.headers,
    ...options,
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = data && data.error ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function loadConfig() {
  const config = await api('/api/config');
  state.modes = config.modes;
  state.defaults = config.defaults;

  $('serverBase').textContent = config.defaults.baseUrl;
  $('serverNode').textContent = `Dashboard ${config.defaults.host}:${config.defaults.port}`;
  $('baseUrl').value = config.defaults.baseUrl;
  $('slowMs').value = config.defaults.slowMs;

  $('modeSelect').innerHTML = state.modes
    .map((mode) => `<option value="${escapeHtml(mode.id)}">${escapeHtml(mode.label)} (${escapeHtml(mode.flag)})</option>`)
    .join('');
  renderModeDescription();

  if (config.currentJob) {
    state.currentJob = config.currentJob;
    connectJobEvents(config.currentJob.id);
  }
}

async function loadCurrentJob(silent) {
  const data = await api('/api/jobs/current');
  if (data.job) {
    const hadDifferentJob = !state.currentJob || state.currentJob.id !== data.job.id;
    state.currentJob = data.job;
    if (hadDifferentJob) {
      renderLog(data.job.logs || []);
      connectJobEvents(data.job.id);
    }
  } else if (state.currentJob && finalStatuses.has(state.currentJob.status)) {
    disconnectEvents();
  } else if (!state.currentJob) {
    disconnectEvents();
  }
  renderJob();
  if (!silent && data.job && data.job.logs) renderLog(data.job.logs);
}

async function runTests(event) {
  event.preventDefault();
  const body = {
    mode: $('modeSelect').value,
    baseUrl: $('baseUrl').value,
    slowMs: Number($('slowMs').value),
    adminEmail: $('adminEmail').value,
    adminPassword: $('adminPassword').value,
    quiet: $('quiet').checked,
    verbose: $('verbose').checked,
  };

  try {
    $('runBtn').disabled = true;
    const job = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.currentJob = job;
    renderLog([]);
    renderJob();
    connectJobEvents(job.id);
    showToast('Запуск начат');
  } catch (error) {
    showToast(error.message);
  } finally {
    renderJob();
  }
}

async function stopCurrentJob() {
  if (!state.currentJob || !state.currentJob.id) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.currentJob.id)}`, { method: 'DELETE' });
    showToast('Остановка отправлена');
  } catch (error) {
    showToast(error.message);
  }
}

function connectJobEvents(jobId) {
  if (!jobId || state.eventJobId === jobId) return;
  disconnectEvents();
  state.eventJobId = jobId;
  state.eventSource = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);

  state.eventSource.addEventListener('log', (event) => {
    appendLog(JSON.parse(event.data));
  });

  state.eventSource.addEventListener('status', async (event) => {
    state.currentJob = JSON.parse(event.data);
    renderJob();
    if (finalStatuses.has(state.currentJob.status)) {
      disconnectEvents();
      await loadReports(true);
      if (state.currentJob.reports && state.currentJob.reports.length) {
        openReport(state.currentJob.reports[0].id).catch(() => {});
      }
    }
  });

  state.eventSource.onerror = () => {
    if (state.currentJob && finalStatuses.has(state.currentJob.status)) disconnectEvents();
  };
}

function disconnectEvents() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  state.eventJobId = null;
}

function appendLog(entry) {
  const pre = $('logOutput');
  const prefix = entry.stream === 'stderr' ? '[stderr] ' : entry.stream === 'system' ? '[system] ' : '';
  pre.textContent += prefix + entry.text;
  if (pre.textContent.length > 250000) {
    pre.textContent = pre.textContent.slice(-220000);
  }
  pre.scrollTop = pre.scrollHeight;
}

function renderLog(entries) {
  $('logOutput').textContent = '';
  for (const entry of entries || []) appendLog(entry);
}

function renderJob() {
  const job = state.currentJob;
  const status = $('jobStatus');
  if (!job) {
    $('jobSubtitle').textContent = 'Нет активного запуска';
    status.className = 'status idle';
    status.textContent = 'Ожидание';
    $('stopBtn').disabled = true;
    $('runBtn').disabled = false;
    renderMetrics('jobMetrics', null);
    return;
  }

  const label = statusLabel(job.status);
  status.className = `status ${job.status}`;
  status.textContent = label;
  $('jobSubtitle').textContent = `${job.mode.toUpperCase()} · ${formatDuration(job.durationMs)} · ${job.config.baseUrl}`;
  $('stopBtn').disabled = finalStatuses.has(job.status);
  $('runBtn').disabled = !finalStatuses.has(job.status);
  renderMetrics('jobMetrics', job.result);
}

function statusLabel(status) {
  return {
    running: 'Выполняется',
    passed: 'Пройдено',
    completed_with_failures: 'Есть падения',
    error: 'Ошибка',
    cancelled: 'Остановлен',
  }[status] || 'Ожидание';
}

function renderMetrics(containerId, summary) {
  const value = summary || { total: 0, pass: 0, fail: 0, warn: 0 };
  $(containerId).innerHTML = [
    `<span class="metric neutral">Всего: ${number(value.total)}</span>`,
    `<span class="metric pass">Pass: ${number(value.pass)}</span>`,
    `<span class="metric fail">Fail: ${number(value.fail)}</span>`,
    `<span class="metric warn">Warn: ${number(value.warn)}</span>`,
  ].join('');
}

function renderModeDescription() {
  const mode = state.modes.find((item) => item.id === $('modeSelect').value);
  if (!mode) return;
  $('modeDescription').textContent = `${mode.duration} · ${mode.description}`;
  $('adminDetails').open = mode.id === 'admin';
}

async function loadReports(silent) {
  const data = await api('/api/reports');
  state.reports = data.reports;
  renderReports();
  if (!silent) showToast('Список отчетов обновлен');
}

function renderReports() {
  $('reportsSubtitle').textContent = `${state.reports.length} ${declineReport(state.reports.length)}`;
  if (!state.reports.length) {
    $('reportsBody').innerHTML = '<tr><td colspan="5" class="empty-cell">Отчетов пока нет</td></tr>';
    return;
  }

  $('reportsBody').innerHTML = state.reports.map((report) => `
    <tr>
      <td>
        <div class="file-name">${escapeHtml(report.title)}</div>
        <div class="file-path">${escapeHtml(report.relativePath)}</div>
      </td>
      <td>${summaryHtml(report.summary)}</td>
      <td>${escapeHtml(formatDate(report.modifiedAt))}</td>
      <td>${escapeHtml(report.sizeLabel)}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="open" data-id="${escapeHtml(report.id)}">Открыть</button>
          <a class="link-button secondary" href="/api/reports/${encodeURIComponent(report.id)}/download">Скачать</a>
          <button class="danger" type="button" data-action="delete" data-id="${escapeHtml(report.id)}">Удалить</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function handleReportAction(event) {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const id = control.dataset.id;
  if (control.dataset.action === 'open') {
    await openReport(id);
  }
  if (control.dataset.action === 'delete') {
    const ok = window.confirm('Удалить выбранный отчет?');
    if (!ok) return;
    await api(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.selectedReport && state.selectedReport.id === id) {
      state.selectedReport = null;
      renderSelectedReport();
    }
    await loadReports(true);
    showToast('Отчет удален');
  }
}

async function openReport(id) {
  const report = await api(`/api/reports/${encodeURIComponent(id)}`);
  state.selectedReport = report;
  renderSelectedReport();
}

function renderSelectedReport() {
  const report = state.selectedReport;
  if (!report) {
    $('reportTitle').textContent = 'Анализ отчета';
    $('reportSubtitle').textContent = 'Выберите отчет из истории';
    $('downloadReport').href = '#';
    $('downloadReport').classList.add('disabled');
    $('downloadReport').setAttribute('aria-disabled', 'true');
    $('rawReport').textContent = '';
    $('issuesList').innerHTML = '';
    renderMetrics('reportSummary', null);
    $('checksBody').innerHTML = '<tr><td colspan="7" class="empty-cell">Нет данных</td></tr>';
    return;
  }

  $('reportTitle').textContent = report.title;
  $('reportSubtitle').textContent = `${report.relativePath} · ${formatDate(report.modifiedAt)}`;
  $('downloadReport').href = `/api/reports/${encodeURIComponent(report.id)}/download`;
  $('downloadReport').classList.remove('disabled');
  $('downloadReport').removeAttribute('aria-disabled');
  $('rawReport').textContent = report.content || '';
  renderMetrics('reportSummary', report.summary);
  renderIssues();
  renderReportRows();
}

function renderIssues() {
  const report = state.selectedReport;
  if (!report || !report.rows.length) {
    $('issuesList').innerHTML = '';
    return;
  }
  const issues = report.rows.filter((row) => row.status === 'fail' || row.status === 'warn').slice(0, 8);
  if (!issues.length) {
    $('issuesList').innerHTML = '<div class="issue-item"><div class="issue-title">Падений и предупреждений нет</div></div>';
    return;
  }
  $('issuesList').innerHTML = issues.map((row) => `
    <div class="issue-item ${escapeHtml(row.status)}">
      <div class="issue-title">${escapeHtml(row.method)} ${escapeHtml(row.endpoint)}</div>
      <div class="issue-meta">${escapeHtml(row.expected)} → ${escapeHtml(row.actual)}${row.details ? ` · ${escapeHtml(row.details)}` : ''}</div>
    </div>
  `).join('');
}

function renderReportRows() {
  const report = state.selectedReport;
  if (!report) return;
  const query = $('reportSearch').value.trim().toLowerCase();
  const rows = report.rows.filter((row) => {
    const statusOk = state.reportFilter === 'all' || row.status === state.reportFilter;
    const text = `${row.method} ${row.endpoint} ${row.expected} ${row.actual} ${row.details}`.toLowerCase();
    return statusOk && (!query || text.includes(query));
  });

  if (!rows.length) {
    $('checksBody').innerHTML = '<tr><td colspan="7" class="empty-cell">Строки не найдены</td></tr>';
    return;
  }

  $('checksBody').innerHTML = rows.map((row) => `
    <tr>
      <td>${number(row.index)}</td>
      <td><span class="result-pill ${escapeHtml(row.status)}">${escapeHtml(statusShort(row.status))}</span></td>
      <td>${escapeHtml(row.method)}</td>
      <td>${escapeHtml(row.endpoint)}</td>
      <td>${escapeHtml(row.expected)}</td>
      <td>${escapeHtml(row.actual)}</td>
      <td>${escapeHtml(row.details)}</td>
    </tr>
  `).join('');
}

function summaryHtml(summary) {
  const value = summary || { pass: 0, fail: 0, warn: 0, total: 0 };
  return `
    <div class="metrics">
      <span class="metric neutral">${number(value.total)}</span>
      <span class="metric pass">${number(value.pass)}</span>
      <span class="metric fail">${number(value.fail)}</span>
      <span class="metric warn">${number(value.warn)}</span>
    </div>
  `;
}

function statusShort(status) {
  return {
    pass: 'PASS',
    fail: 'FAIL',
    warn: 'WARN',
    unknown: 'WARN',
  }[status] || 'WARN';
}

function number(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '0 сек';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} мин ${rest} сек`;
}

function declineReport(count) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'отчетов';
  if (n1 > 1 && n1 < 5) return 'отчета';
  if (n1 === 1) return 'отчет';
  return 'отчетов';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
