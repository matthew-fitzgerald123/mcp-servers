const SOURCE_LABELS = {
  linkedin: 'LinkedIn', greenhouse: 'Greenhouse', lever: 'Lever',
  ashby: 'Ashby', workday: 'Workday', workable: 'Workable',
  smartrecruiters: 'SmartRecruiters', company_site: 'Company site',
};

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { showNotJob(); return; }

  chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DETAILS' }, (data) => {
    if (chrome.runtime.lastError || !data || (!data.company && !data.role)) {
      showNotJob(); return;
    }

    document.getElementById('main').style.display = 'block';
    document.getElementById('company').textContent = data.company || '—';
    document.getElementById('role').textContent    = data.role    || '—';

    if (data.location) {
      document.getElementById('location').textContent = data.location;
    } else {
      document.getElementById('loc-row').style.display = 'none';
    }

    document.getElementById('source-tag').textContent =
      SOURCE_LABELS[data.source] ?? data.source ?? 'Unknown';

    document.getElementById('btn').addEventListener('click', () => {
      const btn = document.getElementById('btn');
      const msg = document.getElementById('msg');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      // Route through background service worker to reach localhost
      chrome.runtime.sendMessage({
        type: 'CAPTURE',
        payload: {
          company:  data.company,
          role:     data.role,
          location: data.location,
          job_url:  data.job_url ?? tab.url,
          source:   data.source ?? 'company_site',
          status:   'applied',
        },
      }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          msg.textContent = 'Capture server not running.';
          msg.className = 'err';
          btn.disabled = false;
          btn.textContent = 'Capture Application';
        } else {
          btn.textContent = 'Saved!';
          setTimeout(() => window.close(), 900);
        }
      });
    });
  });
}

function showNotJob() {
  document.getElementById('not-a-job').style.display = 'block';
}

init();
