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
    document.getElementById('company').textContent  = data.company  || '—';
    document.getElementById('role').textContent     = data.role     || '—';

    const loc = document.getElementById('location');
    if (data.location) {
      loc.textContent = data.location;
    } else {
      document.getElementById('loc-row').style.display = 'none';
    }

    const tag = document.getElementById('source-tag');
    tag.textContent = SOURCE_LABELS[data.source] ?? data.source ?? 'Unknown';

    document.getElementById('btn').addEventListener('click', async () => {
      const btn = document.getElementById('btn');
      const msg = document.getElementById('msg');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_NOW' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          msg.textContent = 'Capture server not running — start it in Terminal.';
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
