/**
 * Abstract base class for vector storage backends
 */
export class VectorBackend {
    constructor(settings) {
        this.settings = settings;
    }

    /**
     * Insert items into the vector store
     * @param {string} collectionId - Collection identifier
     * @param {Array<{hash: string, text: string, index: number, metadata?: object}>} items - Items to insert
     * @returns {Promise<{success: boolean, inserted: number}>}
     */
    async insert(collectionId, items) {
        throw new Error('Not implemented');
    }

    /**
     * Query similar items from the vector store
     * @param {string} collectionId - Collection identifier
     * @param {string} queryText - Text to search for
     * @param {number} topK - Number of results to return
     * @param {number} threshold - Minimum similarity threshold
     * @returns {Promise<Array<{hash: string, text: string, index: number, score: number, metadata?: object}>>}
     */
    async query(collectionId, queryText, topK, threshold) {
        throw new Error('Not implemented');
    }

    /**
     * Delete items by hash
     * @param {string} collectionId - Collection identifier
     * @param {string[]} hashes - Hashes to delete
     * @returns {Promise<{success: boolean, deleted: number}>}
     */
    async delete(collectionId, hashes) {
        throw new Error('Not implemented');
    }

    /**
     * List all hashes in collection
     * @param {string} collectionId - Collection identifier
     * @returns {Promise<string[]>}
     */
    async list(collectionId) {
        throw new Error('Not implemented');
    }

    /**
     * Get items by hashes
     * @param {string} collectionId - Collection identifier
     * @param {string[]} hashes - Hashes to retrieve
     * @returns {Promise<Array<{hash: string, text: string, index: number, metadata?: object}>>}
     */
    async getByHashes(collectionId, hashes) {
        throw new Error('Not implemented');
    }

    /**
     * Purge entire collection
     * @param {string} collectionId - Collection identifier
     * @returns {Promise<{success: boolean}>}
     */
    async purge(collectionId) {
        throw new Error('Not implemented');
    }

    /**
     * Health check
     * @returns {Promise<{healthy: boolean, message?: string}>}
     */
    async healthCheck() {
        throw new Error('Not implemented');
    }

    /**
     * Get backend name
     * @returns {string}
     */
    getName() {
        throw new Error('Not implemented');
    }
}

/**
 * Backend factory
 */
export class BackendFactory {
    static backends = new Map();

    static register(name, BackendClass) {
        BackendFactory.backends.set(name, BackendClass);
    }

    static create(name, settings) {
        const BackendClass = BackendFactory.backends.get(name);
        if (!BackendClass) {
            throw new Error(`Unknown backend: ${name}`);
        }
        return new BackendClass(settings);
    }

    static getAvailableBackends() {
        return Array.from(BackendFactory.backends.keys());
    }
}
