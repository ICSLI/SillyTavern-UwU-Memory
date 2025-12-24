# SillyTavern UwU Memory

Auto-summarize past messages with RAG-based retrieval for unlimited context memory in SillyTavern.

## Features

- **Automatic Summarization**: Summarizes older messages to free up context window
- **RAG-based Retrieval**: Retrieves relevant summaries using vector similarity search
- **Multiple Backends**: Supports Vectra (built-in) and LanceDB
- **ChatML Format**: Uses structured prompts for better summary quality
- **Customizable Templates**: Configure summary prompts and memory templates
- **Message Sync**: Auto-updates summaries when messages are edited/deleted

## Installation

1. Clone/download this repository
2. Place in: `SillyTavern/public/scripts/extensions/third-party/SillyTavern-UwU-Memory/`
3. Restart SillyTavern
4. Enable in Extensions menu

## How to Use

1. Open Extensions panel -> UwU Memory
2. Enable the extension
3. Configure settings:
   - **Protected Turns**: Number of recent messages to keep unsummarized
   - **Context Window**: Messages to include in summary context
   - **Max Retrieved**: Maximum summaries to inject
4. Add `{{summarizedMemory}}` to your prompt template

## Settings Explained

| Setting | Description |
|---------|-------------|
| Protected Turns | Recent messages that won't be summarized |
| Context Window | Previous messages included when generating summary |
| Max Retrieved | Maximum summaries returned for context |
| Score Threshold | Minimum similarity score for retrieval |
| Skip User Turns | Only summarize character messages |

## Troubleshooting

- **Summaries not appearing**: Check if `{{summarizedMemory}}` is in your prompt
- **Empty macro**: Run `window.uwuMemoryDebug.testMacro()` in console
- **Sync issues**: Use "Sync Storage" in debug tools

## Debug Tools

Access debug functions in browser console:
```javascript
// Check macro value
window.uwuMemoryDebug.getMacroValue()

// Test macro function
window.uwuMemoryDebug.testMacro()

// Force update from cache
window.uwuMemoryDebug.forceUpdateFromCache()

// Get summarized message IDs
window.uwuMemoryDebug.getSummarizedIds()

// Sync storage with backend
window.uwuMemoryDebug.syncStorage()
```

## Credits

Part of the SillyTavern UwU series.

## License

MIT License
