const CAPTURE_URL = 'http://localhost:7432/capture';
const STATUS_URL  = 'http://localhost:7432/status';

const SOURCE_LABELS = {
  linkedin:     'LinkedIn',
  greenhouse:   'Greenhouse',
  lever:        'Lever',
  ashby:        'Ashby',
  workday:      'Workday',
  workable:     'Workable',
  company_site: 'Company site',
};

async function checkServer() {
  try {
    const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type; // 'success' | 'error' | ''
  if (!type) el.style.display = 'none';
}

function setBadge(source) {
  const container = document.getElementById('source-badge-container');
  if (!source) { container.innerHTML = ''; return; }
  const label = SOURCE_LABELS[source] ?? source;
  container.innerHTML = `<span class="source-badge source-${source}">${label}</span>`;
  document.getElementById('header-source').textContent = label;
}

function populate(data) {
  if (data?.company) document.getElementById('company').value   = data.company;
  if (data?.role)    document.getElementById('role').value      = data.role;
  if (data?.location) document.getElementById('location').value = data.location;
  if (data?.source) {
    const sel = document.getElementById('source');
    if ([...sel.options].some(o => o.value === data.source)) sel.value = data.source;
    setBadge(data.source);
  }
}

async function init() {
  // Check if capture server is running
  const serverUp = await checkServer();
  if (!serverUp) {
    setStatus('Capture server not running. Start it with: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.matthewfitzgerald.job-capture.plist', 'error');
  }

  // Request job details from content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { showNotJobPage(); return; }

    chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DETAILS' }, (data) => {
      if (chrome.runtime.lastError || !data || data.error) {
        // Content script not injected on this page type — show empty form
        document.getElementById('not-job-page').style.display = 'block';
        document.getElementById('main-content').style.display = 'none';
        return;
      }
      populate(data);
      // Pre-fill job_url hidden
      document.getElementById('capture-btn').dataset.jobUrl = data.job_url ?? tab.url;
    });
  } catch (e) {
    console.error(e);
  }

  // Capture button
  document.getElementById('capture-btn').addEventListener('click', async () => {
    const btn     = document.getElementById('capture-btn');
    const company = document.getElementById('company').value.trim();
    const role    = document.getElementById('role').value.trim();

    if (!company) { setStatus('Company name is required', 'error'); return; }

    btn.classList.add('loading');
    btn.disabled = true;
    setStatus('', '');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const payload = {
        company,
        role:     role || undefined,
        location: document.getElementById('location').value.trim() || undefined,
        notes:    document.getElementById('notes').value.trim()    || undefined,
        status:   document.getElementById('status').value,
        source:   document.getElementById('source').value,
        job_url:  btn.dataset.jobUrl ?? tab?.url,
      };

      const res = await fetch(CAPTURE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000),
      });

      const json = await res.json();
      if (json.ok) {
        setStatus(`Saved: ${json.company}`, 'success');
        setTimeout(() => window.close(), 1200);
      } else {
        setStatus(json.error ?? 'Save failed', 'error');
      }
    } catch (e) {
      setStatus(`Could not reach capture server: ${e.message}`, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

init();
