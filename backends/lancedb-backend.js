import { VectorBackend, BackendFactory } from './backend-interface.js';

/**
 * LanceDB backend using server plugin
 */
export class LanceDBBackend extends VectorBackend {
    constructor(settings) {
        super(settings);
        this.getRequestHeaders = null;
    }

    /**
     * Initialize with request headers function
     * @param {Function} getRequestHeaders - Function to get request headers
     */
    init(getRequestHeaders) {
        this.getRequestHeaders = getRequestHeaders;
        // User identification is now handled server-side via req.user
    }

    getName() {
        return 'lancedb';
    }

    /**
     * Get headers with Content-Type for JSON requests
     * @returns {object}
     */
    getJsonHeaders() {
        const baseHeaders = this.getRequestHeaders ? this.getRequestHeaders() : {};
        return {
            ...baseHeaders,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Build embedding config for server
     * @returns {object}
     */
    getEmbeddingConfig() {
        return {
            source: this.settings.embeddingSource || 'transformers',
            model: this.getModelForSource(),
            apiKey: this.settings.apiKey || '',
            apiUrl: this.settings.apiUrl || '',
        };
    }

    /**
     * Get model name for current embedding source
     * @returns {string}
     */
    getModelForSource() {
        switch (this.settings.embeddingSource) {
            case 'openai':
                return this.settings.openaiModel || 'text-embedding-3-small';
            case 'ollama':
                return this.settings.ollamaModel || 'nomic-embed-text';
            case 'cohere':
                return this.settings.cohereModel || 'embed-english-v3.0';
            default:
                return '';
        }
    }

    async insert(collectionId, items) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/insert', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                    items: items.map(item => ({
                        hash: item.hash,
                        text: item.text,
                        index: item.index,
                        metadata: item.metadata || {},
                    })),
                    embeddingConfig: this.getEmbeddingConfig(),
                    dimensions: this.settings.embeddingDimensions || 384,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Insert failed: ${response.status}`);
            }

            const result = await response.json();
            return { success: true, inserted: result.inserted };
        } catch (error) {
            console.error('LanceDBBackend insert error:', error);
            throw error;
        }
    }

    async query(collectionId, queryText, topK, threshold) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/query', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                    queryText,
                    topK,
                    threshold: threshold || 0.0,
                    embeddingConfig: this.getEmbeddingConfig(),
                    dimensions: this.settings.embeddingDimensions || 384,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Query failed: ${response.status}`);
            }

            const result = await response.json();
            return result.results || [];
        } catch (error) {
            console.error('LanceDBBackend query error:', error);
            throw error;
        }
    }

    async delete(collectionId, hashes) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/delete', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                    hashes,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Delete failed: ${response.status}`);
            }

            const result = await response.json();
            return { success: true, deleted: result.deleted };
        } catch (error) {
            console.error('LanceDBBackend delete error:', error);
            throw error;
        }
    }

    async list(collectionId) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/list', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                }),
            });

            if (!response.ok) {
                if (response.status === 404) {
                    return [];
                }
                const error = await response.json();
                throw new Error(error.error || `List failed: ${response.status}`);
            }

            const result = await response.json();
            return result.hashes || [];
        } catch (error) {
            console.error('LanceDBBackend list error:', error);
            return [];
        }
    }

    async getByHashes(collectionId, hashes) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        if (!hashes || hashes.length === 0) {
            return [];
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/getByHashes', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                    hashes,
                }),
            });

            if (!response.ok) {
                if (response.status === 404) {
                    return [];
                }
                const error = await response.json();
                throw new Error(error.error || `GetByHashes failed: ${response.status}`);
            }

            const result = await response.json();
            return result.items || [];
        } catch (error) {
            console.error('LanceDBBackend getByHashes error:', error);
            return [];
        }
    }

    async purge(collectionId) {
        if (!this.getRequestHeaders) {
            throw new Error('LanceDBBackend not initialized');
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/purge', {
                method: 'POST',
                headers: this.getJsonHeaders(),
                body: JSON.stringify({
                    collectionId,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Purge failed: ${response.status}`);
            }

            return { success: true };
        } catch (error) {
            console.error('LanceDBBackend purge error:', error);
            throw error;
        }
    }

    async healthCheck() {
        if (!this.getRequestHeaders) {
            return { healthy: false, message: 'Not initialized' };
        }

        try {
            const response = await fetch('/api/plugins/uwu-memory/health', {
                method: 'GET',
                headers: this.getRequestHeaders(),
            });

            if (response.ok) {
                const result = await response.json();
                return { healthy: true, message: `OK (${result.backend})` };
            }

            return { healthy: false, message: `Status: ${response.status}` };
        } catch (error) {
            return { healthy: false, message: error.message };
        }
    }
}

// Register backend
BackendFactory.register('lancedb', LanceDBBackend);
