# SillyTavern UwU Memory Plugin

> **LanceDB Server Plugin** - Vector database backend for the UwU Memory extension.

This plugin provides LanceDB vector database support for semantic memory search, enabling intelligent retrieval of relevant memories based on conversation context.

## Overview

The UwU Memory Plugin is a **server-side component** that runs within SillyTavern's plugin system. It handles:

- Vector storage and retrieval using LanceDB
- Embedding-based similarity search
- Collection management per chat/character
- Data persistence on disk

## Installation

### Prerequisites

1. **Enable server plugins** in your `config.yaml`:
   ```yaml
   enableServerPlugins: true
   ```

2. **Install the main extension first**: [SillyTavern-UwU-Memory](https://github.com/ICSLI/SillyTavern-UwU-Memory) (main branch)

### Install via Git (Recommended)

```bash
# Navigate to SillyTavern plugins folder
cd SillyTavern/plugins/

# Clone the Plugin branch
git clone -b Plugin https://github.com/ICSLI/SillyTavern-UwU-Memory.git uwu-memory

# Install dependencies
cd uwu-memory
npm install
```

### Verify Installation

1. Restart SillyTavern
2. Check server console for `[uwu-memory] Plugin loaded` message
3. In extension panel, verify backend status shows green indicator

## File Structure

```
SillyTavern/plugins/uwu-memory/
├── index.js        # Plugin code (Express routes)
├── package.json    # Dependencies
└── db/             # LanceDB data storage (auto-created)
    └── [collections]/
```

## API Endpoints

All endpoints use the prefix `/api/plugins/uwu-memory/`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Check backend status |
| `/insert` | POST | Store new memories with embeddings |
| `/query` | POST | Vector similarity search |
| `/list` | POST | List all hashes in a collection |
| `/delete` | POST | Delete memories by hash |
| `/purge` | POST | Delete entire collection |
| `/getByHashes` | POST | Retrieve specific memories |
| `/stats` | POST | Get collection statistics |

## Extension Connection

This plugin integrates with the **UwU Memory extension** through standardized REST endpoints. The extension handles:

- Summary generation and UI
- Local storage management
- Embedding generation (via SillyTavern's embedding API)

The plugin handles:

- Vector storage (LanceDB)
- Similarity search
- Collection lifecycle

## Troubleshooting

### Plugin not loading

1. Check `enableServerPlugins: true` in config.yaml
2. Verify folder is named `uwu-memory` (not `SillyTavern-UwU-Memory`)
3. Check server console for error messages

### Dependencies error

```bash
cd SillyTavern/plugins/uwu-memory
rm -rf node_modules
npm install
```

### Database issues

The `db/` folder contains all vector data. To reset:
```bash
rm -rf SillyTavern/plugins/uwu-memory/db
```

## Related

- **Main Extension**: [github.com/ICSLI/SillyTavern-UwU-Memory](https://github.com/ICSLI/SillyTavern-UwU-Memory) (main branch)
- **Full Documentation**: See main extension README for complete usage guide

## License

MIT License - See [LICENSE](LICENSE) for details.
