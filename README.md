# RecallAI

A Chrome extension that transforms your YouTube watch history into a **semantic memory network**. It captures live captions, processes them with local NLP, extracts keywords and entities, computes embeddings for semantic similarity, and visualizes your knowledge as an interactive 3D neuron graph.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Local NLP](https://img.shields.io/badge/NLP-Local%20Only-FF6B6B)
![No API Keys](https://img.shields.io/badge/API%20Keys-None%20Required-4ecc91)

---

## Features

- **Live Caption Capture** — Scrapes YouTube's closed captions in real time via DOM observation (no API key needed)
- **Local NLP Pipeline** — Keyword extraction (TF-IDF), entity recognition (proper noun regex), extractive summarization — all running in-browser
- **Semantic Embeddings** — Uses [transformers.js](https://huggingface.co/docs/transformers.js) with `all-MiniLM-L6-v2` to compute 384-dimensional vectors for each video's content
- **Memory Mesh** — Automatically builds edges between related videos using cosine similarity (70%) + entity overlap (30%), threshold > 0.2
- **3D Neuron Visualization** — Interactive force-directed graph with glowing nodes, animated energy particles, and orbit controls
- **Category Grouping** — Videos auto-categorized (Music, Educational, Entertainment, Gaming, etc.) with color-coded nodes
- **Zero External Dependencies** — Everything runs locally in the browser. No server, no API keys, no data leaves your machine

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    YouTube Tab                          │
│                                                         │
│  content_script.js                                      │
│  ├── MutationObserver on .ytp-caption-segment           │
│  ├── Tracks play/pause segments                         │
│  ├── Extracts metadata (title, channel, category)       │
│  └── Sends FINALIZE_SESSION on navigation               │
└──────────────────────┬──────────────────────────────────┘
                       │ chrome.runtime.sendMessage
                       ▼
┌─────────────────────────────────────────────────────────┐
│              background.js (Service Worker)              │
│                                                         │
│  ├── IndexedDB: videos + edges stores                   │
│  ├── transformers.js → all-MiniLM-L6-v2 embeddings      │
│  ├── TF-IDF keyword extraction                          │
│  ├── Entity extraction (proper noun regex)               │
│  ├── Extractive summarization                           │
│  └── Edge computation: 0.7×cosine + 0.3×entity_overlap  │
└──────────┬──────────────────────┬───────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────┐
│   popup/          │   │   library/                        │
│   Quick stats     │   │   Full memory dashboard           │
│   Current session │   │   Category sections, memory       │
│                   │   │   panels, connected memories      │
└──────────────────┘   └──────────────┬───────────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────────┐
                       │   graph/                          │
                       │   3D neuron network visualization │
                       │   Nodes = videos, Edges = links   │
                       │   Force-directed + orbit controls │
                       └──────────────────────────────────┘
```

## Project Structure

```
RecallAI/
├── manifest.json          # Chrome Extension config (MV3)
├── background.js          # Service worker: storage, NLP, embeddings, edges
├── content_script.js      # YouTube DOM: captions, segments, metadata
├── icons/
│   └── icon128.png        # Extension icon
├── popup/
│   ├── index.html         # Popup UI template
│   ├── popup.js           # Current session display
│   └── popup.css          # Popup styling
├── library/
│   ├── index.html         # Library page template
│   ├── library.js         # Memory dashboard with category grouping
│   └── library.css        # Library styling
├── graph/
│   ├── index.html         # 3D visualization page
│   └── graph.js           # Neuron network renderer
└── lib/
    ├── transformers.js    # Hugging Face Transformers.js
    └── transformers.min.js
```

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/KPandya1903/RecallAI.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top right)

4. Click **Load unpacked** and select the cloned directory

5. Navigate to any YouTube video — the extension icon appears in your toolbar

## Usage

### Tracking Videos
1. Navigate to any YouTube video
2. **Enable CC (closed captions)** on the video — this is required for transcript capture
3. The extension automatically tracks your watch time and captures captions
4. When you navigate away or click the library button, the video is finalized and processed

### Viewing Your Library
- Click the extension icon → **Open Library**
- Videos are grouped by category with expandable memory panels showing:
  - Summary, keywords, entities, transcript
  - Connected memories with similarity scores

### 3D Memory Network
- From the library, click **Memory Network** to open the interactive 3D graph
- Each node is a video, sized by watch time, colored by category
- Edges connect semantically related videos
- Drag to orbit, scroll to zoom, click nodes for details

## Data Model

| Store | Fields |
|-------|--------|
| **videos** | `videoId`, `title`, `channelName`, `category`, `thumbnailUrl`, `totalWatched`, `transcript`, `summary`, `keywords[]`, `entities[]`, `embedding[384]` |
| **edges** | `id`, `source`, `target`, `weight`, `cosine`, `sharedEntities[]`, `sharedKeywords[]` |

## How the Memory Mesh Works

1. When a video is finalized, its transcript is processed through the local NLP pipeline
2. An embedding vector (384 dimensions) is computed using `all-MiniLM-L6-v2`
3. The new video is compared against all existing memories:
   - **Cosine similarity** between embedding vectors (semantic meaning)
   - **Entity overlap** using Jaccard similarity (shared proper nouns)
   - **Combined score** = `0.7 × cosine + 0.3 × entity_overlap`
4. Edges above threshold (0.2) are stored in IndexedDB
5. The graph visualization renders these edges as glowing connections

## Privacy

All processing happens locally in your browser:
- No data is sent to any external server
- No API keys required
- Embeddings are computed locally via WebAssembly
- Data is stored in IndexedDB (browser-local)

## Tech Stack

- **Chrome Extension Manifest V3** — Service worker architecture
- **IndexedDB** — Client-side structured storage
- **Transformers.js** — Hugging Face's JS port for local ML inference
- **all-MiniLM-L6-v2** — Sentence transformer model (~23MB, cached after first load)
- **Canvas 2D** — Custom 3D projection engine for the neuron graph
- **Pure JavaScript** — No frameworks, no build step

## License

MIT
