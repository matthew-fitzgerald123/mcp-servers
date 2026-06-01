// Background service worker — proxies fetch requests to localhost
// so content scripts don't get blocked by Safari's content security policy.

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'CAPTURE') {
    fetch('http://localhost:7432/capture', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(msg.payload),
    })
      .then(r => r.json())
      .then(data => reply(data))
      .catch(e  => reply({ ok: false, error: e.message }));
    return true; // keep channel open for async reply
  }

  if (msg.type === 'STATUS') {
    fetch('http://localhost:7432/status', { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(data => reply(data))
      .catch(() => reply({ ok: false }));
    return true;
  }
});
