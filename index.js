/**
 * UwU Memory - SillyTavern Extension
 * Auto-summarize past messages with RAG-based retrieval
 */

import { getContext } from '../../../st-context.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { MacrosParser } from '../../../macros.js';
import { LRUCache } from './utils/lru-cache.js';
import { debounce, calculateHash, sleep, retry, waitUntilCondition, AsyncMutex } from './utils/async-utils.js';
import { showBatchRegeneratePopup, showMemoryManagementPopup, showStatsPopup, showGlobalMemoryManagementPopup } from './utils/popup-manager.js';
import { LanceDBBackend } from './backends/lancedb-backend.js';

// Constants
const MODULE_NAME = 'uwu-memory';
const COLLECTION_PREFIX = 'ctx_sum_';
const DEBOUNCE_DELAY = 1500;
const HASH_CACHE_SIZE = 10000;
const METADATA_CACHE_SIZE = 5000; // Limit metadata cache size
const BACKEND_RECONNECT_INTERVAL = 30000; // 30 seconds

// State
let settings = null;
let backend = null;
let backendHealthy = false; // Track backend health for fallback logic
const syncMutex = new AsyncMutex(); // Mutex for preventing race conditions in sync operations
const hashCache = new LRUCache(HASH_CACHE_SIZE);
const pendingSummaries = new Set(); // msgIds currently being summarized
const memoryMetadataCache = new LRUCache(METADATA_CACHE_SIZE); // LRU cache for metadata
let currentFormattedMemory = ''; // Current formatted memory for macro injection
let isPreparingMemory = false; // Flag to prevent re-entry
let lastHydratedCollectionId = null; // Track which collection is currently hydrated

// Resource cleanup tracking
let statusUpdateInterval = null; // setInterval ID for status updates
let backendReconnectInterval = null; // setInterval ID for backend reconnection
let registeredEventHandlers = []; // Track registered event handlers for cleanup

// Default settings
const defaultSettings = {
    // Persistent metadata storage (keyed by collectionId -> hash -> metadata)
    // This ensures metadata survives page refresh since backend query may not return text
    memoryData: {},

    // Summarization settings
    minTurnToStartSummary: 10,
    contextWindowForSummary: 3,
    // ChatML format prompt - supports system/user/assistant roles
    summaryPrompt: `<|im_start|>system
You are a summarization assistant. Your task is to create concise summaries of conversation turns. Focus on key information, emotions, actions, and events.
<|im_end|>
<|im_start|>user
{{#if context}}
[Previous Context]
{{context}}

{{/if}}
[Target Message - Turn {{targetTurn}} by {{speaker}}]
{{targetMessage}}

Summarize this message in 1-2 sentences, focusing on what's relevant to {{user}} and {{char}}'s interaction.
<|im_end|>
<|im_start|>assistant
`,
    contextFormat: {
        user: '{{user}}',
        char: '{{char}}',
        separator: ': ',
    },

    // ChatML / Connection settings
    useChatML: true,
    connectionProfile: '', // Will use default if empty
    summaryMaxTokens: 300,

    // Search settings
    maxRetrievedSummaries: 10,
    alwaysIncludeRecentN: 3,
    scoreThreshold: 0.5,

    // Injection settings
    injectionVariable: 'summarizedMemory',
    memoryTemplate: '[Memory {{index}}, Turn {{turnIndex}}]\n{{content}}',
    memorySeparator: '\n\n---\n\n',

    // Behavior settings
    autoResummarizeOnEdit: true,
    deleteMemoryOnMsgDelete: true,
    skipUserTurns: true,

    // Performance settings
    batchSize: 5,
    batchDelayMs: 500,
};

/**
 * Migrate settings from old extension name (context-summarizer) to new (uwu-memory)
 */
function migrateSettings() {
    const oldKey = 'context-summarizer';
    const newKey = 'uwu-memory';

    if (extension_settings[oldKey] && !extension_settings[newKey]) {
        extension_settings[newKey] = extension_settings[oldKey];
        delete extension_settings[oldKey];
        const context = getContext();
        context.saveSettingsDebounced();
        console.log('[UwU Memory] Settings migrated from context-summarizer');
    }
}

/**
 * Initialize extension settings
 */
function initSettings() {
    // Migrate from old extension name first
    migrateSettings();

    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }

    settings = {
        ...defaultSettings,
        ...extension_settings[MODULE_NAME],
        contextFormat: {
            ...defaultSettings.contextFormat,
            ...(extension_settings[MODULE_NAME].contextFormat || {}),
        },
        // Preserve memoryData from storage (don't merge with defaults)
        memoryData: extension_settings[MODULE_NAME].memoryData || {},
    };
}

/**
 * Save settings
 */
function saveSettings() {
    extension_settings[MODULE_NAME] = { ...settings };
    const context = getContext();
    context.saveSettingsDebounced();
}

/**
 * Save metadata to persistent storage
 * @param {string} collectionId - Collection ID
 * @param {string} hash - Memory hash
 * @param {object} metadata - Metadata object
 */
function saveMetadataPersistent(collectionId, hash, metadata) {
    if (!settings.memoryData) {
        settings.memoryData = {};
    }
    if (!settings.memoryData[collectionId]) {
        settings.memoryData[collectionId] = {};
    }
    settings.memoryData[collectionId][hash] = metadata;
    saveSettings();
}

/**
 * Delete metadata from persistent storage
 * @param {string} collectionId - Collection ID
 * @param {string} hash - Memory hash
 */
function deleteMetadataPersistent(collectionId, hash) {
    if (settings.memoryData?.[collectionId]) {
        delete settings.memoryData[collectionId][hash];
        saveSettings();
    }
}

/**
 * Get all metadata for a collection from persistent storage
 * @param {string} collectionId - Collection ID
 * @returns {object} Hash -> metadata map
 */
function getCollectionMetadata(collectionId) {
    return settings.memoryData?.[collectionId] || {};
}

/**
 * Purge all metadata for a collection from persistent storage
 * @param {string} collectionId - Collection ID
 */
function purgeCollectionMetadata(collectionId) {
    if (settings.memoryData?.[collectionId]) {
        delete settings.memoryData[collectionId];
        saveSettings();
    }
}

/**
 * Initialize backend (LanceDB only)
 */
async function initBackend() {
    const context = getContext();

    backend = new LanceDBBackend(settings);

    if (backend.init) {
        backend.init(context.getRequestHeaders);
    }

    // Check backend health
    await checkBackendHealth();

    // Start periodic health check and reconnection (store interval ID for cleanup)
    startBackendReconnection();
}

/**
 * Check backend health and update status
 * @returns {Promise<boolean>} Whether backend is healthy
 */
async function checkBackendHealth() {
    try {
        const health = await backend.healthCheck();
        const wasHealthy = backendHealthy;
        backendHealthy = health.healthy;

        if (!backendHealthy) {
            console.warn(`[${MODULE_NAME}] LanceDB not available: ${health.message}. Using fallback mode (recent memories only, no semantic search).`);
        } else if (!wasHealthy && backendHealthy) {
            // Backend recovered - sync unvectorized data
            console.log(`[${MODULE_NAME}] LanceDB backend recovered, syncing unvectorized data...`);
            try {
                await syncUnvectorizedToBackend();
            } catch (syncError) {
                console.warn(`[${MODULE_NAME}] Failed to sync after recovery:`, syncError.message);
            }
        } else if (backendHealthy) {
            console.log(`[${MODULE_NAME}] LanceDB backend initialized and healthy`);
        }

        // Update UI if DOM is ready
        updateBackendStatusUI();
        return backendHealthy;
    } catch (error) {
        backendHealthy = false;
        console.warn(`[${MODULE_NAME}] Backend health check failed: ${error.message}. Using fallback mode.`);
        updateBackendStatusUI();
        return false;
    }
}

/**
 * Start periodic backend health check and reconnection
 */
function startBackendReconnection() {
    // Clear existing interval if any
    if (backendReconnectInterval) {
        clearInterval(backendReconnectInterval);
    }

    // Only run periodic checks if initially unhealthy
    // Once healthy, continue checking to detect disconnections
    backendReconnectInterval = setInterval(async () => {
        if (!backend) return;

        try {
            await checkBackendHealth();
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Periodic health check error:`, error.message);
        }
    }, BACKEND_RECONNECT_INTERVAL);
}

/**
 * Cleanup registered event handlers
 */
function cleanupEventHandlers() {
    for (const { eventSource, eventType, handler } of registeredEventHandlers) {
        try {
            eventSource.off(eventType, handler);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to remove event handler:`, error.message);
        }
    }
    registeredEventHandlers = [];
}

/**
 * Cleanup all resources (intervals, event handlers, etc.)
 * Called when extension is disabled or page unloads
 */
function cleanupResources() {
    console.log(`[${MODULE_NAME}] Cleaning up resources...`);

    // Clear intervals
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }

    if (backendReconnectInterval) {
        clearInterval(backendReconnectInterval);
        backendReconnectInterval = null;
    }

    // Clear event handlers
    cleanupEventHandlers();

    console.log(`[${MODULE_NAME}] Resources cleaned up`);
}

/**
 * Update backend status indicator in UI
 */
function updateBackendStatusUI() {
    const statusEl = $('#um-backend-status');
    if (!statusEl.length) return;

    if (backendHealthy) {
        statusEl.html('<i class="fa-solid fa-circle" style="color: var(--active, #4caf50);"></i> <span>LanceDB Connected</span>');
        statusEl.attr('title', 'Vector search enabled');
    } else {
        statusEl.html('<i class="fa-solid fa-circle" style="color: var(--warning, #ff9800);"></i> <span>Fallback Mode</span>');
        statusEl.attr('title', 'LanceDB unavailable. Using recent memories only (no semantic search). Install uwu-memory plugin for full functionality.');
    }
}

/**
 * Get recent memories from persistent storage (fallback when backend unavailable)
 * @param {string} collectionId - Collection ID
 * @param {number} limit - Max number of memories to return
 * @returns {Array} Recent memories sorted by turnIndex descending
 */
function getRecentMemoriesFromPersistent(collectionId, limit) {
    const data = settings.memoryData?.[collectionId] || {};
    const memories = [];

    for (const [hash, metadata] of Object.entries(data)) {
        if (!metadata || hash === '__collection_info__') continue;
        if (!metadata.summary) continue;

        memories.push({
            hash,
            text: metadata.summary,
            index: metadata.turnIndex || 0,
            score: 0, // No similarity score in fallback mode
            turnIndex: metadata.turnIndex || 0,
            msgId: metadata.msgId,
            createdAt: metadata.createdAt,
        });
    }

    // Sort by turnIndex descending (most recent first)
    memories.sort((a, b) => (b.turnIndex || 0) - (a.turnIndex || 0));

    return memories.slice(0, limit);
}

/**
 * Get collection ID for current chat (includes characterId for proper binding)
 * @returns {string|null}
 */
function getCollectionId() {
    const context = getContext();
    const chatId = context.getCurrentChatId();
    const characterId = context.characterId;

    if (!chatId) {
        return null;
    }

    // Include characterId for character-specific binding
    // For group chats, characterId may be undefined, so use 'group' prefix
    const charPrefix = characterId !== undefined ? `c${characterId}` : 'group';
    return `${COLLECTION_PREFIX}${charPrefix}_${calculateHash(chatId)}`;
}

/**
 * Get string hash with caching
 * @param {string} str - String to hash
 * @returns {string}
 */
function getStringHash(str) {
    const cached = hashCache.get(str);
    if (cached !== undefined) {
        return cached;
    }

    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

/**
 * Normalize message ID (send_date)
 * @param {object} message - Message object
 * @param {number|null} fallbackIndex - Fallback array index if send_date is unavailable
 * @returns {string}
 */
function normalizeMessageId(message, fallbackIndex = null) {
    const sendDate = message.send_date;

    if (typeof sendDate === 'number') {
        return String(sendDate);
    }

    if (typeof sendDate === 'string' && sendDate.trim()) {
        return sendDate;
    }

    // Fallback: use array index if provided (more stable than Date.now())
    if (fallbackIndex !== null) {
        return `idx_${fallbackIndex}`;
    }

    // Last resort: content hash (stable but may collide)
    if (message.mes) {
        return `hash_${getStringHash(message.mes)}`;
    }

    // Absolute fallback
    return String(Date.now());
}

/**
 * Build context from previous messages
 * @param {Array} chat - Chat array
 * @param {number} targetIndex - Target message index
 * @returns {string}
 */
function buildContext(chat, targetIndex) {
    if (settings.contextWindowForSummary <= 0) {
        return '';
    }

    const context = getContext();
    const startIndex = Math.max(0, targetIndex - settings.contextWindowForSummary);
    const contextMessages = [];

    for (let i = startIndex; i < targetIndex; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;

        let label = msg.is_user ? settings.contextFormat.user : settings.contextFormat.char;
        label = label.replace('{{user}}', context.name1).replace('{{char}}', context.name2);

        contextMessages.push(`${label}${settings.contextFormat.separator}${msg.mes}`);
    }

    return contextMessages.join('\n');
}

/**
 * Format summary prompt
 * @param {object} message - Target message
 * @param {string} contextText - Context string
 * @param {number} turnIndex - Turn index
 * @returns {string}
 */
function formatSummaryPrompt(message, contextText, turnIndex) {
    const context = getContext();

    // Determine speaker
    const speaker = message.is_user ? context.name1 : context.name2;

    let prompt = settings.summaryPrompt;
    prompt = prompt.replace('{{context}}', contextText);
    prompt = prompt.replace('{{targetMessage}}', message.mes);
    prompt = prompt.replace('{{targetTurn}}', String(turnIndex));
    prompt = prompt.replace('{{speaker}}', speaker);
    prompt = prompt.replace(/\{\{user\}\}/g, context.name1);
    prompt = prompt.replace(/\{\{char\}\}/g, context.name2);

    // Handle {{#if context}} blocks
    if (contextText) {
        prompt = prompt.replace(/\{\{#if context\}\}([\s\S]*?)\{\{\/if\}\}/g, '$1');
    } else {
        prompt = prompt.replace(/\{\{#if context\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    return prompt.trim();
}

/**
 * Parse ChatML format tags from prompt and convert to messages array.
 * Format: <|im_start|>role\ncontent<|im_end|>
 * Fallback: Returns single user message if no tags found.
 * @param {string} prompt - Prompt in ChatML format
 * @returns {Array<{role: string, content: string}>}
 */
function parseChatML(prompt) {
    const startPattern = /<\|im_start\|>(\w+)\s*\n/g;
    const starts = [];
    let match;

    while ((match = startPattern.exec(prompt)) !== null) {
        starts.push({
            role: match[1].toLowerCase(),
            index: match.index,
            contentStart: match.index + match[0].length,
        });
    }

    // Fallback: if no ChatML tags found, treat entire prompt as user message
    if (starts.length === 0) {
        return [{ role: 'user', content: prompt.trim() }];
    }

    const messages = [];

    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        // Content extends to next <|im_start|> or end of string
        const nextStart = i + 1 < starts.length ? starts[i + 1].index : prompt.length;

        // Extract content
        let content = prompt.substring(start.contentStart, nextStart);

        // Remove <|im_end|> tag if present
        content = content.replace(/<\|im_end\|>\s*$/, '').trim();

        // Only include valid roles with content
        if ((start.role === 'system' || start.role === 'user' || start.role === 'assistant') && content) {
            messages.push({
                role: start.role,
                content: content,
            });
        }
    }

    return messages;
}

/**
 * Get connection profile for summary generation
 * @returns {object|null}
 */
function getConnectionProfile() {
    const context = getContext();

    // Check if ConnectionManagerRequestService is available
    if (!context.ConnectionManagerRequestService) {
        return null;
    }

    // Check if connection manager settings exist
    if (!context.extensionSettings?.connectionManager?.profiles) {
        return null;
    }

    const profiles = context.extensionSettings.connectionManager.profiles;

    // Use specified profile or find default
    if (settings.connectionProfile) {
        const profile = profiles.find(p => p.id === settings.connectionProfile);
        if (profile && profile.api) {
            return profile;
        }
    }

    // Find first valid profile with API
    const validProfile = profiles.find(p => p.api);
    return validProfile || null;
}

/**
 * Generate summary for a message
 * @param {object} message - Message to summarize
 * @param {Array} chat - Full chat array
 * @param {number} index - Message index in chat
 * @returns {Promise<string>}
 */
async function generateSummary(message, chat, index) {
    const context = getContext();
    const contextText = buildContext(chat, index);
    const prompt = formatSummaryPrompt(message, contextText, index + 1);

    try {
        let summary;

        // Try ChatML with ConnectionManagerRequestService if enabled
        if (settings.useChatML) {
            const profile = getConnectionProfile();

            if (profile && context.ConnectionManagerRequestService) {
                const messages = parseChatML(prompt);

                const response = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    messages,
                    settings.summaryMaxTokens || 150
                );

                summary = response?.content || '';
            } else {
                // Fallback to generateQuietPrompt with plain text
                summary = await context.generateQuietPrompt({
                    quietPrompt: prompt.replace(/<\|im_start\|>\w+\s*\n/g, '').replace(/<\|im_end\|>/g, ''),
                    quietToLoud: false,
                    skipWIAN: true,
                    responseLength: settings.summaryMaxTokens || 150,
                    removeReasoning: true,
                    trimToSentence: true,
                });
            }
        } else {
            // Use traditional generateQuietPrompt
            summary = await context.generateQuietPrompt({
                quietPrompt: prompt,
                quietToLoud: false,
                skipWIAN: true,
                responseLength: settings.summaryMaxTokens || 150,
                removeReasoning: true,
                trimToSentence: true,
            });
        }

        return (summary || '').trim();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Summary generation failed:`, error);
        throw error;
    }
}

/**
 * Save collection metadata (chat name, character info) for Global Manager display
 * Updates chat name if it has changed (e.g., user renamed the chat session)
 * @param {string} collectionId - Collection ID
 */
function saveCollectionInfo(collectionId) {
    if (!collectionId) return;

    const context = getContext();

    // Use context.chatId which is the actual chat filename users see in SillyTavern
    // Format: "CharacterName - 2024-01-15 10:30:45" or user-defined name
    let chatName = context.chatId || '';

    // Truncate if too long
    if (chatName.length > 50) {
        chatName = chatName.substring(0, 50) + '...';
    }

    // Fallback to other sources if chatId is empty
    if (!chatName) {
        chatName = context.chatMetadata?.chat_name
            || context.chat_metadata?.chat_name
            || 'Unnamed Chat';
    }

    // Check if collection info already exists
    const existingData = settings.memoryData?.[collectionId];
    const existingInfo = existingData?.['__collection_info__'];

    // If already exists, only update if chat name changed
    if (existingInfo) {
        if (existingInfo.chatName !== chatName) {
            // Chat name changed - update it
            saveMetadataPersistent(collectionId, '__collection_info__', {
                ...existingInfo,
                chatName: chatName,
                updatedAt: Date.now(),
            });
        }
        return;
    }

    // Save new collection metadata
    saveMetadataPersistent(collectionId, '__collection_info__', {
        chatName: chatName,
        characterName: context.name2 || '',
        characterId: context.characterId,
        chatId: context.chatId,
        createdAt: Date.now(),
    });
}

/**
 * Store memory in backend with metadata embedded in text field
 * @param {string} msgId - Message ID
 * @param {string} summary - Summary text
 * @param {string} contentHash - Hash of original message content
 * @param {number} turnIndex - Turn index (actual turn number, not array index)
 * @param {string} chatId - Chat ID
 */
async function storeMemory(msgId, summary, contentHash, turnIndex, chatId) {
    const collectionId = getCollectionId();
    if (!collectionId) {
        throw new Error('No collection ID');
    }

    // Save collection info for Global Manager display (only on first memory)
    saveCollectionInfo(collectionId);

    const context = getContext();
    const memoryHash = `mem_${msgId}`;
    const now = Date.now();

    // Create metadata object that will be stored in text field as JSON
    const metadata = {
        msgId,
        contentHash,
        turnIndex,
        chatId,
        characterId: context.characterId,
        summary,
        createdAt: now,
        updatedAt: now,
    };

    // Store in local cache for faster access
    memoryMetadataCache.set(memoryHash, metadata);

    // CRITICAL: Save to persistent storage FIRST (survives page refresh)
    // This ensures data is saved even if backend insert fails
    saveMetadataPersistent(collectionId, memoryHash, metadata);

    // Then try to insert into backend for vector search (if healthy)
    if (backendHealthy && backend) {
        const item = {
            hash: memoryHash,
            text: JSON.stringify(metadata),
            index: turnIndex,
        };

        try {
            await backend.insert(collectionId, [item]);
        } catch (backendError) {
            console.warn(`[${MODULE_NAME}] Backend insert failed (data saved to persistent storage):`, backendError.message);
            // Don't throw - data is already saved to persistent storage
        }
    }

    // Update formatted memory immediately so macro has latest data
    updateFormattedMemoryFromCache();
}

/**
 * Parse metadata from stored text (handles both JSON and legacy plain text)
 * @param {string} text - Text from backend
 * @param {string} hash - Hash of the item
 * @returns {object} Parsed metadata
 */
function parseStoredMetadata(text, hash) {
    try {
        const metadata = JSON.parse(text);
        // Validate it's our metadata format
        if (metadata.msgId && metadata.summary !== undefined) {
            return metadata;
        }
    } catch {
        // Not JSON, might be legacy plain text summary
    }

    // Legacy format: text is the summary itself
    return {
        msgId: hash.startsWith('mem_') ? hash.substring(4) : hash,
        summary: text,
        turnIndex: 0,
        contentHash: '',
        chatId: '',
        createdAt: 0,
        updatedAt: 0,
    };
}

/**
 * Hydrate metadata cache from persistent storage
 * This restores the volatile cache from extension_settings
 * @param {boolean} force - Force re-hydration even if already done for this collection
 */
async function hydrateMetadataCache(force = false) {
    const collectionId = getCollectionId();
    if (!collectionId) {
        return;
    }

    // Skip if already hydrated for this collection (unless forced)
    if (!force && lastHydratedCollectionId === collectionId && memoryMetadataCache.size > 0) {
        return;
    }

    try {
        // Primary source: persistent storage in extension_settings
        const persistentData = getCollectionMetadata(collectionId);
        const persistentCount = Object.keys(persistentData).length;

        // Load from persistent storage first (most reliable)
        for (const [hash, metadata] of Object.entries(persistentData)) {
            memoryMetadataCache.set(hash, metadata);
        }

        // Secondary: check backend for any hashes not in persistent storage
        // This handles migration from old data or data created by other means
        if (backend) {
            try {
                const backendHashes = await backend.list(collectionId);
                const missingHashes = backendHashes.filter(h => h && !persistentData[h]);

                if (missingHashes.length > 0) {
                    // Try to get metadata from backend query
                    const results = await backend.query(collectionId, 'memory summary context', backendHashes.length, 0);

                    for (const result of results) {
                        if (!memoryMetadataCache.has(result.hash)) {
                            const metadata = parseStoredMetadata(result.text, result.hash);
                            memoryMetadataCache.set(result.hash, metadata);

                            // Save to persistent storage for future
                            if (metadata.summary && metadata.summary !== '(loading...)') {
                                saveMetadataPersistent(collectionId, result.hash, metadata);
                            }
                        }
                    }

                    // For any still missing, add placeholders
                    for (const hash of missingHashes) {
                        if (!memoryMetadataCache.has(hash)) {
                            const placeholder = {
                                msgId: hash.startsWith('mem_') ? hash.substring(4) : hash,
                                summary: '(legacy data - regenerate recommended)',
                                turnIndex: 0,
                                contentHash: '',
                                chatId: '',
                                createdAt: 0,
                                updatedAt: 0,
                            };
                            memoryMetadataCache.set(hash, placeholder);
                        }
                    }
                }
            } catch (backendError) {
                console.warn(`[${MODULE_NAME}] Backend check failed:`, backendError);
            }
        }

        // Mark this collection as hydrated
        lastHydratedCollectionId = collectionId;

        // Update formatted memory for macro
        updateFormattedMemoryFromCache();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to hydrate metadata cache:`, error);
    }
}

/**
 * Get all summarized message IDs
 * Uses persistent storage as primary source (more reliable than backend.list)
 * @returns {Promise<Set<string>>}
 */
async function getSummarizedMessageIds() {
    const collectionId = getCollectionId();
    if (!collectionId) {
        return new Set();
    }

    const msgIds = new Set();

    // Primary source: persistent storage (most reliable)
    const persistentData = getCollectionMetadata(collectionId);
    for (const hash of Object.keys(persistentData)) {
        if (hash && hash.startsWith('mem_')) {
            msgIds.add(hash.substring(4)); // Remove 'mem_' prefix
        }
    }

    // Secondary source: memory cache (for newly added items not yet persisted)
    for (const hash of memoryMetadataCache.keys()) {
        if (hash && hash.startsWith('mem_')) {
            msgIds.add(hash.substring(4));
        }
    }

    return msgIds;
}

/**
 * Calculate actual turn number for a message
 * @param {Array} chat - Chat array
 * @param {number} messageIndex - Index in chat array
 * @param {boolean} countUserTurns - Whether to count user messages (default: true)
 * @returns {number} Turn number (1-based)
 */
function calculateTurnNumber(chat, messageIndex, countUserTurns = true) {
    let turnNumber = 0;
    for (let i = 0; i <= messageIndex && i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        if (!countUserTurns && msg.is_user) continue;
        turnNumber++;
    }
    return turnNumber;
}

/**
 * Check and summarize new messages
 */
async function checkAndSummarize() {
    // Use mutex to prevent race conditions - skip if already running
    if (!syncMutex.tryAcquire()) {
        return;
    }

    try {
        const context = getContext();
        const chat = context.chat;

        if (!chat || chat.length === 0) return;

        // Check if we've reached the threshold
        const nonSystemMessages = chat.filter(m => !m.is_system);
        if (nonSystemMessages.length <= settings.minTurnToStartSummary) {
            return;
        }

        // Get already summarized message IDs
        const summarizedIds = await getSummarizedMessageIds();

        // Find messages that need summarization
        // We summarize everything except the last (minTurnToStartSummary) messages
        const protectedCount = settings.minTurnToStartSummary;
        const summarizableMessages = [];

        // Calculate turn numbers - if skipUserTurns, only count character turns
        let turnCounter = 0;

        for (let i = 0; i < nonSystemMessages.length - protectedCount; i++) {
            const msg = nonSystemMessages[i];

            // Count turn based on skip setting
            if (settings.skipUserTurns) {
                // Only count character (non-user) messages
                if (!msg.is_user) {
                    turnCounter++;
                } else {
                    continue; // Skip user turns
                }
            } else {
                // Count all messages
                turnCounter++;
            }

            const msgId = normalizeMessageId(msg);

            if (!summarizedIds.has(msgId) && !pendingSummaries.has(msgId)) {
                const chatIndex = chat.indexOf(msg);
                summarizableMessages.push({
                    message: msg,
                    index: chatIndex,
                    turnNumber: turnCounter, // Sequential turn number
                    msgId,
                });
            }
        }

        if (summarizableMessages.length === 0) {
            return;
        }

        // Process in batches
        for (let i = 0; i < summarizableMessages.length; i += settings.batchSize) {
            const batch = summarizableMessages.slice(i, i + settings.batchSize);

            for (const item of batch) {
                pendingSummaries.add(item.msgId);

                try {
                    const summary = await generateSummary(item.message, chat, item.index);

                    if (!summary) {
                        console.warn(`[${MODULE_NAME}] Empty summary for turn ${item.turnNumber}`);
                        continue;
                    }

                    const contentHash = getStringHash(item.message.mes);

                    await storeMemory(
                        item.msgId,
                        summary,
                        contentHash,
                        item.turnNumber,
                        context.getCurrentChatId()
                    );
                } catch (error) {
                    console.error(`[${MODULE_NAME}] Failed to summarize turn ${item.turnNumber}:`, error);
                } finally {
                    pendingSummaries.delete(item.msgId);
                }
            }

            // Delay between batches
            if (i + settings.batchSize < summarizableMessages.length) {
                await sleep(settings.batchDelayMs);
            }
        }
    } finally {
        syncMutex.release();
    }
}

/**
 * Handle message edited event
 * @param {number} messageId - Message index
 */
async function handleMessageEdited(messageId) {
    if (!settings.autoResummarizeOnEdit) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || messageId >= chat.length) return;

    const message = chat[messageId];
    if (message.is_system) return; // Don't process system messages

    const msgId = normalizeMessageId(message, messageId);
    const memoryHash = `mem_${msgId}`;

    // Check if we have a memory for this message
    const metadata = memoryMetadataCache.get(memoryHash);
    if (!metadata) return;

    // Check if content changed
    const currentHash = getStringHash(message.mes);
    if (metadata.contentHash === currentHash) return;

    pendingSummaries.add(msgId);

    // CRITICAL FIX: Generate new summary FIRST, then delete old one only on success
    // This prevents data loss if generation fails
    let newSummary;
    try {
        newSummary = await generateSummary(message, chat, messageId);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Re-summarization failed, keeping old summary:`, error);
        pendingSummaries.delete(msgId);
        return; // Keep old summary on failure
    }

    // Generation succeeded, now safe to delete old and store new
    const collectionId = getCollectionId();
    try {
        if (collectionId) {
            // Delete old memory from backend
            await backend.delete(collectionId, [memoryHash]);
            // Delete from persistent storage
            deleteMetadataPersistent(collectionId, memoryHash);
            // Delete from cache
            memoryMetadataCache.delete(memoryHash);
        }

        // Store new summary
        const turnNumber = calculateTurnNumber(chat, messageId, !settings.skipUserTurns);
        await storeMemory(msgId, newSummary, currentHash, turnNumber, context.getCurrentChatId());
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to store new summary:`, error);
    } finally {
        pendingSummaries.delete(msgId);
    }
}

/**
 * Handle message deleted event
 * @param {number} messageId - Message index (of the deleted message, before deletion)
 */
async function handleMessageDeleted(messageId) {
    if (!settings.deleteMemoryOnMsgDelete) return;

    const collectionId = getCollectionId();
    if (!collectionId) return;

    // Strategy: Since the message is already gone by the time this event fires,
    // we scan our stored memories and check if their msgIds still exist in the chat.
    // Any memory whose msgId is not found in the current chat is orphaned and should be deleted.

    const context = getContext();
    const chat = context.chat || [];

    // Build set of current chat message IDs
    const currentMsgIds = new Set();
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg.is_system) {
            const msgId = normalizeMessageId(msg, i);
            currentMsgIds.add(msgId);
        }
    }

    // Check persistent storage for orphaned memories
    const persistentData = getCollectionMetadata(collectionId);
    const orphanedHashes = [];

    for (const [hash, metadata] of Object.entries(persistentData)) {
        if (!hash.startsWith('mem_')) continue;

        const storedMsgId = hash.substring(4); // Remove 'mem_' prefix

        // Check if this msgId still exists in chat
        if (!currentMsgIds.has(storedMsgId)) {
            orphanedHashes.push(hash);
        }
    }

    if (orphanedHashes.length === 0) {
        return;
    }

    // Delete orphaned memories
    for (const hash of orphanedHashes) {
        try {
            await backend.delete(collectionId, [hash]);
            deleteMetadataPersistent(collectionId, hash);
            memoryMetadataCache.delete(hash);
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to delete orphaned memory ${hash}:`, error);
        }
    }

    // Update formatted memory
    updateFormattedMemoryFromCache();
}

/**
 * Sync persistent storage with backend - remove orphaned entries
 * Call this periodically or on demand to clean up inconsistencies
 */
async function syncStorageWithBackend() {
    const collectionId = getCollectionId();
    if (!collectionId || !backend) return { cleaned: 0 };

    try {
        const persistentData = getCollectionMetadata(collectionId);
        const backendHashes = await backend.list(collectionId);

        // Find hashes in backend but not in persistent storage (orphaned in backend)
        const persistentHashes = new Set(Object.keys(persistentData));
        const orphanedInBackend = backendHashes.filter(h => h && !persistentHashes.has(h));

        // Find hashes in persistent but not in backend (orphaned in persistent)
        const backendHashSet = new Set(backendHashes.filter(h => h));
        const orphanedInPersistent = Object.keys(persistentData).filter(h => !backendHashSet.has(h));

        let cleaned = 0;

        // Delete orphaned from backend
        if (orphanedInBackend.length > 0) {
            await backend.delete(collectionId, orphanedInBackend);
            cleaned += orphanedInBackend.length;
        }

        // Delete orphaned from persistent storage
        for (const hash of orphanedInPersistent) {
            deleteMetadataPersistent(collectionId, hash);
            memoryMetadataCache.delete(hash);
            cleaned++;
        }

        if (cleaned > 0) {
            updateFormattedMemoryFromCache();
        }

        return { cleaned };
    } catch (error) {
        console.error(`[${MODULE_NAME}] Sync failed:`, error);
        return { cleaned: 0, error: error.message };
    }
}

/**
 * Sync unvectorized summaries to backend when it becomes available
 * This restores semantic search capability for summaries created during fallback mode
 * @returns {Promise<{synced: number, error?: string}>}
 */
async function syncUnvectorizedToBackend() {
    const collectionId = getCollectionId();
    if (!collectionId || !backend || !backendHealthy) return { synced: 0 };

    try {
        // 1. Get all hashes from persistent storage
        const persistentData = getCollectionMetadata(collectionId);
        const persistentHashes = Object.keys(persistentData).filter(h => h && h !== '__collection_info__');

        if (persistentHashes.length === 0) return { synced: 0 };

        // 2. Get all hashes from backend
        let backendHashes = [];
        try {
            backendHashes = await backend.list(collectionId);
        } catch (e) {
            // Backend might not have this collection yet - that's OK
            backendHashes = [];
        }
        const backendHashSet = new Set(backendHashes.filter(h => h));

        // 3. Find unvectorized (in persistent but not in backend)
        const unvectorized = persistentHashes.filter(h => !backendHashSet.has(h));

        if (unvectorized.length === 0) {
            return { synced: 0 };
        }

        console.log(`[${MODULE_NAME}] Found ${unvectorized.length} unvectorized summaries, syncing to backend...`);

        // 4. Insert unvectorized items into backend
        let synced = 0;
        for (const hash of unvectorized) {
            const metadata = persistentData[hash];
            if (!metadata || !metadata.summary) continue;

            try {
                const item = {
                    hash,
                    text: JSON.stringify(metadata),
                    index: metadata.turnIndex || 0,
                };
                await backend.insert(collectionId, [item]);
                synced++;
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Failed to sync hash ${hash}:`, error.message);
            }
        }

        if (synced > 0) {
            console.log(`[${MODULE_NAME}] Synced ${synced} summaries to backend`);
        }
        return { synced };
    } catch (error) {
        console.error(`[${MODULE_NAME}] Sync to backend failed:`, error);
        return { synced: 0, error: error.message };
    }
}

/**
 * Handle chat changed event
 */
async function handleChatChanged() {
    // Clear local caches for previous chat
    memoryMetadataCache.clear();
    pendingSummaries.clear();
    lastHydratedCollectionId = null; // Force re-hydration for new chat
    currentFormattedMemory = ''; // Clear macro content

    // Hydrate metadata cache from backend for the new chat
    await hydrateMetadataCache();

    // Update collection info (chat name) for existing collections
    // This ensures old collections get proper chat names when accessed
    const collectionId = getCollectionId();
    if (collectionId && settings.memoryData?.[collectionId]) {
        saveCollectionInfo(collectionId);
    }

    // Sync unvectorized summaries to backend if backend is healthy
    // This restores semantic search for summaries created during fallback mode
    if (backendHealthy && backend && collectionId) {
        try {
            const syncResult = await syncUnvectorizedToBackend();
            if (syncResult.synced > 0) {
                toastr.info(`Synced ${syncResult.synced} summaries to vector store`);
            }
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Auto-sync failed:`, error.message);
        }
    }

    // Update chat control button
    addChatControlButton();

    // Trigger summarization check for new chat
    debouncedCheckAndSummarize();
}

/**
 * Handle character deleted event
 * Cleans up all memories associated with the deleted character
 * @param {object} event - Event object containing characterId or character data
 */
async function handleCharacterDeleted(event) {
    // Extract characterId from event (may be direct id or object with id property)
    let characterId;
    if (typeof event === 'number' || typeof event === 'string') {
        characterId = event;
    } else if (event?.id !== undefined) {
        characterId = event.id;
    } else if (event?.characterId !== undefined) {
        characterId = event.characterId;
    } else {
        console.warn(`[${MODULE_NAME}] CHARACTER_DELETED event received but could not extract characterId:`, event);
        return;
    }

    const collectionPrefix = `${COLLECTION_PREFIX}c${characterId}_`;
    const collectionsToDelete = [];

    // Find all collections for this character
    for (const collectionId of Object.keys(settings.memoryData || {})) {
        if (collectionId.startsWith(collectionPrefix)) {
            collectionsToDelete.push(collectionId);
        }
    }

    if (collectionsToDelete.length === 0) {
        return;
    }

    console.log(`[${MODULE_NAME}] Cleaning up ${collectionsToDelete.length} memory collections for deleted character ${characterId}`);

    // Delete each collection
    for (const collectionId of collectionsToDelete) {
        try {
            // Purge from backend
            await backend.purge(collectionId);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Failed to purge backend collection ${collectionId}:`, e);
        }

        // Delete from persistent storage
        purgeCollectionMetadata(collectionId);
    }

    // Clear local caches if current collection was affected
    const currentCollectionId = getCollectionId();
    if (currentCollectionId && collectionsToDelete.includes(currentCollectionId)) {
        memoryMetadataCache.clear();
        currentFormattedMemory = '';
    }

    console.log(`[${MODULE_NAME}] Successfully cleaned up memories for deleted character ${characterId}`);
}

/**
 * Handle chat deleted event
 * Cleans up memories associated with the deleted chat
 * @param {object} event - Event object containing chat info (file_name or chatId)
 */
async function handleChatDeleted(event) {
    // Extract chat identifier from event
    let chatId;
    if (typeof event === 'string') {
        chatId = event;
    } else if (event?.file_name) {
        chatId = event.file_name;
    } else if (event?.id) {
        chatId = event.id;
    } else {
        console.warn(`[${MODULE_NAME}] CHAT_DELETED event received but could not extract chatId:`, event);
        return;
    }

    const chatIdHash = calculateHash(chatId);
    const chatSuffix = `_${chatIdHash}`;
    const collectionsToDelete = [];

    // Find all collections for this chat (any character)
    for (const collectionId of Object.keys(settings.memoryData || {})) {
        if (collectionId.endsWith(chatSuffix)) {
            collectionsToDelete.push(collectionId);
        }
    }

    if (collectionsToDelete.length === 0) {
        return;
    }

    console.log(`[${MODULE_NAME}] Cleaning up ${collectionsToDelete.length} memory collections for deleted chat ${chatId}`);

    // Delete each collection
    for (const collectionId of collectionsToDelete) {
        try {
            // Purge from backend
            await backend.purge(collectionId);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Failed to purge backend collection ${collectionId}:`, e);
        }

        // Delete from persistent storage
        purgeCollectionMetadata(collectionId);
    }

    // Clear local caches if current collection was affected
    const currentCollectionId = getCollectionId();
    if (currentCollectionId && collectionsToDelete.includes(currentCollectionId)) {
        memoryMetadataCache.clear();
        currentFormattedMemory = '';
        lastHydratedCollectionId = null;
    }

    console.log(`[${MODULE_NAME}] Successfully cleaned up memories for deleted chat ${chatId}`);
}

/**
 * Handle group chat deleted event
 * Cleans up memories associated with the deleted group chat
 * @param {object} event - Event object containing group chat info
 */
async function handleGroupChatDeleted(event) {
    // For group chats, the event structure may differ
    // Try to extract the chat file name or id
    let chatId;
    if (typeof event === 'string') {
        chatId = event;
    } else if (event?.chat_file) {
        chatId = event.chat_file;
    } else if (event?.id) {
        chatId = event.id;
    } else {
        console.warn(`[${MODULE_NAME}] GROUP_CHAT_DELETED event received but could not extract chatId:`, event);
        return;
    }

    // Group chats use 'group' prefix instead of 'c{characterId}'
    const chatIdHash = calculateHash(chatId);
    const targetCollectionId = `${COLLECTION_PREFIX}group_${chatIdHash}`;

    // Check if this collection exists
    if (!settings.memoryData?.[targetCollectionId]) {
        return;
    }

    console.log(`[${MODULE_NAME}] Cleaning up memory collection for deleted group chat ${chatId}`);

    try {
        // Purge from backend
        await backend.purge(targetCollectionId);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] Failed to purge backend collection ${targetCollectionId}:`, e);
    }

    // Delete from persistent storage
    purgeCollectionMetadata(targetCollectionId);

    // Clear local caches if current collection was affected
    const currentCollectionId = getCollectionId();
    if (currentCollectionId === targetCollectionId) {
        memoryMetadataCache.clear();
        currentFormattedMemory = '';
        lastHydratedCollectionId = null;
    }

    console.log(`[${MODULE_NAME}] Successfully cleaned up memories for deleted group chat ${chatId}`);
}

/**
 * Get all collections data for Global Management UI
 * @returns {Array<object>} Array of collection metadata objects
 */
function getAllCollectionsData() {
    const context = getContext();
    const collections = [];
    const characters = context.characters || {};

    for (const [collectionId, hashMap] of Object.entries(settings.memoryData || {})) {
        // Parse collection ID: ctx_sum_c{charId}_{chatHash} or ctx_sum_group_{chatHash}
        const match = collectionId.match(/^ctx_sum_(c(\d+)|group)_(.+)$/);
        if (!match) continue;

        const charPrefix = match[1];
        const characterId = charPrefix === 'group' ? null : parseInt(match[2]);
        const chatHash = match[3];

        // Get character info
        const character = characterId !== null ? characters[characterId] : null;
        const isOrphaned = characterId !== null && !character;

        // Get collection info (chat name, etc.) from __collection_info__
        const collectionInfo = hashMap?.['__collection_info__'] || {};
        const chatName = collectionInfo.chatName || `Chat ${chatHash.substring(0, 8)}`;

        // Calculate stats from hashMap (exclude __collection_info__ from count)
        const memories = Object.entries(hashMap || {})
            .filter(([key]) => key !== '__collection_info__')
            .map(([, value]) => value);
        const memoryCount = memories.length;
        const totalChars = memories.reduce((sum, m) => sum + ((m.summary || '').length || 0), 0);
        const timestamps = memories.map(m => m.createdAt || 0).filter(t => t > 0);

        collections.push({
            collectionId,
            characterId,
            characterName: character?.name || (charPrefix === 'group' ? 'Group Chats' : 'Deleted Character'),
            characterAvatar: character?.avatar || null,
            chatHash,
            chatName,
            isGroup: charPrefix === 'group',
            isOrphaned,
            memoryCount,
            totalChars,
            oldestMemory: timestamps.length ? Math.min(...timestamps) : 0,
            newestMemory: timestamps.length ? Math.max(...timestamps) : 0,
        });
    }

    // Sort: Orphaned first, then by character name
    return collections.sort((a, b) => {
        if (a.isOrphaned !== b.isOrphaned) return a.isOrphaned ? -1 : 1;
        return (a.characterName || '').localeCompare(b.characterName || '');
    });
}

/**
 * Cleanup orphaned collections (collections for deleted characters)
 * @returns {Promise<number>} Number of cleaned collections
 */
async function cleanupOrphanedCollections() {
    const context = getContext();
    const characters = context.characters || {};
    const validCharacterIds = new Set(
        Object.keys(characters).map(id => parseInt(id))
    );

    let cleaned = 0;

    for (const collectionId of Object.keys(settings.memoryData || {})) {
        // Only check character-specific collections (not groups)
        const match = collectionId.match(/^ctx_sum_c(\d+)_/);
        if (!match) continue;

        const characterId = parseInt(match[1]);

        // Character no longer exists
        if (!validCharacterIds.has(characterId)) {
            try {
                await backend.purge(collectionId);
            } catch (e) {
                console.warn(`[${MODULE_NAME}] Failed to purge ${collectionId}:`, e);
            }
            purgeCollectionMetadata(collectionId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        saveSettings();
    }

    return cleaned;
}

/**
 * Purge a specific collection (for Global Management UI)
 * @param {string} collectionId - Collection ID to purge
 */
async function purgeCollection(collectionId) {
    try {
        await backend.purge(collectionId);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] Failed to purge backend collection ${collectionId}:`, e);
    }

    purgeCollectionMetadata(collectionId);

    // Clear local caches if this was the current collection
    const currentCollectionId = getCollectionId();
    if (currentCollectionId === collectionId) {
        memoryMetadataCache.clear();
        currentFormattedMemory = '';
        lastHydratedCollectionId = null;
    }
}

/**
 * Build query text from recent messages
 * Uses the last USER message as query for better RAG relevance,
 * especially important during reroll/regeneration when the last message
 * might be the AI's previous response.
 * @param {Array} chat - Chat array
 * @returns {string}
 */
function buildQueryFromRecentMessages(chat) {
    // Filter non-system messages
    const nonSystemMessages = chat.filter(m => !m.is_system);

    // Find the last user message - this is the actual query/input
    // This handles reroll scenarios where the last message is AI's previous response
    const lastUserMessage = nonSystemMessages
        .filter(m => m.is_user)
        .slice(-1)[0];

    // If no user message found, fall back to last message
    if (!lastUserMessage) {
        const lastMessage = nonSystemMessages.slice(-1)[0];
        return lastMessage?.mes || '';
    }

    return lastUserMessage.mes || '';
}

/**
 * Extract summary text from a result item (handles both new JSON format and legacy)
 * @param {object} item - Query result item with text and hash
 * @returns {object} Normalized item with summary extracted
 */
function normalizeQueryResult(item) {
    // First check if we have it in cache (most reliable)
    const cached = memoryMetadataCache.get(item.hash);
    if (cached && cached.summary) {
        return {
            hash: item.hash,
            text: cached.summary,
            index: cached.turnIndex || item.index || 0,
            score: item.score || 0,
        };
    }

    // Try to parse text as JSON metadata
    const metadata = parseStoredMetadata(item.text, item.hash);
    return {
        hash: item.hash,
        text: metadata.summary || item.text || '',
        index: metadata.turnIndex || item.index || 0,
        score: item.score || 0,
    };
}

/**
 * Format summaries for injection
 * @param {Array} summaries - Array of summary objects (already normalized)
 * @returns {string}
 */
function formatSummaries(summaries) {
    if (!summaries || summaries.length === 0) {
        return '';
    }

    const context = getContext();

    return summaries
        .map((summary, idx) => {
            let formatted = settings.memoryTemplate;
            formatted = formatted.replace('{{index}}', String(idx + 1));
            formatted = formatted.replace('{{turnIndex}}', String(summary.index || 0));
            formatted = formatted.replace('{{content}}', summary.text || '');
            formatted = formatted.replace('{{score}}', String(summary.score?.toFixed(2) || ''));
            formatted = formatted.replace(/\{\{user\}\}/g, context.name1);
            formatted = formatted.replace(/\{\{char\}\}/g, context.name2);
            return formatted;
        })
        .join(settings.memorySeparator);
}

/**
 * Update currentFormattedMemory from cache (synchronous, no backend calls)
 * This should be called after storing memories and when chat loads
 */
function updateFormattedMemoryFromCache() {
    if (!settings) {
        currentFormattedMemory = '';
        return;
    }

    const collectionId = getCollectionId();
    if (!collectionId) {
        currentFormattedMemory = '';
        return;
    }

    try {
        // Collect all summaries from cache and persistent storage
        const allSummaries = [];
        const persistentData = getCollectionMetadata(collectionId);

        // From persistent storage
        for (const [hash, metadata] of Object.entries(persistentData)) {
            if (metadata && metadata.summary) {
                allSummaries.push({
                    hash,
                    text: metadata.summary,
                    index: metadata.turnIndex || 0,
                    score: 0,
                });
            }
        }

        // From memory cache (might have newer items)
        for (const [hash, metadata] of memoryMetadataCache.entries()) {
            if (metadata && metadata.summary && !persistentData[hash]) {
                allSummaries.push({
                    hash,
                    text: metadata.summary,
                    index: metadata.turnIndex || 0,
                    score: 0,
                });
            }
        }

        if (allSummaries.length === 0) {
            currentFormattedMemory = '';
            return;
        }

        // Sort by turn index (chronological order)
        allSummaries.sort((a, b) => a.index - b.index);

        // Take the most recent N summaries based on settings
        const maxRecent = settings.maxRetrievedSummaries || 10;
        const recentSummaries = allSummaries.slice(-maxRecent);

        // Format and store
        currentFormattedMemory = formatSummaries(recentSummaries);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error updating formatted memory from cache:`, error);
        currentFormattedMemory = '';
    }
}

/**
 * Prepare memory content for macro injection
 * Called BEFORE generation to populate currentFormattedMemory
 * This ensures the macro returns actual content when evaluated
 */
async function prepareMemoryForGeneration() {
    if (!settings) return;
    if (isPreparingMemory) return;

    isPreparingMemory = true;

    try {
        const context = getContext();
        const chat = context.chat;
        const collectionId = getCollectionId();

        if (!collectionId || !chat || chat.length === 0) {
            currentFormattedMemory = '';
            return;
        }

        // CRITICAL: Ensure metadata cache is hydrated before proceeding
        // This is essential for the macro to return content
        await hydrateMetadataCache();

        // Get summarized message IDs
        const summarizedIds = await getSummarizedMessageIds();

        // If no summaries exist yet, nothing to do
        if (summarizedIds.size === 0) {
            currentFormattedMemory = '';
            return;
        }

        // Get all summaries from persistent storage
        const persistentData = getCollectionMetadata(collectionId);
        const allSummaries = [];

        for (const [hash, metadata] of Object.entries(persistentData)) {
            if (!metadata || hash === '__collection_info__') continue;
            if (!metadata.summary) continue;

            allSummaries.push({
                hash,
                text: metadata.summary,
                index: metadata.turnIndex || 0,
                score: 0,
                turnIndex: metadata.turnIndex || 0,
            });

            // Also populate cache
            if (!memoryMetadataCache.has(hash)) {
                memoryMetadataCache.set(hash, metadata);
            }
        }

        // Sort by turn index (most recent first)
        allSummaries.sort((a, b) => b.index - a.index);

        let similarResults = [];
        let allSelected = [];

        // Use vector search if backend is healthy, otherwise use fallback
        if (backendHealthy && backend) {
            // Build query from recent messages
            const queryText = buildQueryFromRecentMessages(chat);

            // Query for relevant summaries via vector search
            try {
                const rawResults = await backend.query(
                    collectionId,
                    queryText,
                    settings.maxRetrievedSummaries,
                    settings.scoreThreshold
                );

                // Normalize query results to extract actual summary text from JSON metadata
                similarResults = rawResults.map(normalizeQueryResult);

                // Get always-include recent N
                const recentSummaries = allSummaries.slice(0, settings.alwaysIncludeRecentN);
                const recentHashes = new Set(recentSummaries.map(s => s.hash));

                // Filter similar results to exclude recent ones
                const filteredSimilar = similarResults.filter(s => !recentHashes.has(s.hash));

                // Calculate how many similar results we need
                const neededFromSimilar = settings.maxRetrievedSummaries - settings.alwaysIncludeRecentN;
                const selectedSimilar = filteredSimilar.slice(0, neededFromSimilar);

                // If we don't have enough similar results, fill from additional recent
                let additionalRecent = [];
                if (selectedSimilar.length < neededFromSimilar) {
                    const shortage = neededFromSimilar - selectedSimilar.length;
                    const alreadySelected = new Set([
                        ...recentSummaries.map(s => s.hash),
                        ...selectedSimilar.map(s => s.hash),
                    ]);

                    additionalRecent = allSummaries
                        .filter(s => !alreadySelected.has(s.hash))
                        .slice(0, shortage);
                }

                // Combine all selected summaries
                allSelected = [...selectedSimilar, ...recentSummaries, ...additionalRecent];
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Vector search failed, using fallback:`, error.message);
                // Fall through to fallback mode
                allSelected = allSummaries.slice(0, settings.maxRetrievedSummaries);
            }
        } else {
            // Fallback mode: just use recent memories (no semantic search)
            allSelected = allSummaries.slice(0, settings.maxRetrievedSummaries);
        }

        // Sort by turn index ascending (chronological order)
        allSelected.sort((a, b) => a.index - b.index);

        // Format and store for macro injection
        currentFormattedMemory = formatSummaries(allSelected);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error preparing memory:`, error);
        currentFormattedMemory = '';
    } finally {
        isPreparingMemory = false;
    }
}

/**
 * Generate interceptor - called before each generation
 * Prepares RAG memory retrieval and removes summarized messages from chat context
 * @param {Array} chat - Chat array (mutable)
 * @param {number} contextSize - Context size
 * @param {Function} abort - Abort function
 * @param {string} type - Generation type
 */
async function uwuMemory_interceptChat(chat, contextSize, abort, type) {
    if (!settings) return;

    // Skip quiet prompts (background generation like our own summarization)
    if (type === 'quiet') return;

    const collectionId = getCollectionId();

    if (!collectionId || !chat || chat.length === 0) return;

    try {
        // CRITICAL: Prepare memory with RAG search BEFORE prompts are combined
        // This is the only async entry point before macro evaluation
        await prepareMemoryForGeneration();

        // Get summarized message IDs
        const summarizedIds = await getSummarizedMessageIds();

        // If no summaries exist yet, nothing to do
        if (summarizedIds.size === 0) return;

        // Find the indices of summarized messages in the chat array
        // This is needed to remove BOTH user and assistant messages up to the summarized point
        const summarizedIndices = [];
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (msg.is_system) continue;

            const msgId = normalizeMessageId(msg);
            if (summarizedIds.has(msgId) && !pendingSummaries.has(msgId)) {
                summarizedIndices.push(i);
            }
        }

        if (summarizedIndices.length === 0) return;

        // Find the maximum index of summarized messages
        const maxSummarizedIndex = Math.max(...summarizedIndices);

        // Remove ALL non-system messages from start up to maxSummarizedIndex
        // This includes both user AND assistant messages that are "covered" by summaries
        // When skipUserTurns is enabled, only assistant messages are summarized,
        // but we still need to remove the corresponding user messages
        let removedCount = 0;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg.is_system) continue;

            const msgId = normalizeMessageId(msg);

            // Remove if this message is at or before the last summarized message
            // AND it's not a pending summary
            if (i <= maxSummarizedIndex && !pendingSummaries.has(msgId)) {
                chat.splice(i, 1);
                removedCount++;
            }
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] Interceptor error:`, error);
    }
}

// Expose to window for SillyTavern to call
window['uwuMemory_interceptChat'] = uwuMemory_interceptChat;

// Debounced check and summarize
const debouncedCheckAndSummarize = debounce(checkAndSummarize, DEBOUNCE_DELAY);

/**
 * Create settings UI HTML (following vectors extension pattern)
 * @returns {string}
 */
function createSettingsHtml() {
    return `
    <div class="uwu-memory-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>UwU Memory</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- Backend status indicator -->
                <div class="flex-container marginTopBot5">
                    <span style="margin-right: 8px;">Backend:</span>
                    <span id="um-backend-status" class="um-backend-status" title="Checking...">
                        <i class="fa-solid fa-circle" style="color: var(--SmartThemeQuoteColor);"></i>
                        <span>Checking...</span>
                    </span>
                </div>

                <hr>
                <h4>Summarization</h4>

                <!-- ChatML checkbox -->
                <label class="checkbox_label marginTopBot5" for="um-use-chatml" title="Use ChatML format with system/user/assistant roles">
                    <input id="um-use-chatml" type="checkbox" class="checkbox" ${settings.useChatML ? 'checked' : ''}>
                    <span>Use ChatML Format</span>
                </label>

                <!-- Connection Profile and Max Tokens row -->
                <div class="flex-container marginTopBot5">
                    <div class="flex-container flex1 flexFlowColumn" title="Connection profile for summary generation">
                        <label for="um-connection-profile"><small>Connection Profile</small></label>
                        <select id="um-connection-profile" class="text_pole">
                            <option value="">Auto (First Available)</option>
                        </select>
                    </div>
                    <div class="flex-container flex1 flexFlowColumn" title="Maximum tokens for summary response">
                        <label for="um-max-tokens"><small>Max Tokens</small></label>
                        <input type="number" id="um-max-tokens" class="text_pole" value="${settings.summaryMaxTokens || 150}">
                    </div>
                </div>

                <!-- Min Turn, Context Window row -->
                <div class="flex-container marginTopBot5">
                    <div class="flex-container flex1 flexFlowColumn" title="Start summarizing after this many turns">
                        <label for="um-min-turn"><small>Min Turns to Start</small></label>
                        <input type="number" id="um-min-turn" class="text_pole" value="${settings.minTurnToStartSummary}">
                    </div>
                    <div class="flex-container flex1 flexFlowColumn" title="Number of previous messages to include as context">
                        <label for="um-context-window"><small>Context Window</small></label>
                        <input type="number" id="um-context-window" class="text_pole" value="${settings.contextWindowForSummary}">
                    </div>
                </div>

                <!-- Summary Prompt -->
                <div class="flex-container flexFlowColumn marginTopBot5">
                    <label for="um-summary-prompt"><small>Summary Prompt (ChatML format)</small></label>
                    <textarea id="um-summary-prompt" class="text_pole textarea_compact" rows="6">${settings.summaryPrompt}</textarea>
                </div>

                <!-- Context Format for Summary -->
                <div class="flex-container flexFlowColumn marginTopBot5">
                    <label><small>Context Format (for {{context}} in prompt)</small></label>
                    <div class="flex-container marginTopBot5">
                        <div class="flex-container flex1 flexFlowColumn" title="Label format for user messages. Use {{user}} for actual name.">
                            <label for="um-ctx-user"><small>User Label</small></label>
                            <input type="text" id="um-ctx-user" class="text_pole" value="${settings.contextFormat?.user || '{{user}}'}">
                        </div>
                        <div class="flex-container flex1 flexFlowColumn" title="Label format for character messages. Use {{char}} for actual name.">
                            <label for="um-ctx-char"><small>Char Label</small></label>
                            <input type="text" id="um-ctx-char" class="text_pole" value="${settings.contextFormat?.char || '{{char}}'}">
                        </div>
                        <div class="flex-container flex1 flexFlowColumn" title="Separator between label and message content">
                            <label for="um-ctx-separator"><small>Separator</small></label>
                            <input type="text" id="um-ctx-separator" class="text_pole" value="${settings.contextFormat?.separator || ': '}" placeholder=": ">
                        </div>
                    </div>
                </div>

                <hr>
                <h4>Search</h4>

                <!-- Search settings row -->
                <div class="flex-container marginTopBot5">
                    <div class="flex-container flex1 flexFlowColumn" title="Maximum summaries to retrieve">
                        <label for="um-max-retrieved"><small>Max Retrieved</small></label>
                        <input type="number" id="um-max-retrieved" class="text_pole" value="${settings.maxRetrievedSummaries}">
                    </div>
                    <div class="flex-container flex1 flexFlowColumn" title="Always include N most recent summaries">
                        <label for="um-recent-n"><small>Always Recent</small></label>
                        <input type="number" id="um-recent-n" class="text_pole" value="${settings.alwaysIncludeRecentN}">
                    </div>
                    <div class="flex-container flex1 flexFlowColumn" title="Minimum similarity score (0-1)">
                        <label for="um-threshold"><small>Score Threshold</small></label>
                        <input type="number" id="um-threshold" class="text_pole" value="${settings.scoreThreshold}">
                    </div>
                </div>

                <hr>
                <h4>Injection</h4>

                <!-- Injection settings -->
                <div class="flex-container flexFlowColumn marginTopBot5">
                    <label for="um-injection-var"><small>Variable Name (use as {{variableName}})</small></label>
                    <input type="text" id="um-injection-var" class="text_pole" value="${settings.injectionVariable}">
                </div>
                <div class="flex-container flexFlowColumn marginTopBot5">
                    <label for="um-memory-template"><small>Memory Template</small></label>
                    <textarea id="um-memory-template" class="text_pole textarea_compact" rows="2">${settings.memoryTemplate}</textarea>
                </div>
                <div class="flex-container flexFlowColumn marginTopBot5">
                    <label for="um-memory-separator"><small>Memory Separator</small></label>
                    <input type="text" id="um-memory-separator" class="text_pole" value="${(settings.memorySeparator || '').replace(/\n/g, '\\n')}" placeholder="\\n\\n---\\n\\n">
                </div>

                <hr>
                <h4>Behavior</h4>

                <!-- Behavior checkboxes -->
                <label class="checkbox_label marginTopBot5" for="um-skip-user" title="Skip summarizing user messages (only summarize character responses)">
                    <input id="um-skip-user" type="checkbox" class="checkbox" ${settings.skipUserTurns ? 'checked' : ''}>
                    <span>Skip User Turns</span>
                </label>
                <label class="checkbox_label marginTopBot5" for="um-auto-resummarize" title="Re-summarize when message is edited">
                    <input id="um-auto-resummarize" type="checkbox" class="checkbox" ${settings.autoResummarizeOnEdit ? 'checked' : ''}>
                    <span>Auto Re-summarize on Edit</span>
                </label>
                <label class="checkbox_label marginTopBot5" for="um-delete-on-delete" title="Delete memory when message is deleted">
                    <input id="um-delete-on-delete" type="checkbox" class="checkbox" ${settings.deleteMemoryOnMsgDelete ? 'checked' : ''}>
                    <span>Delete Memory on Message Delete</span>
                </label>

                <hr>
                <h4>Status</h4>

                <!-- Status display -->
                <div class="flex-container marginTopBot5">
                    <div class="flex1"><small>Backend: <b id="um-status-backend">LanceDB</b></small></div>
                    <div class="flex1"><small>Pending: <b id="um-status-pending">0</b></small></div>
                    <div class="flex1"><small>Cached: <b id="um-status-cached">0</b></small></div>
                </div>

                <!-- Action buttons -->
                <div class="flex-container marginTopBot5">
                    <div id="um-btn-test" class="menu_button menu_button_icon" title="Test backend connection">
                        <i class="fa-solid fa-heartbeat"></i>
                        <span>Test</span>
                    </div>
                    <div id="um-btn-summarize-now" class="menu_button menu_button_icon" title="Summarize pending messages now">
                        <i class="fa-solid fa-play"></i>
                        <span>Summarize</span>
                    </div>
                    <div id="um-btn-purge" class="menu_button menu_button_icon" title="Delete all memories for this chat">
                        <i class="fa-solid fa-trash"></i>
                        <span>Purge</span>
                    </div>
                </div>
                <div class="flex-container marginTopBot5">
                    <div id="um-btn-global-manage" class="menu_button menu_button_icon" title="Manage all memories across all characters and chats">
                        <i class="fa-solid fa-database"></i>
                        <span>Global Manage</span>
                    </div>
                    <div id="um-btn-stats" class="menu_button menu_button_icon" title="View statistics">
                        <i class="fa-solid fa-chart-bar"></i>
                        <span>Stats</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;
}

/**
 * Setup UI event handlers
 */
function setupUIHandlers() {
    // ChatML toggle
    $('#um-use-chatml').on('change', function () {
        settings.useChatML = $(this).is(':checked');
        saveSettings();
    });

    // Connection profile
    $('#um-connection-profile').on('change', function () {
        settings.connectionProfile = $(this).val();
        saveSettings();
    });

    // Max tokens
    $('#um-max-tokens').on('input', function () {
        settings.summaryMaxTokens = parseInt($(this).val()) || 150;
        saveSettings();
    });

    // Number inputs
    $('#um-min-turn').on('input', function () {
        settings.minTurnToStartSummary = parseInt($(this).val()) || 10;
        saveSettings();
    });

    $('#um-context-window').on('input', function () {
        settings.contextWindowForSummary = parseInt($(this).val()) || 3;
        saveSettings();
    });

    $('#um-max-retrieved').on('input', function () {
        settings.maxRetrievedSummaries = parseInt($(this).val()) || 10;
        saveSettings();
    });

    $('#um-recent-n').on('input', function () {
        settings.alwaysIncludeRecentN = parseInt($(this).val()) || 3;
        saveSettings();
    });

    $('#um-threshold').on('input', function () {
        settings.scoreThreshold = parseFloat($(this).val()) || 0.5;
        saveSettings();
    });

    // Text inputs
    $('#um-injection-var').on('change', function () {
        settings.injectionVariable = $(this).val();
        saveSettings();
    });

    $('#um-summary-prompt').on('change', function () {
        settings.summaryPrompt = $(this).val();
        saveSettings();
    });

    // Context format handlers
    $('#um-ctx-user').on('change', function () {
        if (!settings.contextFormat) settings.contextFormat = {};
        settings.contextFormat.user = $(this).val() || '{{user}}';
        saveSettings();
    });

    $('#um-ctx-char').on('change', function () {
        if (!settings.contextFormat) settings.contextFormat = {};
        settings.contextFormat.char = $(this).val() || '{{char}}';
        saveSettings();
    });

    $('#um-ctx-separator').on('change', function () {
        if (!settings.contextFormat) settings.contextFormat = {};
        settings.contextFormat.separator = $(this).val();
        saveSettings();
    });

    $('#um-memory-template').on('change', function () {
        settings.memoryTemplate = $(this).val();
        saveSettings();
    });

    $('#um-memory-separator').on('change', function () {
        // Convert escaped newlines back to actual newlines
        settings.memorySeparator = $(this).val().replace(/\\n/g, '\n');
        saveSettings();
    });

    // Behavior toggles
    $('#um-skip-user').on('change', function () {
        settings.skipUserTurns = $(this).is(':checked');
        saveSettings();
    });

    $('#um-auto-resummarize').on('change', function () {
        settings.autoResummarizeOnEdit = $(this).is(':checked');
        saveSettings();
    });

    $('#um-delete-on-delete').on('change', function () {
        settings.deleteMemoryOnMsgDelete = $(this).is(':checked');
        saveSettings();
    });

    // Buttons
    $('#um-btn-test').on('click', async function () {
        $(this).prop('disabled', true);
        try {
            const result = await backend.healthCheck();
            toastr.info(`Backend health: ${result.healthy ? 'OK' : 'Failed'} - ${result.message || ''}`);
        } catch (error) {
            toastr.error(`Backend test failed: ${error.message}`);
        }
        $(this).prop('disabled', false);
    });

    $('#um-btn-summarize-now').on('click', async function () {
        $(this).prop('disabled', true);
        try {
            await checkAndSummarize();
            toastr.success('Summarization complete');
        } catch (error) {
            toastr.error(`Summarization failed: ${error.message}`);
        }
        $(this).prop('disabled', false);
    });

    $('#um-btn-purge').on('click', async function () {
        if (!confirm('Are you sure you want to delete all memories for the current chat?')) {
            return;
        }

        $(this).prop('disabled', true);
        try {
            const collectionId = getCollectionId();
            if (collectionId) {
                await backend.purge(collectionId);
                memoryMetadataCache.clear();
                purgeCollectionMetadata(collectionId); // Also clear persistent storage
                toastr.success('All memories purged');
            }
        } catch (error) {
            toastr.error(`Purge failed: ${error.message}`);
        }
        $(this).prop('disabled', false);
    });

    // View Stats button
    $('#um-btn-stats').on('click', async function () {
        const collectionId = getCollectionId();
        let totalMemories = 0;
        let backendHealthy = false;

        try {
            if (collectionId) {
                const hashes = await backend.list(collectionId);
                totalMemories = hashes.filter(h => h).length;
            }
            const health = await backend.healthCheck();
            backendHealthy = health.healthy;
        } catch (error) {
            console.error('Stats error:', error);
        }

        showStatsPopup({
            totalMemories,
            withEmbeddings: totalMemories, // Assume all have embeddings
            pending: pendingSummaries.size,
            cacheSize: memoryMetadataCache.size,
            backend: 'lancedb',
            backendHealthy,
        });
    });

    // Global Manage button
    $('#um-btn-global-manage').on('click', async function () {
        await showGlobalMemoryManagementPopup({
            getAllCollections: () => getAllCollectionsData(),
            purgeCollection: async (collectionId) => {
                await purgeCollection(collectionId);
            },
            cleanupOrphaned: async () => {
                return await cleanupOrphanedCollections();
            },
            getCharacterName: (characterId) => {
                const context = getContext();
                const character = context.characters?.[characterId];
                return character?.name || `Character ${characterId}`;
            },
            // New options for collection detail view
            getMemoriesForCollection: async (collectionId) => {
                const persistentData = getCollectionMetadata(collectionId);
                const memories = [];

                for (const [hash, metadata] of Object.entries(persistentData)) {
                    // Skip collection info metadata
                    if (hash === '__collection_info__') continue;

                    memories.push({
                        hash,
                        text: metadata.summary || '(no summary)',
                        turnIndex: metadata.turnIndex || 0,
                        msgId: metadata.msgId || '',
                        createdAt: metadata.createdAt || 0,
                    });
                }

                return memories.sort((a, b) => (b.turnIndex || 0) - (a.turnIndex || 0));
            },
            deleteMemory: async (collectionId, hash) => {
                // Delete from persistent storage first (primary source)
                memoryMetadataCache.delete(hash);
                deleteMetadataPersistent(collectionId, hash);
                // Then try to delete from backend (if healthy)
                if (backendHealthy && backend) {
                    try {
                        await backend.delete(collectionId, [hash]);
                    } catch (e) {
                        console.warn(`[${MODULE_NAME}] Backend delete failed (already deleted from persistent):`, e.message);
                    }
                }
            },
            editMemory: async (collectionId, hash, newText) => {
                const persistentData = getCollectionMetadata(collectionId);
                const metadata = persistentData[hash];
                if (metadata) {
                    metadata.summary = newText;
                    metadata.updatedAt = Date.now();
                    saveMetadataPersistent(collectionId, hash, metadata);
                    // Also update in cache if present
                    if (memoryMetadataCache.has(hash)) {
                        memoryMetadataCache.set(hash, metadata);
                    }
                }
            },
            regenerateMemory: async (collectionId, hash, msgId) => {
                // Check if this collection is the current chat
                const currentCollectionId = getCollectionId();
                if (collectionId !== currentCollectionId) {
                    throw new Error('Can only regenerate for current chat. Please switch to this chat first.');
                }

                const context = getContext();
                const chat = context.chat;

                // Find original message
                const messageIndex = chat.findIndex(m => normalizeMessageId(m) === msgId);
                if (messageIndex < 0) {
                    throw new Error('Original message not found in current chat');
                }

                const message = chat[messageIndex];

                // Generate new summary
                const summary = await generateSummary(message, chat, messageIndex);
                if (!summary) {
                    throw new Error('Failed to generate summary');
                }

                // Delete old memory
                await backend.delete(collectionId, [hash]);
                deleteMetadataPersistent(collectionId, hash);
                memoryMetadataCache.delete(hash);

                // Store new memory
                const contentHash = getStringHash(message.mes);
                const turnNumber = calculateTurnNumber(chat, messageIndex, !settings.skipUserTurns);
                await storeMemory(msgId, summary, contentHash, turnNumber, context.chatId);
            },
        });
    });

    // Update status periodically (store interval ID for cleanup)
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
    }
    statusUpdateInterval = setInterval(() => {
        $('#um-status-pending').text(pendingSummaries.size);
        $('#um-status-cached').text(memoryMetadataCache.size);
    }, 1000);

    // Populate connection profiles dropdown
    populateConnectionProfiles();
}

/**
 * Populate the connection profiles dropdown with available profiles
 */
function populateConnectionProfiles() {
    const context = getContext();
    const $select = $('#um-connection-profile');

    // Keep the "Auto" option
    $select.find('option:not(:first)').remove();

    // Check if connection manager is available
    if (!context.extensionSettings?.connectionManager?.profiles) {
        return;
    }

    const profiles = context.extensionSettings.connectionManager.profiles;

    // Add available profiles
    for (const profile of profiles) {
        if (profile.api) {
            const $option = $('<option></option>')
                .val(profile.id)
                .text(profile.name || profile.id);

            if (settings.connectionProfile === profile.id) {
                $option.prop('selected', true);
            }

            $select.append($option);
        }
    }
}

/**
 * Add chat control button to hamburger menu (#options) for memory management access
 */
function addChatControlButton() {
    // Remove any existing button first
    $('#option_um_memory').remove();

    if (!settings) {
        return;
    }

    // Create menu item for hamburger menu
    const menuItem = $(`
        <a id="option_um_memory">
            <i class="fa-lg fa-solid fa-brain"></i>
            <span data-i18n="UwU Memory">UwU Memory</span>
        </a>
    `);

    // Find insertion point in options menu (after settings is a good location)
    const $optionsContent = $('#options .options-content');
    if ($optionsContent.length === 0) {
        return;
    }

    const $insertPoint = $('#option_settings');
    if ($insertPoint.length) {
        $insertPoint.after(menuItem);
    } else {
        $optionsContent.append(menuItem);
    }

    // Add click handler
    menuItem.on('click', async function () {
        const collectionId = getCollectionId();
        if (!collectionId) {
            toastr.warning('No chat selected');
            return;
        }

        await showMemoryManagementPopup({
            getMemories: async () => {
                const persistentData = getCollectionMetadata(collectionId);
                const memories = [];

                for (const [hash, metadata] of Object.entries(persistentData)) {
                    // Skip collection info metadata
                    if (hash === '__collection_info__') continue;

                    memories.push({
                        hash,
                        text: metadata.summary || '(no summary)',
                        turnIndex: metadata.turnIndex || 0,
                        msgId: metadata.msgId || '',
                        createdAt: metadata.createdAt || 0,
                    });
                }

                return memories.sort((a, b) => (b.turnIndex || 0) - (a.turnIndex || 0));
            },
            onDelete: async (hash) => {
                // Delete from persistent storage first (primary source)
                memoryMetadataCache.delete(hash);
                deleteMetadataPersistent(collectionId, hash);
                // Then try to delete from backend (if healthy)
                if (backendHealthy && backend) {
                    try {
                        await backend.delete(collectionId, [hash]);
                    } catch (e) {
                        console.warn(`[${MODULE_NAME}] Backend delete failed (already deleted from persistent):`, e.message);
                    }
                }
            },
            onEdit: async (hash, newText) => {
                const metadata = memoryMetadataCache.get(hash);
                if (metadata) {
                    metadata.summary = newText;
                    metadata.updatedAt = Date.now();
                    saveMetadataPersistent(collectionId, hash, metadata);
                }
            },
            onViewOriginal: (msgId) => {
                const context = getContext();
                const chat = context.chat;
                const index = chat.findIndex(m => normalizeMessageId(m) === msgId);
                if (index >= 0) {
                    const messageElement = $(`.mes[mesid="${index}"]`);
                    if (messageElement.length) {
                        messageElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                        messageElement.addClass('flash');
                        setTimeout(() => messageElement.removeClass('flash'), 1500);
                    }
                } else {
                    toastr.warning(`Message not found in current chat (ID: ${msgId})`);
                }
            },
            onRegenerate: async (hash, msgId) => {
                const context = getContext();
                const chat = context.chat;

                // Find original message
                const messageIndex = chat.findIndex(m => normalizeMessageId(m) === msgId);
                if (messageIndex < 0) {
                    throw new Error('Original message not found in current chat');
                }

                const message = chat[messageIndex];

                // Generate new summary
                const summary = await generateSummary(message, chat, messageIndex);
                if (!summary) {
                    throw new Error('Failed to generate summary');
                }

                // Delete old memory
                await backend.delete(collectionId, [hash]);
                deleteMetadataPersistent(collectionId, hash);
                memoryMetadataCache.delete(hash);

                // Store new memory
                const contentHash = getStringHash(message.mes);
                const turnNumber = calculateTurnNumber(chat, messageIndex, !settings.skipUserTurns);
                await storeMemory(msgId, summary, contentHash, turnNumber, context.chatId);
            },
        });
    });
}

/**
 * Remove chat control button from hamburger menu
 */
function removeChatControlButton() {
    $('#option_um_memory').remove();
}

/**
 * Main initialization
 */
jQuery(async () => {
    console.log(`[${MODULE_NAME}] Initializing...`);

    // Initialize settings
    initSettings();

    // Initialize backend (async - checks health)
    await initBackend();

    // Create and append settings UI
    const settingsHtml = createSettingsHtml();
    $('#extensions_settings2').append(settingsHtml);

    // Setup UI handlers
    setupUIHandlers();

    // Update backend status UI now that DOM elements exist
    updateBackendStatusUI();

    // Get event source
    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes;

    // Clear any previously registered handlers (prevents duplicates on re-init)
    cleanupEventHandlers();

    // Helper to register and track event handlers
    const registerHandler = (eventType, handler) => {
        if (!eventType) return;
        eventSource.on(eventType, handler);
        registeredEventHandlers.push({ eventSource, eventType, handler });
    };

    // Register event handlers (tracked for cleanup)
    registerHandler(eventTypes.MESSAGE_RECEIVED, debouncedCheckAndSummarize);
    registerHandler(eventTypes.MESSAGE_SENT, debouncedCheckAndSummarize);
    registerHandler(eventTypes.MESSAGE_EDITED, handleMessageEdited);
    registerHandler(eventTypes.MESSAGE_DELETED, handleMessageDeleted);
    registerHandler(eventTypes.CHAT_CHANGED, handleChatChanged);

    // Register handlers for character/chat deletion events (data cleanup)
    registerHandler(eventTypes.CHARACTER_DELETED, handleCharacterDeleted);
    registerHandler(eventTypes.CHAT_DELETED, handleChatDeleted);
    registerHandler(eventTypes.GROUP_CHAT_DELETED, handleGroupChatDeleted);

    // Named handler for GENERATE_BEFORE_COMBINE_PROMPTS
    const handleBeforeCombinePrompts = () => {
        // CRITICAL: Update memory from cache SYNCHRONOUSLY first
        // This ensures macro has data even if async operations haven't completed
        updateFormattedMemoryFromCache();
    };

    // Register for GENERATE_BEFORE_COMBINE_PROMPTS - fires BEFORE prompts are combined and macros evaluated
    // This is the critical timing point for macro injection to work
    if (eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS) {
        registerHandler(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, handleBeforeCombinePrompts);
    } else {
        console.warn(`[${MODULE_NAME}] GENERATE_BEFORE_COMBINE_PROMPTS event not available`);
    }

    // Named handler for GENERATION_AFTER_COMMANDS
    const handleAfterCommands = () => {
        // CRITICAL: Update memory from cache SYNCHRONOUSLY
        // Async handlers don't block event emitter - macro is evaluated before async completes
        updateFormattedMemoryFromCache();
    };

    // Also try GENERATION_AFTER_COMMANDS as fallback (fires early in generation pipeline)
    if (eventTypes.GENERATION_AFTER_COMMANDS) {
        registerHandler(eventTypes.GENERATION_AFTER_COMMANDS, handleAfterCommands);
    }

    // Register macro for prompt injection using MacrosParser directly
    // The macro returns the current formatted memory which is populated before prompt combination
    const macroName = settings.injectionVariable || 'summarizedMemory';
    MacrosParser.registerMacro(macroName, () => {
        return currentFormattedMemory;
    }, 'Returns summarized memories from UwU Memory extension');

    // Expose debug function for troubleshooting
    window.uwuMemoryDebug = {
        getMacroValue: () => currentFormattedMemory,
        getMemoryCache: () => Object.fromEntries(memoryMetadataCache),
        getSettings: () => settings,
        getCollectionId: () => getCollectionId(),
        testMacro: () => {
            const fn = MacrosParser.get(macroName);
            if (fn) {
                console.log(`Macro function exists, calling it...`);
                const result = typeof fn === 'function' ? fn() : fn;
                console.log(`Macro result (${result.length} chars):`, result.substring(0, 200));
                return result;
            } else {
                console.error(`Macro {{${macroName}}} not found in MacrosParser`);
                return null;
            }
        },
        forceHydrate: async () => {
            await hydrateMetadataCache(true);
            console.log(`Cache hydrated: ${memoryMetadataCache.size} entries`);
        },
        forcePrepare: async () => {
            await prepareMemoryForGeneration();
            console.log(`Memory prepared: ${currentFormattedMemory.length} chars`);
            return currentFormattedMemory;
        },
        forceUpdateFromCache: () => {
            updateFormattedMemoryFromCache();
            console.log(`Memory updated from cache: ${currentFormattedMemory.length} chars`);
            return currentFormattedMemory;
        },
        getPersistentData: () => {
            const collectionId = getCollectionId();
            if (!collectionId) return {};
            return getCollectionMetadata(collectionId);
        },
        getSummarizedIds: async () => {
            const ids = await getSummarizedMessageIds();
            console.log(`Summarized message IDs (${ids.size}):`, [...ids]);
            return ids;
        },
        syncStorage: async () => {
            const result = await syncStorageWithBackend();
            console.log(`Sync result:`, result);
            return result;
        },
        syncUnvectorized: async () => {
            const result = await syncUnvectorizedToBackend();
            console.log(`Sync unvectorized result:`, result);
            return result;
        },
        getBackendHealth: () => ({ healthy: backendHealthy, backend: backend ? 'LanceDB' : 'none', syncLocked: syncMutex.isLocked }),
        // RAG debugging tools
        testRAG: async () => {
            const context = getContext();
            const chat = context.chat;
            const collectionId = getCollectionId();

            console.log('=== RAG Debug ===');
            console.log('1. Backend healthy:', backendHealthy);
            console.log('2. Collection ID:', collectionId);
            console.log('3. Chat length:', chat?.length || 0);

            if (!backendHealthy) {
                console.error('❌ Backend is not healthy - RAG cannot work');
                return { error: 'Backend not healthy' };
            }

            if (!collectionId) {
                console.error('❌ No collection ID - no chat selected?');
                return { error: 'No collection ID' };
            }

            // Check persistent data
            const persistentData = getCollectionMetadata(collectionId);
            const summaryCount = Object.keys(persistentData).filter(k => k !== '__collection_info__').length;
            console.log('4. Summaries in persistent storage:', summaryCount);

            // Check backend
            try {
                const backendHashes = await backend.list(collectionId);
                console.log('5. Hashes in backend (LanceDB):', backendHashes.length);

                if (backendHashes.length === 0) {
                    console.warn('⚠️ No vectors in backend - summaries not vectorized');
                    console.warn('   Run: await window.uwuMemoryDebug.syncUnvectorized()');
                }
            } catch (e) {
                console.error('5. Failed to list backend hashes:', e.message);
            }

            // Build query
            const queryText = buildQueryFromRecentMessages(chat);
            console.log('6. Query text (last message):', queryText.substring(0, 200) + '...');

            // Try actual vector search
            try {
                const results = await backend.query(
                    collectionId,
                    queryText,
                    settings.maxRetrievedSummaries || 10,
                    settings.scoreThreshold || 0
                );
                console.log('7. Vector search results:', results.length);
                if (results.length > 0) {
                    console.log('   First result score:', results[0].score);
                    console.log('   First result text preview:', (results[0].text || '').substring(0, 100));
                }
                return { success: true, results: results.length, query: queryText.substring(0, 100) };
            } catch (e) {
                console.error('7. Vector search failed:', e.message);
                return { error: e.message };
            }
        },
        listBackendHashes: async () => {
            const collectionId = getCollectionId();
            if (!collectionId || !backend) {
                console.error('No collection or backend');
                return [];
            }
            const hashes = await backend.list(collectionId);
            console.log(`Backend has ${hashes.length} hashes:`, hashes);
            return hashes;
        },
        /**
         * Custom RAG query - 커스텀 쿼리로 검색
         * @param {string} query - 검색 쿼리
         * @param {number} limit - 검색 결과 수 (기본값: 10)
         */
        queryRAG: async (query, limit = 10) => {
            const collectionId = getCollectionId();
            if (!collectionId || !backend || !backendHealthy) {
                console.error('Backend not available');
                return [];
            }

            console.log('=== Custom RAG Query ===');
            console.log(`Query: "${query}"`);
            console.log(`Limit: ${limit}\n`);

            try {
                const results = await backend.query(collectionId, query, limit, 0);

                results.forEach((r, i) => {
                    const pct = (r.score * 100).toFixed(1);
                    const bar = '█'.repeat(Math.round(r.score * 20)) + '░'.repeat(20 - Math.round(r.score * 20));
                    console.log(`#${i + 1} [${pct}%] ${bar}`);
                    console.log(`${r.text || '(empty)'}\n`);
                });

                console.log(`Total: ${results.length} results`);
                return results;
            } catch (e) {
                console.error('Query failed:', e.message);
                return [];
            }
        },
        /**
         * System RAG search - 시스템 기본 방식 (최근 메시지 기반)
         * @param {number} displayLimit - 출력할 메모리 수 (기본값: 전체)
         */
        searchRAG: async (displayLimit = 0) => {
            const collectionId = getCollectionId();
            if (!collectionId || !backend || !backendHealthy) {
                console.error('Backend not available');
                return [];
            }

            const context = getContext();
            const query = buildQueryFromRecentMessages(context.chat);
            const topK = settings.maxRetrievedSummaries || 10;

            console.log('=== System RAG Search (last message) ===');
            console.log(`Query:\n${query}`);
            console.log(`\nTopK: ${topK}${displayLimit > 0 ? `, Display: ${displayLimit}` : ''}\n`);

            try {
                const results = await backend.query(collectionId, query, topK, 0);
                const toShow = displayLimit > 0 ? results.slice(0, displayLimit) : results;

                toShow.forEach((r, i) => {
                    const pct = (r.score * 100).toFixed(1);
                    const bar = '█'.repeat(Math.round(r.score * 20)) + '░'.repeat(20 - Math.round(r.score * 20));
                    console.log(`#${i + 1} [${pct}%] ${bar}`);
                    console.log(`${r.text || '(empty)'}\n`);
                });

                console.log(`Total: ${results.length} results`);
                return results;
            } catch (e) {
                console.error('Search failed:', e.message);
                return [];
            }
        },
    };

    // Hydrate metadata cache for current chat (if any)
    // This restores memories from backend on page load/refresh
    setTimeout(async () => {
        try {
            await hydrateMetadataCache();
            // Add chat control button after UI is ready
            addChatControlButton();
        } catch (error) {
            console.error(`[${MODULE_NAME}] Initial cache hydration failed:`, error);
        }
    }, 1000); // Delay to ensure chat is loaded

    console.log(`[${MODULE_NAME}] Initialized successfully. Debug tools available at window.uwuMemoryDebug`);
});
