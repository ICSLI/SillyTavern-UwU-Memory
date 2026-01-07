# 🧠 SillyTavern UwU Memory

> **Intelligent Memory Extension** - Automatic message summarization with RAG-based retrieval for unlimited context memory in SillyTavern.

UwU Memory solves the fundamental context window limitation in AI conversations by automatically summarizing older messages and intelligently retrieving relevant memories when needed.

## Table of Contents

- [📋 Overview](#-overview)
- [⚙️ How It Works](#%EF%B8%8F-how-it-works)
- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🎛️ Configuration Guide](#%EF%B8%8F-configuration-guide)
- [📖 Usage Guide](#-usage-guide)
- [🗂️ Memory Management](#%EF%B8%8F-memory-management)
- [🚀 Advanced Features](#-advanced-features)
- [🔧 Troubleshooting](#-troubleshooting)
- [🛠️ Debug Tools](#%EF%B8%8F-debug-tools)
- [🏗️ Technical Architecture](#%EF%B8%8F-technical-architecture)

---

## 📋 Overview

### ❌ The Problem

AI models have limited context windows. As conversations grow longer, older messages get pushed out, causing the AI to "forget" important details, character developments, and plot points.

### ✅ The Solution

UwU Memory automatically:
1. **Summarizes** older messages into concise memory snippets
2. **Stores** these summaries with vector embeddings for semantic search
3. **Retrieves** relevant memories based on the current conversation context
4. **Injects** them into the prompt, giving the AI access to long-term memory

### 💡 Key Benefits

- **Unlimited Conversation Length**: Never lose important context again
- **Intelligent Retrieval**: Only relevant memories are injected, not everything
- **Automatic Operation**: Set it and forget it - works in the background
- **Dual Storage**: Memories persist both locally and in vector database
- **Graceful Degradation**: Works even if the backend is unavailable

---

## ⚙️ How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     MESSAGE FLOW                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [New Message] ──► [Check Threshold] ──► [Generate Summary]     │
│                          │                       │              │
│                          ▼                       ▼              │
│                    Skip if recent          [Store Memory]       │
│                                                  │              │
│                                    ┌─────────────┴─────────────┐│
│                                    ▼                           ▼│
│                           [Local Storage]            [LanceDB] ││
│                           (Persistent)               (Vectors) ││
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                     RETRIEVAL FLOW                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Generation Start] ──► [Build Query] ──► [Vector Search]       │
│                              │                   │              │
│                              ▼                   ▼              │
│                     Recent messages      [Relevant Memories]    │
│                                                  │              │
│                                                  ▼              │
│                                    [Format & Inject via Macro]  │
│                                                  │              │
│                                                  ▼              │
│                                      {{summarizedMemory}}       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Summarization Process

1. **Threshold Check**: Only starts summarizing after `minTurnToStartSummary` messages
2. **Protection Zone**: Recent N messages are never summarized (configurable)
3. **Context Building**: Includes surrounding messages for better summary quality
4. **AI Generation**: Uses your configured API to generate concise summaries
5. **Dual Storage**: Saves to both local storage (persistence) and LanceDB (search)

### Retrieval Process

1. **Query Building**: Combines recent messages to understand current context
2. **Vector Search**: Finds semantically similar memories using embeddings
3. **Score Filtering**: Only includes memories above the similarity threshold
4. **Recent Guarantee**: Always includes the N most recent memories
5. **Template Formatting**: Applies your custom template to each memory
6. **Macro Injection**: Makes memories available via `{{summarizedMemory}}`

---

## ✨ Features

### Core Features

| Feature | Description |
|---------|-------------|
| **Auto-Summarization** | Automatically summarizes messages beyond the protection zone |
| **RAG Retrieval** | Semantic search finds relevant memories, not just recent ones |
| **Dual Storage** | Local persistence + vector database for reliability |
| **Fallback Mode** | Works with recent memories only if backend is unavailable |
| **Edit Sync** | Automatically re-summarizes when messages are edited |
| **Delete Sync** | Removes memories when source messages are deleted |
| **Branch Support** | Automatically copies memories when creating chat branches |
| **Rename Support** | Automatically migrates memories when renaming chats |
| **Group Chat Support** | Full support for group conversations |

### UI Features

- **Memory Management Popup**: View, edit, regenerate, and delete individual memories
- **Global Memory Browser**: Browse all collections across characters
- **Statistics Dashboard**: View memory counts, storage usage, and health status
- **Batch Operations**: Regenerate all summaries with progress tracking
- **Real-time Status**: See pending summaries and cache status

---

## 📦 Installation

### Step 1: Install the Extension (Required)

#### Method A: Install Extension Button (Recommended)

The easiest way to install the extension using SillyTavern's built-in extension installer:

1. Open SillyTavern
2. Go to **Extensions** panel (puzzle piece icon)
3. Click **Install Extension** button
4. Enter the repository URL:
   ```
   https://github.com/ICSLI/SillyTavern-UwU-Memory
   ```
5. Click **Save** and wait for installation to complete
6. Refresh the page if prompted

#### Method B: Manual Installation (Git Clone)

For advanced users or if you prefer manual installation:

```bash
# Navigate to SillyTavern extensions folder
cd SillyTavern/public/scripts/extensions/third-party/

# Clone the repository
git clone https://github.com/ICSLI/SillyTavern-UwU-Memory.git
```

### Step 2: Install the LanceDB Plugin (Recommended)

The LanceDB plugin enables vector search for intelligent memory retrieval. The plugin is maintained on a separate branch of this repository.

> **Note**: This plugin is **optional**. Without it, the extension will work in fallback mode (recent memories only, no semantic search).

**Prerequisites**: Enable server plugins in your `config.yaml`:
```yaml
enableServerPlugins: true
```

**Install via Git**:
```bash
# Navigate to SillyTavern plugins folder
cd SillyTavern/plugins/

# Clone the Plugin branch directly
git clone -b Plugin https://github.com/ICSLI/SillyTavern-UwU-Memory.git uwu-memory

# Install dependencies
cd uwu-memory
npm install
```

> **Tip**: For detailed plugin installation instructions, see the [Plugin README](https://github.com/ICSLI/SillyTavern-UwU-Memory/tree/Plugin).

**Plugin Structure:**
```
SillyTavern/plugins/uwu-memory/
├── index.js      # Plugin code
├── package.json  # Dependencies
└── db/           # LanceDB data (auto-created)
```

### Step 3: Restart and Enable

1. Restart SillyTavern
2. Go to **Extensions** panel
3. Find **UwU Memory** and enable it
4. Check the backend status indicator (green = LanceDB connected)

---

## 🎛️ Configuration Guide

### Essential Settings

#### Summarization Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Protected Turns** | 10 | Messages to keep unsummarized. Higher = more recent context, lower = more memories |
| **Context Window** | 3 | Messages included when generating summary. Higher = better context, slower generation |
| **Skip User Turns** | On | Only summarize character messages. Recommended for most use cases |

#### Retrieval Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Max Retrieved** | 10 | Maximum memories to inject. Balance between context and token usage |
| **Always Include Recent** | 3 | Guarantee recent N memories are always included |
| **Score Threshold** | 0.5 | Minimum similarity score (0-1). Lower = more memories, potentially less relevant |

#### Connection Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Connection Profile** | Auto | Which API profile to use for summarization |
| **Max Tokens** | 300 | Maximum tokens for each summary |

### Recommended Configurations

#### For Long Roleplay Sessions
```
Protected Turns: 15
Context Window: 5
Max Retrieved: 15
Score Threshold: 0.4
Skip User Turns: On
```

#### For Information-Dense Conversations
```
Protected Turns: 5
Context Window: 3
Max Retrieved: 20
Score Threshold: 0.6
Skip User Turns: Off
```

#### For Resource-Constrained Systems
```
Protected Turns: 20
Context Window: 2
Max Retrieved: 5
Score Threshold: 0.7
Skip User Turns: On
```

---

## 📖 Usage Guide

### Basic Setup

1. **Add the Macro to Your Prompt**

   In your character card or system prompt, add:
   ```
   {{summarizedMemory}}
   ```

   **Example placement:**
   ```
   [System]
   You are {{char}}, a friendly AI assistant.

   [Relevant Memories]
   {{summarizedMemory}}

   [Current Conversation]
   ```

2. **Start Chatting**

   After the conversation exceeds the protected turn threshold, summaries will automatically generate.

3. **Monitor Status**

   Check the UwU Memory panel for:
   - Backend status (green/yellow indicator)
   - Pending summaries count
   - Cached memories count

### Customizing the Summary Prompt

The summary prompt uses Handlebars templating:

```handlebars
<|im_start|>system
You are a summarization assistant. Create concise summaries focusing on key information.
<|im_end|>
<|im_start|>user
{{#if context}}
[Previous Context]
{{context}}

{{/if}}
[Target Message - Turn {{targetTurn}} by {{speaker}}]
{{targetMessage}}

Summarize in 1-2 sentences, focusing on {{user}} and {{char}}'s interaction.
<|im_end|>
<|im_start|>assistant
```

**Available Variables:**
- `{{context}}` - Previous messages for context
- `{{targetTurn}}` - Turn number being summarized
- `{{targetMessage}}` - The message content
- `{{speaker}}` - Who sent the message (user/char name)
- `{{user}}` - User's name
- `{{char}}` - Character's name

### Customizing the Memory Template

Format how memories appear in your prompt:

```
[Memory {{index}}, Turn {{turnIndex}}]
{{content}}
```

**Available Variables:**
- `{{index}}` - Memory number (1, 2, 3...)
- `{{turnIndex}}` - Original turn number in conversation
- `{{content}}` - The summary text
- `{{score}}` - Similarity score (if from search)

---

## 🗂️ Memory Management

### Accessing Memory Management

1. **From Settings Panel**: Click "Manage Memories" button
2. **From Chat Menu**: Click the brain icon in the hamburger menu (☰)

### Memory Operations

| Operation | Description |
|-----------|-------------|
| **View** | See all memories for current chat |
| **Edit** | Manually edit a summary |
| **Regenerate** | Re-generate summary from original message |
| **Delete** | Remove a specific memory |
| **Batch Regenerate** | Regenerate all summaries |
| **Purge** | Delete all memories for current chat |

### Global Memory Browser

Access memories across all characters:

1. Click "Global Memory Management" in settings
2. Browse collections by character
3. View statistics and storage usage
4. Manage memories across all chats

---

## 🚀 Advanced Features

### Fallback Mode

When LanceDB is unavailable, UwU Memory automatically switches to fallback mode:

- Uses only recent memories (no semantic search)
- Memories still persist locally
- Re-syncs with backend when connection restored

### Branch & Rename Support

UwU Memory automatically handles chat branching and renaming:

**Chat Branching:**
- When you create a branch from a message, memories are automatically copied
- If branching from a past message, only memories up to that point are copied
- If branching from the latest message, all memories are copied
- Copied memories are filtered by `minTurnsToStart` setting at retrieval time

**Chat Renaming:**
- When you rename a chat, memories are automatically migrated to the new collection
- Original collection is deleted after successful migration (move operation)
- Both local storage and vector database are updated

**Turn Validation:**
- Memories are filtered at retrieval time based on current chat length
- Formula: `maxValidTurnIndex = currentTurnCount - minTurnsToStart`
- This handles edge cases like bulk message deletion gracefully

### Automatic Sync

The extension maintains consistency between:
- Local storage (browser)
- Vector database (LanceDB)

**Sync Operations:**
- **On Edit**: Re-generates and updates summary
- **On Delete**: Removes memory from both storages
- **On Chat Switch**: Hydrates cache from backend
- **On Backend Recovery**: Syncs unvectorized memories
- **On Branch**: Copies memories up to branch point
- **On Rename**: Migrates all memories to new collection

### Debug Mode

Access comprehensive debugging tools:

```javascript
// In browser console
window.uwuMemoryDebug.testRAG()  // Full RAG pipeline test
```

This shows:
- Backend health status
- Collection information
- Summary counts
- Vector search results
- Query text used

---

## 🔧 Troubleshooting

### Common Issues

#### "Summaries not appearing in prompt"

1. **Check macro placement**: Ensure `{{summarizedMemory}}` is in your prompt
2. **Verify macro works**: Run `window.uwuMemoryDebug.testMacro()` in console
3. **Check if memories exist**: Open Memory Management popup

#### "Backend shows yellow/fallback mode"

1. **Check plugin installation**: Ensure `plugins/uwu-memory/index.js` exists
2. **Check dependencies**: Run `npm install @lancedb/lancedb` in plugin folder
3. **Check server logs**: Look for `[uwu-memory]` messages on startup

#### "Summaries not generating"

1. **Check threshold**: Need more messages than "Protected Turns" setting
2. **Check API connection**: Ensure your summarization API is working
3. **Check pending count**: Look at "Pending" indicator in status bar

#### "Vector search returning no results"

1. **Run sync**: `window.uwuMemoryDebug.syncUnvectorized()`
2. **Check embeddings**: Ensure embedding source is configured
3. **Lower threshold**: Try reducing "Score Threshold" setting

### Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "LanceDB not available" | Plugin not installed/loaded | Install plugin and restart |
| "Embedding API error" | API key invalid or service down | Check API configuration |
| "Failed to generate summary" | Summarization API failed | Check connection profile |

---

## 🛠️ Debug Tools

### Console Commands

```javascript
// === Status Checks ===
window.uwuMemoryDebug.getBackendHealth()     // Backend status
window.uwuMemoryDebug.getCollectionId()       // Current collection ID
window.uwuMemoryDebug.getSettings()           // Current settings

// === Memory Inspection ===
window.uwuMemoryDebug.getMacroValue()         // Current macro content
window.uwuMemoryDebug.getMemoryCache()        // Cached memories
window.uwuMemoryDebug.getPersistentData()     // Local storage data
window.uwuMemoryDebug.getSummarizedIds()      // All summarized message IDs
window.uwuMemoryDebug.listBackendHashes()     // Hashes in vector DB

// === Testing ===
window.uwuMemoryDebug.testMacro()             // Test macro function
window.uwuMemoryDebug.testRAG()               // Full RAG pipeline test

// === RAG Query Debugging ===
window.uwuMemoryDebug.queryRAG(query, limit)  // Custom query search (limit: default 10)
window.uwuMemoryDebug.searchRAG(displayLimit) // System search using last message (displayLimit: default all)

// === Manual Operations ===
window.uwuMemoryDebug.forceHydrate()          // Reload cache from backend
window.uwuMemoryDebug.forcePrepare()          // Force memory preparation
window.uwuMemoryDebug.forceUpdateFromCache()  // Update macro from cache
window.uwuMemoryDebug.syncStorage()           // Sync with backend
window.uwuMemoryDebug.syncUnvectorized()      // Push unvectorized to backend
```

### Understanding testRAG Output

```javascript
=== RAG Debug ===
1. Backend healthy: true                    // LanceDB connection status
2. Collection ID: ctx_sum_c123_abc456       // Current chat's collection
3. Chat length: 50                          // Messages in current chat
4. Summaries in persistent storage: 35      // Local memory count
5. Hashes in backend (LanceDB): 35          // Vector DB count
6. Query text: "Recent conversation..."     // What's being searched
7. Vector search results: 8                 // Matching memories found
```

---

## 🏗️ Technical Architecture

### File Structure

```
SillyTavern/
├── plugins/uwu-memory/
│   └── index.js                 # LanceDB server plugin (Express routes)
│
└── public/scripts/extensions/third-party/SillyTavern-UwU-Memory/
    ├── index.js                 # Main extension logic
    ├── manifest.json            # Extension metadata
    ├── style.css                # UI styles
    ├── backends/
    │   ├── backend-interface.js # Abstract backend interface
    │   └── lancedb-backend.js   # LanceDB client implementation
    └── utils/
        ├── async-utils.js       # Async utilities, mutex
        ├── lru-cache.js         # LRU cache implementation
        └── popup-manager.js     # UI popup management
```

### Data Flow

```
[Extension (Browser)]                    [Plugin (Server)]
        │                                       │
        │──── /api/plugins/uwu-memory/insert ──►│
        │◄─── Response ────────────────────────│
        │                                       │
        │──── /api/plugins/uwu-memory/query ───►│
        │◄─── Results ─────────────────────────│
        │                                       │
        ▼                                       ▼
[Local Storage]                          [LanceDB Files]
(extension_settings)                     (plugins/uwu-memory/db/)
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Check backend status |
| `/insert` | POST | Store new memories |
| `/query` | POST | Vector similarity search |
| `/list` | POST | List all hashes in collection |
| `/delete` | POST | Delete memories by hash |
| `/purge` | POST | Delete entire collection |
| `/getByHashes` | POST | Get specific memories |
| `/stats` | POST | Get collection statistics |
| `/copy` | POST | Copy memories between collections |

### Storage Schema

**Local Storage** (extension_settings['uwu-memory'].memoryData):
```javascript
{
  "ctx_sum_c123_abc456": {
    "hash1": {
      "msgId": "msg_001",
      "summary": "Character expressed concern about...",
      "turnIndex": 5,
      "contentHash": "abc123",
      "createdAt": 1703001234567
    }
  }
}
```

**LanceDB Schema**:
```javascript
{
  hash: string,      // Unique identifier
  text: string,      // Summary content
  index: number,     // Turn index
  vector: number[],  // Embedding vector (384 dims for transformers)
  metadata: string   // JSON metadata
}
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Development Setup

1. Clone the repository
2. Make changes to the source files
3. Test with SillyTavern
4. Submit a pull request

---

## 📄 License

MIT License - See LICENSE file for details.

---

## 👤 Credits

- **Author**: ICSLI
- **Repository**: [GitHub](https://github.com/ICSLI/SillyTavern-UwU-Memory)

Part of the SillyTavern UwU extension series.
