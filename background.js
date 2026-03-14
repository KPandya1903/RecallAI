// background.js — Service Worker + IndexedDB + transformers.js embeddings
import { pipeline, env } from './lib/transformers.js';

// Use browser cache for model weights
env.allowLocalModels = false;
env.useBrowserCache = true;

// ─── Embedding Pipeline (all-MiniLM-L6-v2, ~23MB, fast) ──────────────────────

let embeddingPipeline = null;

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    console.log('[YME] Loading embedding model (first time ~23MB download)...');
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[YME] Embedding model ready');
  }
  return embeddingPipeline;
}

async function embed(text) {
  try {
    const pipe = await getEmbeddingPipeline();
    const out = await pipe(text.slice(0, 512), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (e) {
    console.warn('[YME] Embedding failed:', e.message);
    return null;
  }
}

// ─── Local NLP (no model needed — fast, always works) ────────────────────────

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can','need',
  'i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their','this','that','these','those',
  'what','which','who','how','when','where','why','all','as','if','then',
  'so','than','about','up','out','no','not','just','more','also','like',
  'get','go','know','make','see','think','come','take','use','want','look',
  'well','one','two','some','there','from','into','very','really',
  'okay','oh','yeah','uh','um','gonna','gotta','kinda','wanna','right',
  'actually','basically','literally','probably','definitely','already',
  'going','things','thing','people','time','way','even','back','still',
  'here','now','just','like','really','little','lot','much','many','got',
]);

function extractKeywords(text, topN = 10) {
  if (!text) return [];
  const tokens = text.toLowerCase().match(/\b[a-z][a-z]{2,}\b/g) || [];
  const freq = {};
  for (const w of tokens) {
    if (!STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .map(([w, c]) => ({ w, score: c * Math.log(w.length + 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(e => e.w);
}

function extractiveSummary(text, keywords, topN = 3) {
  if (!text) return null;
  const keySet = new Set(keywords);
  const sentences = text.match(/[^.!?]{20,}[.!?]+/g) || [];
  if (!sentences.length) return text.slice(0, 300).trim();

  return sentences
    .map(s => ({
      s,
      score: (s.toLowerCase().match(/\b[a-z]+\b/g) || []).filter(w => keySet.has(w)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .sort((a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s))
    .map(e => e.s.trim())
    .join(' ');
}

// ─── Entity Extraction (pure JS — proper nouns / Title-Cased phrases) ────────

function extractEntities(text) {
  if (!text) return [];
  // Match sequences of Title-Cased words (e.g. "Machine Learning", "Sam Altman")
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  const freq = {};
  for (const m of matches) {
    if (m.length >= 4 && !STOPWORDS.has(m.toLowerCase())) {
      freq[m] = (freq[m] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([text, count]) => ({ text, count }));
}

async function processTranscript(transcript) {
  if (!transcript || transcript.length < 50) {
    return { summary: null, embedding: null, keywords: [], entities: [] };
  }

  const keywords = extractKeywords(transcript, 12);
  const summary = extractiveSummary(transcript, keywords, 3);
  const entities = extractEntities(transcript);

  // Embed the summary for semantic search (real ML, ~0.5s)
  const embedText = summary || transcript.slice(0, 512);
  const embedding = await embed(embedText);

  return { keywords, summary, embedding, entities };
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'yme_library';
const DB_VERSION = 2;   // bumped for edges store
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('videos')) {
        const store = d.createObjectStore('videos', { keyPath: 'videoId' });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('lastWatched', 'lastWatched', { unique: false });
      }
      // Memory mesh: edges between memories
      if (!d.objectStoreNames.contains('edges')) {
        const es = d.createObjectStore('edges', { keyPath: 'id' });
        es.createIndex('source', 'source', { unique: false });
        es.createIndex('target', 'target', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); }
    req.onerror = () => reject(req.error);
  });
}

const dbGet = (id) => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('videos','readonly').objectStore('videos').get(id);
  r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
}));

const dbPut = (rec) => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('videos','readwrite').objectStore('videos').put(rec);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));

const dbGetAll = () => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('videos','readonly').objectStore('videos').getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));

const dbClear = () => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('videos','readwrite').objectStore('videos').clear();
  r.onsuccess = () => res(); r.onerror = () => rej(r.error);
}));

// ─── Edge helpers ─────────────────────────────────────────────────────────────

const dbPutEdge = (edge) => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('edges','readwrite').objectStore('edges').put(edge);
  r.onsuccess = () => res(); r.onerror = () => rej(r.error);
}));

const dbGetEdgesFor = (videoId) => openDB().then(d => new Promise((res, rej) => {
  const store = d.transaction('edges','readonly').objectStore('edges');
  const results = [];
  const reqSrc = store.index('source').getAll(videoId);
  reqSrc.onsuccess = () => {
    results.push(...reqSrc.result);
    const reqTgt = store.index('target').getAll(videoId);
    reqTgt.onsuccess = () => { results.push(...reqTgt.result); res(results); };
    reqTgt.onerror = () => rej(reqTgt.error);
  };
  reqSrc.onerror = () => rej(reqSrc.error);
}));

const dbClearEdges = () => openDB().then(d => new Promise((res, rej) => {
  const r = d.transaction('edges','readwrite').objectStore('edges').clear();
  r.onsuccess = () => res(); r.onerror = () => rej(r.error);
}));

// ─── Memory Mesh: Build Edges ─────────────────────────────────────────────────

async function buildEdges(newRecord) {
  if (!newRecord.embedding?.length) return;
  const all = await dbGetAll();
  const others = all.filter(v => v.videoId !== newRecord.videoId && v.embedding?.length);

  const newEntitySet = new Set((newRecord.entities || []).map(e => e.text.toLowerCase()));

  let edgeCount = 0;
  for (const other of others) {
    const cosine = cosineSimilarity(newRecord.embedding, other.embedding);

    const otherEntitySet = new Set((other.entities || []).map(e => e.text.toLowerCase()));
    const sharedEntities = [...newEntitySet].filter(e => otherEntitySet.has(e));
    const unionSize = new Set([...newEntitySet, ...otherEntitySet]).size;
    const entityScore = unionSize > 0 ? sharedEntities.length / unionSize : 0;

    const sharedKeywords = (newRecord.keywords || []).filter(k => (other.keywords || []).includes(k));

    const combined = 0.7 * cosine + 0.3 * entityScore;

    if (combined > 0.2) {
      const [a, b] = [newRecord.videoId, other.videoId].sort();
      await dbPutEdge({
        id: `${a}→${b}`,
        source: newRecord.videoId,
        target: other.videoId,
        weight: parseFloat(combined.toFixed(4)),
        cosine: parseFloat(cosine.toFixed(4)),
        sharedEntities,
        sharedKeywords,
        updatedAt: new Date().toISOString(),
      });
      edgeCount++;
    }
  }
  console.log(`[YME] Mesh: ${edgeCount} edges created from ${others.length} comparisons for "${newRecord.title}"`);
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const h = {
    SEGMENT_UPDATE:      () => handleSegmentUpdate(message).then(sendResponse),
    FINALIZE_SESSION:    () => handleFinalizeSession(message).then(sendResponse),
    GET_SESSION:         () => getSession(message.videoId).then(sendResponse),
    GET_ALL_SESSIONS:    () => getAllSessions().then(sendResponse),
    CLEAR_ALL_SESSIONS:  () => clearAllSessions().then(sendResponse),
    CLEAR_SESSION:       () => clearSession(message.videoId).then(sendResponse),
    GET_LIBRARY:         () => getLibrary().then(sendResponse),
    GET_VIDEO_MEMORY:    () => dbGet(message.videoId).then(sendResponse),
    CLEAR_LIBRARY:       () => Promise.all([dbClear(), dbClearEdges()]).then(() => sendResponse({ success: true })),
    OPEN_LIBRARY:        () => { chrome.tabs.create({ url: chrome.runtime.getURL('library/index.html') }); sendResponse({ success: true }); },
    GET_RELATED_MEMORIES:() => getRelatedMemories(message.queryText, message.excludeVideoId).then(sendResponse),
    GET_EDGES:           () => dbGetEdgesFor(message.videoId).then(sendResponse),
  };
  if (h[message.type]) { h[message.type](); return true; }
});

// ─── Session (chrome.storage.local) ──────────────────────────────────────────

async function handleSegmentUpdate({ videoId, title, segment, duration }) {
  const data = await chrome.storage.local.get('sessions');
  const sessions = data.sessions || {};
  const existing = sessions[videoId] || { videoId, title, duration, segments: [], totalWatched: 0, finalized: false, lastUpdated: null };
  existing.title = title || existing.title;
  existing.duration = duration || existing.duration;
  existing.segments = mergeSegments([...existing.segments, segment]);
  existing.totalWatched = computeTotal(existing.segments);
  existing.lastUpdated = new Date().toISOString();
  sessions[videoId] = existing;
  await chrome.storage.local.set({ sessions });
  return { success: true, session: existing };
}

async function handleFinalizeSession({ videoId, title, category, channelName, thumbnailUrl, transcript }) {
  console.log('[YME] FINALIZE_SESSION received:', { videoId, title, hasTranscript: !!transcript, transcriptLen: transcript?.length });

  // Mark finalized in session storage
  const data = await chrome.storage.local.get('sessions');
  const sessions = data.sessions || {};
  const session = sessions[videoId];
  console.log('[YME] Session found:', session ? `totalWatched=${session.totalWatched}` : 'none');
  if (session) {
    session.finalized = true;
    session.lastUpdated = new Date().toISOString();
    sessions[videoId] = session;
    await chrome.storage.local.set({ sessions });
  }

  const totalWatched = session?.totalWatched || 0;
  if (totalWatched < 2) {
    console.log('[YME] Skipping — totalWatched too low:', totalWatched);
    return { success: true };
  }

  const existing = await dbGet(videoId);
  const now = new Date().toISOString();

  console.log('[YME] Running NLP on transcript length:', transcript?.length);
  const { keywords, summary, embedding, entities } = await processTranscript(transcript);
  console.log('[YME] NLP done — keywords:', keywords?.length, 'summary:', !!summary, 'embedding:', !!embedding, 'entities:', entities?.length);

  const record = {
    videoId,
    title: title || session?.title || 'Untitled',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    channelName: channelName || '',
    thumbnailUrl: thumbnailUrl || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    category: category || 'Other',
    totalWatched: (existing?.totalWatched || 0) + totalWatched,
    sessions: (existing?.sessions || 0) + 1,
    firstWatched: existing?.firstWatched || now,
    lastWatched: now,
    transcript: transcript || existing?.transcript || null,
    keywords: keywords.length ? keywords : (existing?.keywords || []),
    summary: summary || existing?.summary || null,
    embedding: embedding || existing?.embedding || null,
    entities: entities.length ? entities : (existing?.entities || []),
    nlpStatus: 'done',
  };

  await dbPut(record);
  console.log('[YME] Memory saved for:', record.title);

  // Build memory mesh edges
  await buildEdges(record);

  return { success: true };
}

async function getSession(videoId) {
  const data = await chrome.storage.local.get('sessions');
  return (data.sessions || {})[videoId] || null;
}

async function getAllSessions() {
  const data = await chrome.storage.local.get('sessions');
  return data.sessions || {};
}

async function clearAllSessions() {
  await chrome.storage.local.set({ sessions: {} });
  return { success: true };
}

async function clearSession(videoId) {
  const data = await chrome.storage.local.get('sessions');
  const sessions = data.sessions || {};
  delete sessions[videoId];
  await chrome.storage.local.set({ sessions });
  return { success: true };
}

// ─── Library ──────────────────────────────────────────────────────────────────

async function getLibrary() {
  const all = await dbGetAll();
  const grouped = {};
  for (const v of all) {
    const cat = v.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(v);
  }
  for (const cat of Object.keys(grouped)) {
    grouped[cat].sort((a, b) => new Date(b.lastWatched) - new Date(a.lastWatched));
  }
  return grouped;
}

// ─── Related memories (pre-computed edges first, fallback to on-the-fly) ──────

async function getRelatedMemories(queryText, excludeVideoId) {
  // Fast path: use pre-computed mesh edges (instant)
  if (excludeVideoId) {
    const edges = await dbGetEdgesFor(excludeVideoId);
    if (edges.length) {
      const sorted = edges.sort((a, b) => b.weight - a.weight).slice(0, 5);
      const results = (await Promise.all(sorted.map(async e => {
        const targetId = e.source === excludeVideoId ? e.target : e.source;
        const video = await dbGet(targetId);
        return video ? { ...video, score: e.weight, sharedEntities: e.sharedEntities, sharedKeywords: e.sharedKeywords } : null;
      }))).filter(Boolean);
      if (results.length) return results;
    }
  }

  // Fallback: embed queryText and compute cosine similarity on-the-fly
  const all = await dbGetAll();
  const candidates = all.filter(v => v.videoId !== excludeVideoId);

  if (queryText) {
    const queryEmbedding = await embed(queryText.slice(0, 512));
    if (queryEmbedding) {
      const withEmbeddings = candidates.filter(v => v.embedding?.length);
      if (withEmbeddings.length) {
        const scored = withEmbeddings
          .map(v => ({ ...v, score: cosineSimilarity(queryEmbedding, v.embedding) }))
          .filter(v => v.score > 0.25)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        if (scored.length) return scored;
      }
    }
  }

  // Final fallback: keyword overlap
  const queryKeywords = extractKeywords(queryText || '', 8);
  if (queryKeywords.length) {
    const keySet = new Set(queryKeywords);
    return candidates
      .filter(v => v.keywords?.length)
      .map(v => ({ ...v, matchCount: v.keywords.filter(k => keySet.has(k)).length }))
      .filter(v => v.matchCount >= 1)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, 3);
  }

  return [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeSegments(segments) {
  if (!segments.length) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]; const last = merged[merged.length - 1];
    if (cur.start <= last.end + 1) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

function computeTotal(segs) {
  return segs.reduce((s, seg) => s + (seg.end - seg.start), 0);
}
