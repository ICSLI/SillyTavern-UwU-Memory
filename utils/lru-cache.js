/**
 * LRU Cache implementation for hash caching
 */
export class LRUCache {
    constructor(maxSize = 10000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key) {
        if (!this.cache.has(key)) {
            return undefined;
        }
        const value = this.cache.get(key);
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Delete oldest (first item)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }

    /**
     * Get all keys in the cache
     * @returns {IterableIterator<any>}
     */
    keys() {
        return this.cache.keys();
    }

    /**
     * Get all values in the cache
     * @returns {IterableIterator<any>}
     */
    values() {
        return this.cache.values();
    }

    /**
     * Get all entries in the cache
     * @returns {IterableIterator<[any, any]>}
     */
    entries() {
        return this.cache.entries();
    }

    /**
     * Iterate over all entries
     * @param {Function} callback - Callback function
     */
    forEach(callback) {
        this.cache.forEach(callback);
    }

    /**
     * Symbol.iterator for for...of loops
     */
    [Symbol.iterator]() {
        return this.cache[Symbol.iterator]();
    }
}
