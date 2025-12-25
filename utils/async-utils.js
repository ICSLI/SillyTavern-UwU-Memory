/**
 * Async utilities for Context Summarizer
 */

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function}
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Retry with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>}
 */
export async function retry(fn, options = {}) {
    const {
        maxAttempts = 3,
        delay = 1000,
        maxDelay = 10000,
        backoffFactor = 2,
        shouldRetry = () => true,
        onRetry = () => {},
    } = options;

    let lastError;
    let currentDelay = delay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts || !shouldRetry(error)) {
                throw error;
            }

            onRetry(attempt, error);
            await sleep(currentDelay);
            currentDelay = Math.min(currentDelay * backoffFactor, maxDelay);
        }
    }

    throw lastError;
}

/**
 * Simple rate limiter
 */
export class RateLimiter {
    constructor(callsPerInterval, intervalMs) {
        this.callsPerInterval = callsPerInterval;
        this.intervalMs = intervalMs;
        this.calls = [];
    }

    async execute(fn) {
        const now = Date.now();

        // Remove old calls outside the interval
        this.calls = this.calls.filter(time => now - time < this.intervalMs);

        // Wait if at limit
        if (this.calls.length >= this.callsPerInterval) {
            const oldestCall = this.calls[0];
            const waitTime = this.intervalMs - (now - oldestCall);
            if (waitTime > 0) {
                await sleep(waitTime);
            }
            this.calls = this.calls.filter(time => Date.now() - time < this.intervalMs);
        }

        this.calls.push(Date.now());
        return fn();
    }
}

/**
 * Calculate MD5 hash of string (simple implementation for content hashing)
 * @param {string} str - String to hash
 * @returns {string} - Hash string
 */
export function calculateHash(str) {
    let hash = 0;
    if (str.length === 0) return hash.toString(16);

    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    // Convert to hex and ensure positive
    return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Wait until condition is met
 * @param {Function} condition - Condition function
 * @param {number} timeout - Timeout in ms
 * @param {number} interval - Check interval in ms
 * @returns {Promise<void>}
 */
export async function waitUntilCondition(condition, timeout = 10000, interval = 100) {
    const startTime = Date.now();

    while (!condition()) {
        if (Date.now() - startTime > timeout) {
            throw new Error('Wait condition timeout');
        }
        await sleep(interval);
    }
}

/**
 * Async Mutex for preventing race conditions in async operations
 * Ensures only one async operation runs at a time
 */
export class AsyncMutex {
    constructor() {
        this._locked = false;
        this._queue = [];
    }

    /**
     * Check if mutex is currently locked
     * @returns {boolean}
     */
    get isLocked() {
        return this._locked;
    }

    /**
     * Acquire the lock
     * @returns {Promise<void>}
     */
    async acquire() {
        if (!this._locked) {
            this._locked = true;
            return;
        }

        // Wait in queue
        return new Promise(resolve => {
            this._queue.push(resolve);
        });
    }

    /**
     * Release the lock
     */
    release() {
        if (this._queue.length > 0) {
            // Pass lock to next waiter
            const next = this._queue.shift();
            next();
        } else {
            this._locked = false;
        }
    }

    /**
     * Try to acquire lock without waiting
     * @returns {boolean} Whether lock was acquired
     */
    tryAcquire() {
        if (!this._locked) {
            this._locked = true;
            return true;
        }
        return false;
    }

    /**
     * Execute function with lock (automatically acquires and releases)
     * @param {Function} fn - Async function to execute
     * @returns {Promise<any>} Result of function
     */
    async runExclusive(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
