import { VectorBackend, BackendFactory } from './backend-interface.js';

/**
 * Vectra backend using SillyTavern's built-in vector API
 */
export class VectraBackend extends VectorBackend {
    constructor(settings) {
        super(settings);
        this.getRequestHeaders = null; // Will be set during initialization
    }

    /**
     * Initialize with request headers function
     * @param {Function} getRequestHeaders - Function to get request headers
     */
    init(getRequestHeaders) {
        this.getRequestHeaders = getRequestHeaders;
    }

    getName() {
        return 'vectra';
    }

    /**
     * Build request body for vector API
     * @returns {object}
     */
    getVectorRequestBody() {
        return {
            source: 'transformers',
        };
    }

    async insert(collectionId, items) {
        if (!this.getRequestHeaders) {
            throw new Error('VectraBackend not initialized');
        }

        const requestBody = {
            ...this.getVectorRequestBody(),
            collectionId,
            items: items.map(item => ({
                hash: item.hash,
                text: item.text,
                index: item.index,
            })),
        };

        try {
            const response = await fetch('/api/vector/insert', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const responseText = await response.text();
                throw new Error(`Insert failed: ${response.status} ${response.statusText} - ${responseText}`);
            }

            return { success: true, inserted: items.length };
        } catch (error) {
            console.error('VectraBackend insert error:', error);
            throw error;
        }
    }

    async query(collectionId, queryText, topK, threshold) {
        if (!this.getRequestHeaders) {
            throw new Error('VectraBackend not initialized');
        }

        try {
            const response = await fetch('/api/vector/query', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorRequestBody(),
                    collectionId,
                    searchText: queryText,
                    topK,
                    threshold: threshold || 0.0,
                }),
            });

            if (!response.ok) {
                throw new Error(`Query failed: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();

            // Transform result to standard format
            // The API returns { hashes: string[], metadata: object[] }
            if (!result.hashes || !Array.isArray(result.hashes)) {
                return [];
            }

            return result.hashes.map((hash, idx) => ({
                hash,
                text: result.metadata?.[idx]?.text || '',
                index: result.metadata?.[idx]?.index || 0,
                score: result.metadata?.[idx]?.score || 0,
                metadata: result.metadata?.[idx] || {},
            }));
        } catch (error) {
            console.error('VectraBackend query error:', error);
            throw error;
        }
    }

    async delete(collectionId, hashes) {
        if (!this.getRequestHeaders) {
            throw new Error('VectraBackend not initialized');
        }

        try {
            const response = await fetch('/api/vector/delete', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorRequestBody(),
                    collectionId,
                    hashes,
                }),
            });

            if (!response.ok) {
                throw new Error(`Delete failed: ${response.status} ${response.statusText}`);
            }

            return { success: true, deleted: hashes.length };
        } catch (error) {
            console.error('VectraBackend delete error:', error);
            throw error;
        }
    }

    async list(collectionId) {
        if (!this.getRequestHeaders) {
            throw new Error('VectraBackend not initialized');
        }

        try {
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorRequestBody(),
                    collectionId,
                }),
            });

            if (!response.ok) {
                // Collection might not exist yet
                if (response.status === 404) {
                    return [];
                }
                throw new Error(`List failed: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            return Array.isArray(result) ? result : (result.hashes || []);
        } catch (error) {
            console.error('VectraBackend list error:', error);
            return [];
        }
    }

    async getByHashes(collectionId, hashes) {
        // Vectra doesn't have a direct getByHashes, so we query and filter
        // This is a limitation - for now return empty
        // In production, you'd want to store metadata separately
        console.warn('VectraBackend.getByHashes: Not directly supported, returning empty');
        return [];
    }

    async purge(collectionId) {
        if (!this.getRequestHeaders) {
            throw new Error('VectraBackend not initialized');
        }

        try {
            const response = await fetch('/api/vector/purge', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    collectionId,
                }),
            });

            if (!response.ok) {
                throw new Error(`Purge failed: ${response.status} ${response.statusText}`);
            }

            return { success: true };
        } catch (error) {
            console.error('VectraBackend purge error:', error);
            throw error;
        }
    }

    async healthCheck() {
        if (!this.getRequestHeaders) {
            return { healthy: false, message: 'Not initialized' };
        }

        try {
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorRequestBody(),
                    collectionId: '__health_check__',
                }),
            });

            return {
                healthy: response.ok || response.status === 404,
                message: response.ok ? 'OK' : `Status: ${response.status}`,
            };
        } catch (error) {
            return { healthy: false, message: error.message };
        }
    }
}

// Register backend
BackendFactory.register('vectra', VectraBackend);
