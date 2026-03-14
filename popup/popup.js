// popup.js — Extension popup UI

(async function () {
  const stateNoVideo = document.getElementById('state-no-video');
  const stateVideo = document.getElementById('state-video');
  const elTitle = document.getElementById('video-title');
  const elTotalWatched = document.getElementById('total-watched');
  const elSegmentCount = document.getElementById('segment-count');
  const elSegmentsList = document.getElementById('segments-list');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnClear = document.getElementById('btn-clear');
  const btnLibrary = document.getElementById('btn-library');

  btnLibrary.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('library/index.html') });
  });

  // ─── Get current YouTube tab ──────────────────────────────────────

  async function getCurrentVideoId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    try {
      const url = new URL(tab.url);
      if (!url.hostname.includes('youtube.com')) return null;
      return url.searchParams.get('v');
    } catch {
      return null;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  function render(session) {
    if (!session) {
      stateNoVideo.classList.remove('hidden');
      stateVideo.classList.add('hidden');
      return;
    }

    stateNoVideo.classList.add('hidden');
    stateVideo.classList.remove('hidden');

    elTitle.textContent = session.title || 'Untitled Video';
    elTotalWatched.textContent = formatDuration(session.totalWatched || 0);
    elSegmentCount.textContent = session.segments?.length || 0;

    renderSegments(session.segments || []);
  }

  function renderSegments(segments) {
    if (segments.length === 0) {
      elSegmentsList.innerHTML = '<div class="no-segments">No segments tracked yet.<br>Press play to begin.</div>';
      return;
    }

    elSegmentsList.innerHTML = segments.map((seg) => {
      const dur = seg.end - seg.start;
      return `
        <div class="segment-item">
          <div class="segment-dot"></div>
          <span class="segment-time">${formatTimestamp(seg.start)} – ${formatTimestamp(seg.end)}</span>
          <span class="segment-duration">${formatDuration(dur)}</span>
        </div>
      `;
    }).join('');
  }

  // ─── Format helpers ───────────────────────────────────────────────

  function formatTimestamp(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0) {
      return `${h}:${pad(m)}:${pad(sec)}`;
    }
    return `${m}:${pad(sec)}`;
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // ─── Load & actions ───────────────────────────────────────────────

  let currentVideoId = null;

  async function load() {
    currentVideoId = await getCurrentVideoId();
    if (!currentVideoId) {
      render(null);
      return;
    }

    const session = await chrome.runtime.sendMessage({
      type: 'GET_SESSION',
      videoId: currentVideoId,
    });

    render(session);
  }

  btnRefresh.addEventListener('click', load);

  btnClear.addEventListener('click', async () => {
    if (!currentVideoId) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', videoId: currentVideoId });
    render(null);
    // Re-show the video state with empty data after a tick
    setTimeout(load, 100);
  });

  // Auto-refresh every 3 seconds while popup is open
  const refreshInterval = setInterval(load, 3000);
  window.addEventListener('unload', () => clearInterval(refreshInterval));

  // Initial load
  await load();
})();
