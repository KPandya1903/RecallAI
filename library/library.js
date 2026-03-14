// library.js — YouTube Memory Library page

const CATEGORY_META = {
  'Music':         { icon: '🎵', order: 1 },
  'Educational':   { icon: '🎓', order: 2 },
  'Entertainment': { icon: '🎬', order: 3 },
  'Comedy':        { icon: '😂', order: 4 },
  'Gaming':        { icon: '🎮', order: 5 },
  'News':          { icon: '📰', order: 6 },
  'Sports':        { icon: '⚽', order: 7 },
  'Other':         { icon: '📦', order: 99 },
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadLibrary();

  document.getElementById('btn-graph').addEventListener('click', () => {
    const graphUrl = chrome.runtime.getURL('graph/index.html');
    chrome.tabs.create({ url: graphUrl });
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear your entire library? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_LIBRARY' }, () => {
      void chrome.runtime.lastError;
      loadLibrary();
    });
  });
});

function loadLibrary() {
  chrome.runtime.sendMessage({ type: 'GET_LIBRARY' }, (grouped) => {
    void chrome.runtime.lastError;
    render(grouped || {});
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render(grouped) {
  const main = document.getElementById('library-content');
  const emptyState = document.getElementById('empty-state');

  main.querySelectorAll('.category-section').forEach(el => el.remove());

  const allVideos = Object.values(grouped).flat();

  if (allVideos.length === 0) {
    emptyState.classList.remove('hidden');
    document.getElementById('total-videos').textContent = '0';
    document.getElementById('total-time').textContent = '0s';
    return;
  }

  emptyState.classList.add('hidden');

  const totalWatched = allVideos.reduce((sum, v) => sum + (v.totalWatched || 0), 0);
  document.getElementById('total-videos').textContent = allVideos.length;
  document.getElementById('total-time').textContent = formatDuration(totalWatched);

  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    return (CATEGORY_META[a]?.order ?? 50) - (CATEGORY_META[b]?.order ?? 50);
  });

  for (const category of sortedCategories) {
    const videos = grouped[category];
    if (!videos?.length) continue;
    main.appendChild(buildCategorySection(category, videos));
  }
}

function buildCategorySection(category, videos) {
  const meta = CATEGORY_META[category] || { icon: '📦' };
  const totalTime = videos.reduce((sum, v) => sum + (v.totalWatched || 0), 0);

  const section = document.createElement('div');
  section.className = 'category-section';
  section.innerHTML = `
    <div class="category-header">
      <span class="category-icon">${meta.icon}</span>
      <span class="category-name">${category}</span>
      <span class="category-meta">${videos.length} video${videos.length !== 1 ? 's' : ''} · ${formatDuration(totalTime)}</span>
    </div>
    <div class="video-grid"></div>
  `;

  const grid = section.querySelector('.video-grid');
  for (const video of videos) {
    grid.appendChild(buildVideoCard(video));
  }

  return section;
}

// ─── Video Card (with expandable memory) ──────────────────────────────────────

function buildVideoCard(video) {
  const card = document.createElement('div');
  card.className = 'video-card';

  const sessions = video.sessions || 1;
  const nlpPending = video.nlpStatus === 'processing';

  card.innerHTML = `
    <a class="card-link" href="${video.url}" target="_blank" rel="noopener noreferrer">
      <img
        class="video-thumb"
        src="${video.thumbnailUrl}"
        alt="${escapeHtml(video.title)}"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
      />
      <div class="video-thumb-placeholder" style="display:none;">▶</div>
      <div class="video-info">
        <div class="video-title">${escapeHtml(video.title || 'Untitled')}</div>
        <div class="video-meta-row">
          <span class="video-channel">${escapeHtml(video.channelName || '')}</span>
          <span class="video-watch-time">${formatDuration(video.totalWatched || 0)}</span>
        </div>
        ${sessions > 1 ? `<div class="video-sessions">watched ${sessions}×</div>` : ''}
        ${video.keywords?.length ? `
          <div class="video-keywords">
            ${video.keywords.slice(0, 4).map(k => `<span class="kw-tag">${escapeHtml(k)}</span>`).join('')}
          </div>` : ''}
      </div>
    </a>

    <button class="memory-toggle" data-expanded="false">
      🧠 ${nlpPending ? 'Processing...' : 'View Memory'}
    </button>
    <div class="memory-panel" style="display:none;">
      ${buildMemoryPanel(video)}
    </div>
  `;

  // Expand/collapse memory panel
  const btn = card.querySelector('.memory-toggle');
  const panel = card.querySelector('.memory-panel');
  if (btn && panel) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const expanded = btn.dataset.expanded === 'true';
      btn.dataset.expanded = !expanded;
      panel.style.display = expanded ? 'none' : 'block';
      btn.textContent = expanded ? '🧠 View Memory' : '🧠 Hide Memory';
      if (!expanded) loadConnections(video.videoId);
    });
  }

  return card;
}

function buildMemoryPanel(video) {
  let html = '';

  // Summary
  if (video.summary) {
    html += `
      <div class="memory-block">
        <div class="memory-label">Summary</div>
        <div class="memory-summary">${escapeHtml(video.summary)}</div>
      </div>
    `;
  }

  // Keywords
  if (video.keywords?.length) {
    html += `
      <div class="memory-block">
        <div class="memory-label">Key Concepts</div>
        <div class="memory-keywords">
          ${video.keywords.map(k => `<span class="kw-tag kw-large">${escapeHtml(k)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  // Entities
  if (video.entities?.length) {
    html += `
      <div class="memory-block">
        <div class="memory-label">Entities</div>
        <div class="memory-keywords">
          ${video.entities.slice(0, 8).map(e => `<span class="kw-tag kw-entity">${escapeHtml(e.text)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  // Transcript
  if (video.transcript) {
    html += `
      <div class="memory-block">
        <div class="memory-label">Transcript</div>
        <div class="memory-transcript">${escapeHtml(video.transcript)}</div>
      </div>
    `;
  }

  // Connected memories (mesh) — loaded async after panel opens
  html += `
    <div class="memory-block" id="connections-${escapeHtml(video.videoId)}">
      <div class="memory-label">🔗 Connected Memories</div>
      <div class="memory-connections-body" style="font-size:11px;color:#444;font-style:italic;">Loading…</div>
    </div>
  `;

  if (!html.includes('memory-summary') && !html.includes('memory-transcript') && !video.keywords?.length) {
    html = '<div class="memory-empty">No transcript captured. Enable CC (captions) while watching to build memory.</div>';
  }

  return html;
}

function loadConnections(videoId) {
  chrome.runtime.sendMessage({ type: 'GET_EDGES', videoId }, async (edges) => {
    void chrome.runtime.lastError;
    const container = document.querySelector(`#connections-${videoId} .memory-connections-body`);
    if (!container) return;

    if (!edges?.length) {
      container.textContent = 'No connections yet. Watch more related videos.';
      return;
    }

    // Sort by weight, take top 5
    const sorted = edges.sort((a, b) => b.weight - a.weight).slice(0, 5);

    // Fetch connected video titles
    const rows = await Promise.all(sorted.map(e => new Promise(res => {
      const targetId = e.source === videoId ? e.target : e.source;
      chrome.runtime.sendMessage({ type: 'GET_VIDEO_MEMORY', videoId: targetId }, video => {
        void chrome.runtime.lastError;
        res(video ? { ...e, targetId, targetTitle: video.title, targetUrl: video.url } : null);
      });
    })));

    const valid = rows.filter(Boolean);
    if (!valid.length) {
      container.textContent = 'No connections yet.';
      return;
    }

    container.innerHTML = valid.map(row => {
      const pct = Math.round(row.weight * 100);
      const barWidth = Math.round(row.weight * 80);
      const shared = [...(row.sharedEntities || []), ...(row.sharedKeywords || [])].slice(0, 4);
      return `
        <a class="connection-row" href="${row.targetUrl}" target="_blank" rel="noopener">
          <div class="connection-info">
            <div class="connection-title">${escapeHtml(row.targetTitle || 'Untitled')}</div>
            <div class="connection-bar-wrap">
              <div class="connection-bar" style="width:${barWidth}px"></div>
              <span class="connection-pct">${pct}% match</span>
            </div>
            ${shared.length ? `<div class="connection-tags">${shared.map(s => `<span class="kw-tag">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
          </div>
        </a>
      `;
    }).join('');
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(s) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return r > 0 ? `${h}h ${m}m` : `${h}h`;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
