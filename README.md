# UwU Memory - LanceDB Server Plugin

> **Vector Storage Backend** - High-performance semantic search for UwU Memory extension using LanceDB.

This plugin provides the server-side vector database functionality for the [UwU Memory extension](https://github.com/ICSLI/SillyTavern-UwU-Memory). It enables intelligent memory retrieval through semantic similarity search.

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Technical Details](#technical-details)

---

## Overview

### What This Plugin Does

The UwU Memory LanceDB Plugin provides:

- **Vector Storage**: Stores memory embeddings in LanceDB for fast similarity search
- **Semantic Search**: Finds relevant memories based on meaning, not just keywords
- **User Isolation**: Separate databases per user for multi-user setups
- **Local Embeddings**: Uses SillyTavern's built-in Transformers (no external API required)

### Without This Plugin

The UwU Memory extension will work in **fallback mode**:
- Only recent memories are retrieved (no semantic search)
- Memories still persist locally in browser storage
- Basic functionality preserved, but intelligent retrieval disabled

### With This Plugin

Full RAG (Retrieval-Augmented Generation) capabilities:
- Semantic similarity search across all memories
- Relevant memories retrieved based on current conversation context
- Optimized performance for large memory collections

---

## Requirements

- **SillyTavern**: Version 1.12.0 or later
- **Node.js**: Version 18.0 or later
- **Server Plugins Enabled**: Must be enabled in SillyTavern config

---

## Installation

### Step 1: Enable Server Plugins

Edit your SillyTavern `config.yaml` file:

```yaml
enableServerPlugins: true
```

> **Location**: The `config.yaml` is in your SillyTavern root directory.

### Step 2: Install the Plugin

#### Method A: Git Clone (Recommended)

```bash
# Navigate to SillyTavern plugins folder
cd SillyTavern/plugins/

# Clone the Plugin branch
git clone -b Plugin https://github.com/ICSLI/SillyTavern-UwU-Memory.git uwu-memory

# Install dependencies
cd uwu-memory
npm install
```

#### Method B: Manual Download

1. Download the Plugin branch as ZIP from [GitHub](https://github.com/ICSLI/SillyTavern-UwU-Memory/tree/Plugin)
2. Extract to `SillyTavern/plugins/uwu-memory/`
3. Run `npm install` in the plugin folder

### Step 3: Restart SillyTavern

After installation, restart SillyTavern. You should see in the console:

```
[uwu-memory] Plugin loaded successfully
```

### Step 4: Verify Connection

In the UwU Memory extension settings, check the backend status indicator:
- **Green**: LanceDB connected and healthy
- **Yellow**: Fallback mode (plugin not connected)

---

## Configuration

### Plugin Configuration

The plugin works out of the box with no configuration required. It automatically:

- Creates database files in `plugins/uwu-memory/db/`
- Uses user authentication from SillyTavern
- Generates embeddings using SillyTavern's built-in Transformers (local ONNX model)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA FLOW                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Extension]                           [Plugin]                  │
│       │                                    │                     │
│       │── POST /insert ──────────────────►│                     │
│       │   {text, hash, index}              │                     │
│       │                                    ▼                     │
│       │                           [Generate Embedding]           │
│       │                                    │                     │
│       │                                    ▼                     │
│       │                           [Store in LanceDB]             │
│       │                                    │                     │
│       │◄── {success: true} ───────────────│                     │
│       │                                                          │
│       │── POST /query ───────────────────►│                     │
│       │   {queryText, topK, threshold}     │                     │
│       │                                    ▼                     │
│       │                           [Generate Query Embedding]     │
│       │                                    │                     │
│       │                                    ▼                     │
│       │                           [Vector Similarity Search]     │
│       │                                    │                     │
│       │◄── {results: [...]} ──────────────│                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Storage Structure

```
plugins/uwu-memory/
├── index.js          # Plugin code
├── package.json      # Dependencies
├── README.md         # This file
└── db/               # Database directory (auto-created)
    └── {user_id}/    # Per-user database
        └── um_{collection_id}.lance/  # LanceDB table files
```

---

## API Reference

All endpoints are prefixed with `/api/plugins/uwu-memory/`.

### Health Check

```
GET /health
```

Returns plugin status.

**Response:**
```json
{
  "status": "ok",
  "backend": "lancedb"
}
```

### Insert Memories

```
POST /insert
```

Store new memories with embeddings.

**Request Body:**
```json
{
  "collectionId": "ctx_sum_c123_abc456",
  "items": [
    {
      "hash": "unique_hash",
      "text": "Memory content",
      "index": 5,
      "metadata": {}
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 1
}
```

### Query Memories

```
POST /query
```

Search for similar memories.

**Request Body:**
```json
{
  "collectionId": "ctx_sum_c123_abc456",
  "queryText": "What happened in the forest?",
  "topK": 10,
  "threshold": 0.5
}
```

**Response:**
```json
{
  "results": [
    {
      "hash": "abc123",
      "text": "They explored the dark forest...",
      "index": 12,
      "score": 0.85,
      "metadata": {}
    }
  ]
}
```

### List Hashes

```
POST /list
```

Get all memory hashes in a collection.

**Response:**
```json
{
  "hashes": ["hash1", "hash2", "hash3"]
}
```

### Delete Memories

```
POST /delete
```

Remove specific memories by hash.

**Request Body:**
```json
{
  "collectionId": "ctx_sum_c123_abc456",
  "hashes": ["hash1", "hash2"]
}
```

### Purge Collection

```
POST /purge
```

Delete entire collection.

### Get by Hashes

```
POST /getByHashes
```

Retrieve specific memories by their hashes.

### Copy Collection

```
POST /copy
```

Copy memories from one collection to another with vector preservation.

**Request Body:**
```json
{
  "sourceCollectionId": "ctx_sum_c123_abc456",
  "targetCollectionId": "ctx_sum_c123_def789",
  "hashes": ["hash1", "hash2"]
}
```

**Notes:**
- If `hashes` is omitted or empty, all memories are copied
- Vectors are preserved (no re-embedding required)
- Used for chat branching and migration

**Response:**
```json
{
  "success": true,
  "copied": 10
}
```

### Statistics

```
POST /stats
```

Get collection statistics.

**Response:**
```json
{
  "count": 150,
  "collectionId": "ctx_sum_c123_abc456"
}
```

---

## Troubleshooting

### Plugin Not Loading

**Symptoms:**
- No `[uwu-memory]` messages in server console
- Extension shows yellow/fallback status

**Solutions:**
1. Verify `enableServerPlugins: true` in `config.yaml`
2. Check plugin folder structure:
   ```
   plugins/uwu-memory/
   ├── index.js      (required)
   └── package.json  (required)
   ```
3. Run `npm install` in plugin folder
4. Restart SillyTavern

### Dependency Installation Failed

**Error:** `npm install` fails

**Solutions:**
1. Ensure Node.js 18+ is installed: `node --version`
2. Clear npm cache: `npm cache clean --force`
3. Try reinstalling:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

### LanceDB Connection Issues

**Error:** `Failed to connect to LanceDB`

**Solutions:**
1. Check disk space (LanceDB needs write access)
2. Verify `db/` folder permissions
3. Check for corrupted database files:
   ```bash
   rm -rf plugins/uwu-memory/db/
   # Restart SillyTavern - databases will be recreated
   ```

### Memory Search Not Working

**Symptoms:**
- Memories stored but not retrieved
- Always getting fallback results

**Solutions:**
1. Lower the score threshold in extension settings
2. Run sync from extension: `window.uwuMemoryDebug.syncUnvectorized()`
3. Verify backend is healthy: `window.uwuMemoryDebug.getBackendHealth()`

### High Memory Usage

**Symptoms:**
- Server using excessive RAM
- Slow response times

**Solutions:**
1. LanceDB is optimized for disk-based storage
2. Large collections may need more memory during queries
3. Consider increasing server RAM for very large collections (10,000+ memories)

---

## Technical Details

### Database Schema

Each memory is stored with the following schema:

| Field | Type | Description |
|-------|------|-------------|
| `hash` | string | Unique identifier |
| `text` | string | Memory content |
| `index` | number | Turn index in conversation |
| `vector` | float[] | Embedding vector |
| `metadata` | string | JSON metadata |

### Embedding Dimensions

The plugin uses SillyTavern's built-in Transformers model which generates **384-dimensional** embeddings. This is a local ONNX model that requires no external API or configuration.

### Security Features

- **User Isolation**: Each user's data stored in separate database
- **Path Traversal Prevention**: User IDs sanitized before database access
- **SQL Injection Prevention**: Filter values escaped in queries

---

## License

MIT License - See LICENSE file for details.

---

## Related

- **Main Extension**: [SillyTavern-UwU-Memory](https://github.com/ICSLI/SillyTavern-UwU-Memory)
- **Author**: ICSLI
