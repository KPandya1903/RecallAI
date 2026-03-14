// content_script.js — YouTube Memory Engine

(function () {
  // ─── Extension context guard ──────────────────────────────────────
  // After an extension reload, chrome.runtime becomes invalid. Guard every call.
  function ctxOk() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  function sendMsg(msg, cb) {
    if (!ctxOk()) return;
    try {
      chrome.runtime.sendMessage(msg, (...args) => {
        void chrome.runtime.lastError;
        cb?.(...args);
      });
    } catch (_) {}
  }

  // ─── State ────────────────────────────────────────────────────────
  let trackingEnabled = false;  // global on/off — user must click Start Tracking
  let videoId = null;
  let title = null;
  let video = null;
  let segmentStart = null;
  let isRecording = false;      // currently inside a play segment
  let boundListeners = false;
  let liveTimer = null;
  let inactivityTimer = null;

  // ─── Live Caption State ───────────────────────────────────────────
  let captionObserver = null;
  let liveTranscript = '';      // accumulated caption text for current video
  let lastCaptionText = '';     // dedup: skip if same as previous chunk

  // ─── Boot ─────────────────────────────────────────────────────────

  // Restore tracking state from session storage (survives page navigation)
  if (ctxOk()) {
    chrome.storage.session.get('trackingEnabled', (data) => {
      void chrome.runtime.lastError;
      trackingEnabled = !!data.trackingEnabled;
      boot();
    });
  } else {
    boot();
  }

  function boot() {
    injectUI();
    updateButton();
    tryAttachVideo();
  }

  // Fallback injection
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.getElementById('yme-root')) boot();
    });
  }
  setTimeout(() => { if (!document.getElementById('yme-root')) boot(); }, 2000);

  // ─── YouTube SPA navigation ────────────────────────────────────────
  window.addEventListener('yt-navigate-finish', () => {
    const newId = getVideoId();

    if (videoId && newId !== videoId) {
      // Leaving a video — save it
      finalizeCurrentVideo();
    }

    // Small delay so new page DOM settles
    setTimeout(() => {
      tryAttachVideo();
    }, 500);
  });

  // ─── Video attachment ──────────────────────────────────────────────

  function tryAttachVideo() {
    const newId = getVideoId();

    // Not on a watch page
    if (!newId) {
      videoId = null;
      title = null;
      detachListeners();
      video = null;
      return;
    }

    // Already attached to this video
    if (newId === videoId && boundListeners) return;

    videoId = newId;
    title = null;
    isRecording = false;
    segmentStart = null;
    resetTranscript();

    waitForVideo().then((vid) => {
      video = vid;
      detachListeners();
      attachListeners();
      startCaptionObserver();

      // If tracking is on and video is already playing (autoplay), start a segment
      if (trackingEnabled && !video.paused) {
        segmentStart = video.currentTime;
        isRecording = true;
        startLiveTimer();
      }

      // Load related memories after a short delay (let page data settle)
      setTimeout(loadRelatedMemories, 1500);
    });
  }

  function waitForVideo() {
    return new Promise((resolve) => {
      const el = document.querySelector('video');
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = document.querySelector('video');
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ─── Player listeners ──────────────────────────────────────────────

  function attachListeners() {
    if (boundListeners) return;
    boundListeners = true;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);
  }

  function detachListeners() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('seeking', onSeeking);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('ended', onEnded);
    boundListeners = false;
  }

  function onPlay() {
    if (!trackingEnabled) return;
    stopInactivityTimer();
    segmentStart = video.currentTime;
    isRecording = true;
    startLiveTimer();
  }

  function onPause() {
    if (!trackingEnabled || !isRecording) return;
    flushSegment(video.currentTime);
    stopLiveTimer();
    startInactivityTimer();
    refreshLivePanel();
  }

  function onSeeking() {
    if (!trackingEnabled || !isRecording) return;
    flushSegment(video.currentTime);
    isRecording = false;
    stopLiveTimer();
  }

  function onSeeked() {
    if (!trackingEnabled || !video || video.paused) return;
    segmentStart = video.currentTime;
    isRecording = true;
    startLiveTimer();
  }

  function onEnded() {
    if (!trackingEnabled || !isRecording) return;
    flushSegment(video.currentTime);
    stopLiveTimer();
    finalizeCurrentVideo();
  }

  // ─── Segment management ────────────────────────────────────────────

  function flushSegment(endTime) {
    if (segmentStart === null) return;
    const start = segmentStart;
    const end = endTime;
    segmentStart = null;
    isRecording = false;
    if (end - start < 2) return;
    sendMsg({
      type: 'SEGMENT_UPDATE',
      videoId,
      title: getTitle(),
      segment: { start: parseFloat(start.toFixed(2)), end: parseFloat(end.toFixed(2)) },
      duration: video ? parseFloat((video.duration || 0).toFixed(2)) : 0,
    });
  }

  async function finalizeCurrentVideo() {
    if (isRecording && video) flushSegment(video.currentTime);
    stopLiveTimer();
    stopInactivityTimer();
    stopCaptionObserver();
    isRecording = false;
    segmentStart = null;

    if (!videoId) return;

    // Use the live transcript we accumulated via DOM observation
    const transcript = liveTranscript.trim() || null;
    console.log('[YME] Finalizing with live transcript length:', transcript?.length ?? 0);

    sendMsg({
      type: 'FINALIZE_SESSION',
      videoId,
      title: getTitle(),
      category: getCategory(),
      channelName: getChannelName(),
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      transcript,
    });

    resetTranscript();
  }

  // ─── Inactivity timer ─────────────────────────────────────────────

  function startInactivityTimer() {
    stopInactivityTimer();
    inactivityTimer = setTimeout(() => {
      finalizeCurrentVideo();
    }, 30000);
  }

  function stopInactivityTimer() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  }

  // ─── Live segment timer ────────────────────────────────────────────

  function startLiveTimer() {
    stopLiveTimer();
    liveTimer = setInterval(() => {
      const el = document.getElementById('yme-live-val');
      if (!el || !isRecording || segmentStart === null || !video) return;
      el.textContent = '+' + formatDuration(video.currentTime - segmentStart);
    }, 500);
  }

  function stopLiveTimer() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    const el = document.getElementById('yme-live-val');
    if (el) el.textContent = '—';
  }

  // ─── Tracking toggle ───────────────────────────────────────────────

  function startTracking() {
    trackingEnabled = true;
    if (ctxOk()) chrome.storage.session.set({ trackingEnabled: true }, () => { void chrome.runtime.lastError; });
    updateButton();

    // If already on a video that's playing, start a segment now
    if (video && !video.paused) {
      segmentStart = video.currentTime;
      isRecording = true;
      startLiveTimer();
    }
  }

  function giveAnalysis() {
    // Stop tracking
    trackingEnabled = false;
    if (ctxOk()) chrome.storage.session.set({ trackingEnabled: false }, () => { void chrome.runtime.lastError; });

    finalizeCurrentVideo();
    updateButton();
    openAnalysisPanel();
  }

  // ─── Button ────────────────────────────────────────────────────────

  function onButtonClick() {
    if (!trackingEnabled) {
      startTracking();
    }
    // While tracking: button does nothing — user uses "Give Analysis" instead
  }

  // ─── UI Injection ──────────────────────────────────────────────────

  function injectUI() {
    if (document.getElementById('yme-root')) return;

    const root = document.createElement('div');
    root.id = 'yme-root';
    root.style.cssText = `
      position:fixed !important;bottom:24px !important;right:24px !important;
      z-index:2147483647 !important;display:flex !important;
      flex-direction:column !important;align-items:flex-end !important;
      gap:10px !important;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;
    `;

    root.innerHTML = `
      <!-- Panel (hidden by default) -->
      <div id="yme-panel" style="display:none;width:300px;background:#111;border:1px solid #222;
        border-radius:14px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.8);color:#fff;">

        <!-- Panel header -->
        <div style="padding:13px 16px;border-bottom:1px solid #1e1e1e;
          display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13px;font-weight:700;">🧠 Memory Engine</span>
          <span id="yme-close" style="cursor:pointer;color:#555;font-size:16px;padding:2px 6px;line-height:1;">✕</span>
        </div>

        <!-- Live stats (shown while on a watch page) -->
        <div id="yme-live-section" style="padding:12px 16px;border-bottom:1px solid #1a1a1a;">
          <div id="yme-video-title" style="font-size:11px;color:#666;margin-bottom:8px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Not watching a video</div>
          <div style="display:flex;gap:16px;">
            <div>
              <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;">This Video</div>
              <div id="yme-vid-total" style="font-size:16px;font-weight:700;color:#ff4e4e;">0s</div>
            </div>
            <div>
              <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;">Live</div>
              <div id="yme-live-val" style="font-size:16px;font-weight:700;color:#f5a623;">—</div>
            </div>
          </div>
        </div>

        <!-- Tab bar -->
        <div id="yme-tabs" style="display:flex;border-bottom:1px solid #1a1a1a;">
          <div id="yme-tab-live" class="yme-tab yme-tab-active" style="
            flex:1;padding:9px 0;text-align:center;font-size:11px;font-weight:700;
            color:#fff;cursor:pointer;border-bottom:2px solid #ff4e4e;
          ">Live</div>
          <div id="yme-tab-memory" class="yme-tab" style="
            flex:1;padding:9px 0;text-align:center;font-size:11px;font-weight:700;
            color:#555;cursor:pointer;border-bottom:2px solid transparent;
          ">Memory</div>
          <div id="yme-tab-related" class="yme-tab" style="
            flex:1;padding:9px 0;text-align:center;font-size:11px;font-weight:700;
            color:#555;cursor:pointer;border-bottom:2px solid transparent;
          ">Related</div>
        </div>

        <!-- Tab: Live -->
        <div id="yme-tab-content-live">

        </div><!-- end tab-content-live -->

        <!-- Tab: Memory -->
        <div id="yme-tab-content-memory" style="display:none;">
          <div id="yme-memory-body" style="padding:14px 16px;">
            <div style="font-size:12px;color:#444;text-align:center;padding:12px 0;">
              No memory yet for this video.
            </div>
          </div>
        </div>

        <!-- Tab: Related -->
        <div id="yme-tab-content-related" style="display:none;">
          <div id="yme-related-section" style="display:none;">
            <div id="yme-related-list"></div>
          </div>
          <div id="yme-related-empty" style="padding:14px 16px;font-size:12px;color:#444;text-align:center;">
            No related memories yet.
          </div>
        </div>

        <!-- Analysis content (shown after "Give Analysis") -->
        <div id="yme-analysis-section" style="display:none;">
          <div style="padding:12px 16px;border-bottom:1px solid #1a1a1a;">
            <div style="display:flex;gap:24px;margin-bottom:4px;">
              <div>
                <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;">Videos</div>
                <div id="yme-total-videos" style="font-size:20px;font-weight:700;color:#4ecc91;">0</div>
              </div>
              <div>
                <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;">Total Time</div>
                <div id="yme-total-time" style="font-size:20px;font-weight:700;color:#4ecc91;">0s</div>
              </div>
            </div>
          </div>
          <div id="yme-video-list" style="max-height:200px;overflow-y:auto;padding:6px 0;"></div>
          <div style="padding:12px 16px;border-top:1px solid #1a1a1a;">
            <button id="yme-new-session" style="
              width:100%;padding:8px;background:#1a2a1a;border:1px solid #2a3d2a;
              border-radius:8px;color:#4ecc91;font-size:12px;font-weight:700;cursor:pointer;
            ">Start New Session</button>
          </div>
        </div>

      </div>

      <!-- Button row -->
      <div style="display:flex;align-items:center;gap:8px;">

        <!-- Main toggle button -->
        <div id="yme-btn" style="
          display:flex;align-items:center;gap:8px;padding:10px 18px;
          background:#111;border:1.5px solid #333;border-radius:22px;
          cursor:pointer;font-size:13px;font-weight:600;color:#fff;
          box-shadow:0 4px 20px rgba(0,0,0,0.7);user-select:none;
        ">
          <span id="yme-dot" style="width:8px;height:8px;border-radius:50%;
            background:#444;flex-shrink:0;display:inline-block;"></span>
          <span id="yme-label">Start Tracking</span>
        </div>

        <!-- Analysis button (separate, always visible when tracking) -->
        <div id="yme-analysis-btn" style="
          display:none;padding:10px 14px;
          background:#111;border:1.5px solid #4ecc9144;border-radius:22px;
          cursor:pointer;font-size:13px;font-weight:600;color:#4ecc91;
          box-shadow:0 4px 20px rgba(0,0,0,0.7);user-select:none;white-space:nowrap;
        ">Give Analysis</div>

        <!-- Library button -->
        <div id="yme-library-btn" style="
          width:34px;height:34px;display:flex;align-items:center;justify-content:center;
          background:#111;border:1.5px solid #222;border-radius:50%;
          cursor:pointer;color:#888;font-size:14px;
          box-shadow:0 4px 12px rgba(0,0,0,0.5);user-select:none;
          title:'Open Library';
        " title="Open Library">📚</div>

        <!-- Panel toggle -->
        <div id="yme-panel-toggle" style="
          width:34px;height:34px;display:flex;align-items:center;justify-content:center;
          background:#111;border:1.5px solid #222;border-radius:50%;
          cursor:pointer;color:#555;font-size:11px;
          box-shadow:0 4px 12px rgba(0,0,0,0.5);user-select:none;
        ">▲</div>

      </div>
    `;

    document.documentElement.appendChild(root);

    // Events
    document.getElementById('yme-btn').addEventListener('click', onButtonClick);

    document.getElementById('yme-library-btn').addEventListener('click', async () => {
      // Finalize current video first so library has latest data
      if (trackingEnabled || (videoId && isRecording)) {
        await finalizeCurrentVideo();
        trackingEnabled = false;
        if (ctxOk()) chrome.storage.session.set({ trackingEnabled: false }, () => { void chrome.runtime.lastError; });
        updateButton();
      }
      // Small delay so background has time to write IndexedDB before library opens
      setTimeout(() => sendMsg({ type: 'OPEN_LIBRARY' }), 300);
    });

    document.getElementById('yme-analysis-btn').addEventListener('click', giveAnalysis);

    document.getElementById('yme-panel-toggle').addEventListener('click', () => {
      const panel = document.getElementById('yme-panel');
      const toggle = document.getElementById('yme-panel-toggle');
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? '▲' : '▼';
      if (!open) refreshLivePanel();
    });

    document.getElementById('yme-close').addEventListener('click', () => {
      document.getElementById('yme-panel').style.display = 'none';
      document.getElementById('yme-panel-toggle').textContent = '▲';
    });

    // Tab switching
    ['live', 'memory', 'related'].forEach(tab => {
      document.getElementById(`yme-tab-${tab}`).addEventListener('click', () => switchTab(tab));
    });

    document.getElementById('yme-new-session').addEventListener('click', () => {
      sendMsg({ type: 'CLEAR_ALL_SESSIONS' }, () => {
        trackingEnabled = false;
        if (ctxOk()) chrome.storage.session.set({ trackingEnabled: false }, () => { void chrome.runtime.lastError; });
        updateButton();
        document.getElementById('yme-analysis-btn').style.display = 'none';
        document.getElementById('yme-analysis-section').style.display = 'none';
        document.getElementById('yme-live-section').style.display = 'block';
        document.getElementById('yme-panel').style.display = 'none';
        document.getElementById('yme-panel-toggle').textContent = '▲';
      });
    });
  }

  // ─── Tab switching ─────────────────────────────────────────────────

  function switchTab(tab) {
    ['live', 'memory', 'related'].forEach(t => {
      const tabEl = document.getElementById(`yme-tab-${t}`);
      const contentEl = document.getElementById(`yme-tab-content-${t}`);
      const isActive = t === tab;
      if (tabEl) {
        tabEl.style.color = isActive ? '#fff' : '#555';
        tabEl.style.borderBottom = isActive ? '2px solid #ff4e4e' : '2px solid transparent';
      }
      if (contentEl) contentEl.style.display = isActive ? 'block' : 'none';
    });

    if (tab === 'memory') loadMemoryTab();
    if (tab === 'related') loadRelatedMemories();
  }

  function loadMemoryTab() {
    const body = document.getElementById('yme-memory-body');
    if (!body || !videoId) return;

    // Check IndexedDB for this video's memory
    sendMsg({ type: 'GET_VIDEO_MEMORY', videoId }, (record) => {
      renderMemoryTab(record);
    });
  }

  function renderMemoryTab(record) {
    const body = document.getElementById('yme-memory-body');
    if (!body) return;

    if (!record) {
      body.innerHTML = `<div style="font-size:12px;color:#444;text-align:center;padding:12px 0;">No memory yet for this video.</div>`;
      return;
    }

    if (record.nlpStatus === 'processing') {
      body.innerHTML = `<div style="font-size:12px;color:#555;text-align:center;padding:12px 0;">⏳ Memory is being processed…</div>`;
      return;
    }

    let html = '';

    // Summary
    if (record.summary) {
      html += `
        <div style="margin-bottom:14px;">
          <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Summary</div>
          <div style="font-size:12px;color:#ccc;line-height:1.7;">${escStr(record.summary)}</div>
        </div>
      `;
    }

    // Keywords
    if (record.keywords?.length) {
      html += `
        <div style="margin-bottom:14px;">
          <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Key Concepts</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;">
            ${record.keywords.map(k => `
              <span style="font-size:11px;background:#1a1a2e;color:#4e9fff;border-radius:4px;padding:3px 8px;">${escStr(k)}</span>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Watch stats
    html += `
      <div style="margin-bottom:14px;">
        <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Watch Stats</div>
        <div style="display:flex;gap:16px;">
          <div>
            <div style="font-size:16px;font-weight:700;color:#ff4e4e;">${formatDuration(record.totalWatched || 0)}</div>
            <div style="font-size:10px;color:#555;">total watched</div>
          </div>
          <div>
            <div style="font-size:16px;font-weight:700;color:#ff4e4e;">${record.sessions || 1}×</div>
            <div style="font-size:10px;color:#555;">sessions</div>
          </div>
        </div>
      </div>
    `;

    // Transcript snippet
    if (record.transcript) {
      const snippet = record.transcript.slice(0, 300);
      html += `
        <div>
          <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">What You Watched</div>
          <div style="font-size:11px;color:#555;line-height:1.6;font-style:italic;
            border-left:2px solid #222;padding-left:8px;">
            "${escStr(snippet)}${record.transcript.length > 300 ? '…' : ''}"
          </div>
        </div>
      `;
    }

    if (!html) {
      html = `<div style="font-size:12px;color:#444;text-align:center;padding:12px 0;">Transcript unavailable for this video.</div>`;
    }

    body.innerHTML = html;
  }

  function escStr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─── Analysis panel ────────────────────────────────────────────────

  function openAnalysisPanel() {
    // Show the panel
    const panel = document.getElementById('yme-panel');
    const toggle = document.getElementById('yme-panel-toggle');
    if (panel) { panel.style.display = 'block'; }
    if (toggle) { toggle.textContent = '▼'; }

    // Switch sections
    const liveSection = document.getElementById('yme-live-section');
    const analysisSection = document.getElementById('yme-analysis-section');
    if (liveSection) liveSection.style.display = 'none';
    if (analysisSection) analysisSection.style.display = 'block';

    // Show analysis button as green static
    const analysisBtn = document.getElementById('yme-analysis-btn');
    if (analysisBtn) analysisBtn.style.display = 'flex';

    // Update main button to show idle
    updateButton();

    // Load and render all sessions
    sendMsg({ type: 'GET_ALL_SESSIONS' }, (sessions) => {
      renderAnalysis(sessions || {});
    });
  }

  function renderAnalysis(sessions) {
    const list = Object.values(sessions).filter(s => s.totalWatched > 0);
    const totalVideos = list.length;
    const totalTime = list.reduce((sum, s) => sum + (s.totalWatched || 0), 0);

    const elVideos = document.getElementById('yme-total-videos');
    const elTime = document.getElementById('yme-total-time');
    const elList = document.getElementById('yme-video-list');

    if (elVideos) elVideos.textContent = totalVideos;
    if (elTime) elTime.textContent = formatDuration(totalTime);
    if (!elList) return;

    elList.innerHTML = '';

    if (list.length === 0) {
      elList.innerHTML = '<div style="padding:14px 16px;font-size:12px;color:#444;text-align:center;">No videos tracked yet.</div>';
      return;
    }

    list.forEach((session, i) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display:flex;align-items:center;gap:10px;
        padding:9px 16px;border-bottom:1px solid #171717;
      `;
      row.innerHTML = `
        <span style="font-size:11px;color:#333;font-weight:700;flex-shrink:0;">${i + 1}</span>
        <span style="font-size:12px;color:#ccc;flex:1;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${session.title || 'Untitled'}
        </span>
        <span style="font-size:12px;color:#4ecc91;font-weight:600;flex-shrink:0;">
          ${formatDuration(session.totalWatched)}
        </span>
      `;
      elList.appendChild(row);
    });
  }

  function refreshLivePanel() {
    if (!videoId) return;
    sendMsg({ type: 'GET_SESSION', videoId }, (session) => {
      const elTitle = document.getElementById('yme-video-title');
      const elTotal = document.getElementById('yme-vid-total');
      if (elTitle) elTitle.textContent = session?.title || getTitle() || 'Loading...';
      if (elTotal) elTotal.textContent = formatDuration(session?.totalWatched || 0);
    });
  }

  function updateButton() {
    const dot = document.getElementById('yme-dot');
    const label = document.getElementById('yme-label');
    const btn = document.getElementById('yme-btn');
    if (!dot || !label || !btn) return;

    if (trackingEnabled) {
      dot.style.background = '#ff4e4e';
      dot.style.boxShadow = '0 0 8px #ff4e4e';
      btn.style.borderColor = '#ff4e4e55';
      label.textContent = 'Tracking...';
    } else {
      dot.style.background = '#444';
      dot.style.boxShadow = 'none';
      btn.style.borderColor = '#333';
      label.textContent = 'Start Tracking';
    }

    // Show "Give Analysis" only while tracking is on
    const analysisBtn = document.getElementById('yme-analysis-btn');
    if (analysisBtn) analysisBtn.style.display = trackingEnabled ? 'flex' : 'none';
  }

  // ─── Live Caption Observer ────────────────────────────────────────

  function startCaptionObserver() {
    stopCaptionObserver();

    // Watch the entire player for caption segments appearing
    const target = document.querySelector('.html5-video-player') || document.body;
    captionObserver = new MutationObserver(() => {
      if (!trackingEnabled) return;
      // Grab all currently visible caption segments
      const segments = document.querySelectorAll('.ytp-caption-segment');
      if (!segments.length) return;

      const text = Array.from(segments).map(s => s.textContent).join(' ').trim();
      if (!text || text === lastCaptionText) return;

      lastCaptionText = text;
      liveTranscript += (liveTranscript ? ' ' : '') + text;
    });

    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    console.log('[YME] Caption observer started');
  }

  function stopCaptionObserver() {
    if (captionObserver) { captionObserver.disconnect(); captionObserver = null; }
  }

  function resetTranscript() {
    liveTranscript = '';
    lastCaptionText = '';
  }

  // ─── Transcript Extraction ─────────────────────────────────────────

  async function fetchTranscriptForSegments(segments) {
    const playerData = window.ytInitialPlayerResponse;
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;

    const track = tracks.find(t => t.languageCode === 'en') || tracks[0];
    if (!track?.baseUrl) return null;

    const res = await fetch(track.baseUrl + '&fmt=json3');
    if (!res.ok) return null;
    const data = await res.json();

    const words = [];
    for (const event of (data.events || [])) {
      if (!event.segs) continue;
      const startSec = (event.tStartMs || 0) / 1000;
      const endSec = startSec + (event.dDurationMs || 0) / 1000;
      const inSegment = segments.some(s => startSec >= s.start - 0.5 && startSec <= s.end + 0.5);
      if (inSegment) {
        words.push(event.segs.map(s => s.utf8 || '').join(''));
      }
    }

    return words.join(' ').replace(/\s+/g, ' ').trim() || null;
  }

  // ─── Related Memories ──────────────────────────────────────────────

  async function loadRelatedMemories() {
    const vid = getVideoId();
    if (!vid) return;

    // Fetch first 60s of transcript as the query for semantic search
    let earlyTranscript = null;
    try {
      earlyTranscript = await fetchTranscriptForSegments([{ start: 0, end: 60 }]);
    } catch (_) {}

    // Ask background to embed the current video's text and find related memories
    // Background has the embedding model — content script just sends raw text
    sendMsg({
      type: 'GET_RELATED_MEMORIES',
      queryText: earlyTranscript || getTitle() || '',
      excludeVideoId: vid,
    }, (related) => {
      renderRelatedMemories(related || []);
    });
  }

  function renderRelatedMemories(memories) {
    const container = document.getElementById('yme-related-section');
    const empty = document.getElementById('yme-related-empty');
    if (!container) return;

    if (!memories.length) {
      container.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }

    container.style.display = 'block';
    if (empty) empty.style.display = 'none';
    const list = document.getElementById('yme-related-list');
    if (!list) return;
    list.innerHTML = '';

    memories.forEach(m => {
      const row = document.createElement('a');
      row.href = m.url;
      row.target = '_blank';
      row.rel = 'noopener';
      row.style.cssText = `
        display:flex;align-items:flex-start;gap:8px;
        padding:8px 14px;border-bottom:1px solid #171717;
        text-decoration:none;color:inherit;cursor:pointer;
      `;
      // Use pre-computed edge data if available, fallback to keyword count
      const pct = m.score != null ? Math.round(m.score * 100) + '% match' : (m.matchCount ? m.matchCount + ' keyword match' : '');
      const sharedConcepts = [...(m.sharedEntities || []), ...(m.sharedKeywords || [])];
      const conceptsToShow = sharedConcepts.length ? sharedConcepts : (m.keywords || []);
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;color:#ccc;font-weight:600;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;">
            ${m.title || 'Untitled'}
          </div>
          <div style="font-size:10px;color:#4e9fff;margin-bottom:3px;">${escStr(pct)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:3px;">
            ${conceptsToShow.slice(0, 4).map(c => `
              <span style="font-size:10px;background:#1a1a2e;color:#4e9fff;border-radius:3px;padding:1px 5px;">${escStr(c)}</span>
            `).join('')}
          </div>
        </div>
        <div style="font-size:11px;color:#ff4e4e;font-weight:600;flex-shrink:0;padding-top:1px;">
          ${formatDuration(m.totalWatched || 0)}
        </div>
      `;
      list.appendChild(row);
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v');
  }

  function getTitle() {
    if (title) return title;
    const el =
      document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1[class*="title"]');
    title = el?.textContent?.trim() || document.title.replace(' - YouTube', '').trim();
    return title;
  }

  const CATEGORY_MAP = {
    'Music': 'Music',
    'Entertainment': 'Entertainment',
    'Education': 'Educational',
    'Science & Technology': 'Educational',
    'Howto & Style': 'Educational',
    'Comedy': 'Comedy',
    'News & Politics': 'News',
    'Sports': 'Sports',
    'Gaming': 'Gaming',
    'Film & Animation': 'Entertainment',
    'Autos & Vehicles': 'Entertainment',
    'Travel & Events': 'Entertainment',
    'People & Blogs': 'Entertainment',
    'Pets & Animals': 'Entertainment',
    'Nonprofits & Activism': 'News',
  };

  function getCategory() {
    // 1. Try meta tag (most reliable)
    const meta = document.querySelector('meta[itemprop="genre"]');
    if (meta?.content) return CATEGORY_MAP[meta.content] || meta.content;

    // 2. Try ytInitialData
    try {
      const raw = window.ytInitialData?.microformat?.playerMicroformatRenderer?.category;
      if (raw) return CATEGORY_MAP[raw] || raw;
    } catch (_) {}

    return 'Other';
  }

  function getChannelName() {
    const el =
      document.querySelector('ytd-channel-name yt-formatted-string#text a') ||
      document.querySelector('#channel-name a') ||
      document.querySelector('ytd-video-owner-renderer #channel-name');
    return el?.textContent?.trim() || '';
  }

  function formatDuration(s) {
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

})();
