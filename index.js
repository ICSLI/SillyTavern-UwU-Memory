/**
 * UwU Memory - LanceDB Server Plugin
 * Provides high-performance vector storage for large collections
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getTransformersVector } from '../../src/vectors/embedding.js';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin info (required by SillyTavern)
export const info = {
    id: 'uwu-memory',
    name: 'UwU Memory LanceDB Backend',
    description: 'LanceDB vector storage backend for UwU Memory extension',
};

// State
let lancedb = null;
let dbConnections = new Map(); // path -> db connection
const DB_BASE_DIR = path.join(__dirname, 'db');

/**
 * Escape value for SQL-style filter expression to prevent injection
 * @param {string} value - Value to escape
 * @returns {string} Escaped value
 */
function escapeFilterValue(value) {
    if (typeof value !== 'string') {
        return String(value);
    }
    // Escape backslashes first, then double quotes
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Get or create database connection for a user
 * @param {string} userId - User handle/ID
 * @returns {Promise<object>}
 */
async function getDatabase(userId) {
    // Sanitize userId to prevent path traversal attacks
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dbPath = path.join(DB_BASE_DIR, sanitizedUserId);

    if (dbConnections.has(dbPath)) {
        return dbConnections.get(dbPath);
    }

    // Ensure directory exists
    if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
    }

    const db = await lancedb.connect(dbPath);
    dbConnections.set(dbPath, db);

    return db;
}

/**
 * Get or create table for collection
 * @param {object} db - Database connection
 * @param {string} collectionId - Collection ID
 * @param {number} dimensions - Embedding dimensions (default 384 for transformers)
 * @returns {Promise<object>}
 */
async function getTable(db, collectionId, dimensions = 384) {
    const tableName = `um_${collectionId}`;

    try {
        // Try to open existing table
        const table = await db.openTable(tableName);
        return table;
    } catch (error) {
        // Table doesn't exist, create it
        console.log(`[uwu-memory] Creating table: ${tableName}`);

        // Create with initial schema
        const table = await db.createTable(tableName, [
            {
                hash: 'initial',
                text: '',
                index: 0,
                vector: new Array(dimensions).fill(0),
                metadata: '{}',
            },
        ]);

        // Delete the initial row
        await table.delete('hash = "initial"');

        return table;
    }
}

/**
 * Generate embedding using SillyTavern's built-in Transformers
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text) {
    return await getTransformersVector(text);
}

/**
 * Initialize plugin routes
 * @param {express.Router} router - Express router
 */
export async function init(router) {
    console.log('[uwu-memory] Initializing LanceDB plugin...');

    try {
        // Dynamic import of lancedb
        lancedb = await import('@lancedb/lancedb');
        console.log('[uwu-memory] LanceDB loaded successfully');
    } catch (error) {
        console.error('[uwu-memory] Failed to load LanceDB:', error.message);
        console.error('[uwu-memory] Please run: npm install @lancedb/lancedb');

        // Register error route
        router.all('*', (req, res) => {
            res.status(500).json({
                error: 'LanceDB not available',
                message: 'Please install @lancedb/lancedb package',
            });
        });
        return;
    }

    // Health check
    router.get('/health', (req, res) => {
        res.json({ status: 'ok', backend: 'lancedb' });
    });

    // Insert vectors
    router.post('/insert', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId, items } = req.body;

            if (!collectionId || !items) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);
            const table = await getTable(db, collectionId);

            // Generate embeddings and prepare rows
            const rows = [];
            for (const item of items) {
                const vector = item.vector || await generateEmbedding(item.text);

                rows.push({
                    hash: item.hash,
                    text: item.text,
                    index: item.index || 0,
                    vector,
                    metadata: JSON.stringify(item.metadata || {}),
                });
            }

            await table.add(rows);

            res.json({ success: true, inserted: rows.length });
        } catch (error) {
            console.error('[uwu-memory] Insert error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Query vectors
    router.post('/query', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId, queryText, topK, threshold } = req.body;

            if (!collectionId || !queryText) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);

            let table;
            try {
                table = await getTable(db, collectionId);
            } catch {
                return res.json({ results: [] });
            }

            // Generate query embedding using Transformers
            const queryVector = await generateEmbedding(queryText);

            // Perform vector search
            const results = await table
                .vectorSearch(queryVector)
                .limit(topK || 10)
                .toArray();

            // Filter by threshold and format results
            const filtered = results
                .filter(r => !threshold || (1 - r._distance) >= threshold)
                .map(r => ({
                    hash: r.hash,
                    text: r.text,
                    index: r.index,
                    score: 1 - r._distance, // Convert distance to similarity
                    metadata: JSON.parse(r.metadata || '{}'),
                }));

            res.json({ results: filtered });
        } catch (error) {
            console.error('[uwu-memory] Query error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // List hashes
    router.post('/list', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);

            let table;
            try {
                table = await getTable(db, collectionId);
            } catch {
                return res.json({ hashes: [] });
            }

            const rows = await table.query().select(['hash']).toArray();
            const hashes = rows.map(r => r.hash);

            res.json({ hashes });
        } catch (error) {
            console.error('[uwu-memory] List error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Delete by hashes
    router.post('/delete', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId, hashes } = req.body;

            if (!collectionId || !hashes) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);
            const table = await getTable(db, collectionId);

            // Delete each hash (escape to prevent SQL injection)
            for (const hash of hashes) {
                await table.delete(`hash = "${escapeFilterValue(hash)}"`);
            }

            res.json({ success: true, deleted: hashes.length });
        } catch (error) {
            console.error('[uwu-memory] Delete error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Purge collection
    router.post('/purge', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);
            const tableName = `um_${collectionId}`;

            try {
                await db.dropTable(tableName);
            } catch {
                // Table might not exist
            }

            res.json({ success: true });
        } catch (error) {
            console.error('[uwu-memory] Purge error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get items by hashes
    router.post('/getByHashes', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId, hashes } = req.body;

            if (!collectionId || !hashes) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);

            let table;
            try {
                table = await getTable(db, collectionId);
            } catch {
                return res.json({ items: [] });
            }

            // Build WHERE clause for efficient query (avoid full table scan)
            // Use OR conditions for multiple hashes
            if (hashes.length === 0) {
                return res.json({ items: [] });
            }

            const whereConditions = hashes.map(h => `hash = "${escapeFilterValue(h)}"`).join(' OR ');
            const rows = await table.query()
                .select(['hash', 'text', 'index', 'metadata'])
                .where(whereConditions)
                .toArray();

            const items = rows.map(r => ({
                hash: r.hash,
                text: r.text,
                index: r.index,
                metadata: JSON.parse(r.metadata || '{}'),
            }));

            res.json({ items });
        } catch (error) {
            console.error('[uwu-memory] GetByHashes error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get stats
    router.post('/stats', async (req, res) => {
        try {
            // Get user ID from authenticated request (set by SillyTavern middleware)
            const userId = req.user?.profile?.handle || 'default-user';
            const { collectionId } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const db = await getDatabase(userId);

            let table;
            try {
                table = await getTable(db, collectionId);
            } catch {
                return res.json({ count: 0, hasEmbeddings: false });
            }

            // Count rows efficiently without loading vectors
            // First try countRows, fallback to select hash only
            let count = 0;
            let hasEmbeddings = false;

            try {
                // Try to use countRows if available (LanceDB >= 0.4)
                count = await table.countRows();
                // For hasEmbeddings, we need to check at least one row
                if (count > 0) {
                    const sample = await table.query().limit(1).toArray();
                    hasEmbeddings = sample.length > 0 && sample[0].vector && sample[0].vector.some(v => v !== 0);
                }
            } catch {
                // Fallback: load only hash column for count
                const rows = await table.query().select(['hash']).toArray();
                count = rows.length;
                // For hasEmbeddings, check one row with vector
                if (count > 0) {
                    const sample = await table.query().limit(1).toArray();
                    hasEmbeddings = sample.length > 0 && sample[0].vector && sample[0].vector.some(v => v !== 0);
                }
            }

            res.json({ count, hasEmbeddings });
        } catch (error) {
            console.error('[uwu-memory] Stats error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log('[uwu-memory] LanceDB plugin initialized');
}

/**
 * Cleanup on shutdown
 */
export async function exit() {
    console.log('[uwu-memory] Shutting down LanceDB plugin...');

    // Close all connections
    for (const [path, db] of dbConnections) {
        try {
            // LanceDB connections are automatically managed
            console.log(`[uwu-memory] Closed connection: ${path}`);
        } catch (error) {
            console.error(`[uwu-memory] Error closing ${path}:`, error);
        }
    }

    dbConnections.clear();
}
