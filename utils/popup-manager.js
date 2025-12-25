/**
 * Popup Manager for Context Summarizer
 * Uses native <dialog> element for proper modal behavior across all devices
 */

import { sleep } from './async-utils.js';

// Batch processing state
let batchState = {
    isRunning: false,
    isPaused: false,
    shouldStop: false,
    processed: 0,
    total: 0,
    success: 0,
    failed: 0,
};

/**
 * Create a dialog-based popup
 * @param {string} innerHtml - HTML content for the popup
 * @param {object} options - Options
 * @param {boolean} options.wide - Whether to use wide mode
 * @returns {HTMLDialogElement} The dialog element
 */
function createDialogPopup(innerHtml, options = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'um-dialog-popup';
    if (options.wide) {
        dialog.classList.add('um-dialog-wide');
    }

    dialog.innerHTML = `
        <div class="um-dialog-content">
            ${innerHtml}
        </div>
    `;

    document.body.appendChild(dialog);

    // Close on backdrop click only
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            dialog.close();
        }
    });

    // Prevent ALL events from propagating outside the dialog content
    // This prevents clicks/touches from affecting the extension tab behind the popup
    const content = dialog.querySelector('.um-dialog-content');
    const stopAllPropagation = (e) => {
        e.stopPropagation();
    };

    // Stop propagation for all interaction events
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove', 'pointerdown', 'pointerup'].forEach(eventType => {
        content.addEventListener(eventType, stopAllPropagation);
    });

    // Also stop on the dialog itself to prevent any escape
    ['mousedown', 'touchstart', 'pointerdown'].forEach(eventType => {
        dialog.addEventListener(eventType, (e) => {
            // Only stop if it's not on the backdrop (allow backdrop clicks to close)
            if (e.target !== dialog) {
                e.stopPropagation();
            }
        });
    });

    return dialog;
}

/**
 * Show batch regeneration popup
 * @param {object} options - Options
 * @param {Function} options.onProcess - Process callback (item) => Promise
 * @param {Array} options.items - Items to process
 * @param {number} options.batchSize - Batch size
 * @param {number} options.delayMs - Delay between batches
 * @returns {Promise<{success: number, failed: number, total: number}>} Results when popup closes
 */
export function showBatchRegeneratePopup(options) {
    const { onProcess, items, batchSize = 5, delayMs = 500 } = options;

    return new Promise((resolve) => {
        const popupHtml = `
            <div class="um-batch-popup">
                <h3>Batch Regenerate Summaries</h3>
                <div class="um-batch-info">
                    <p>Found <strong>${items.length}</strong> items to process.</p>
                    <p class="um-batch-warning">This may take a while and incur API costs.</p>
                </div>
                <div class="um-batch-options">
                    <div class="flex-container marginTopBot5">
                        <label for="um-batch-limit"><small>Process limit (0 = all):</small></label>
                        <input type="number" id="um-batch-limit" class="text_pole" value="100" min="0" max="${items.length}" style="width: 100px; margin-left: 10px;">
                    </div>
                </div>
                <div class="um-batch-progress" style="display: none;">
                    <div class="um-progress-container">
                        <div class="um-progress-bar">
                            <div class="um-progress-fill" id="um-batch-progress-fill" style="width: 0%"></div>
                        </div>
                        <div class="um-progress-text" id="um-batch-progress-text">0 / 0</div>
                    </div>
                    <div class="um-batch-stats">
                        <span>Success: <strong id="um-batch-success">0</strong></span>
                        <span>Failed: <strong id="um-batch-failed">0</strong></span>
                    </div>
                </div>
                <div class="um-batch-actions">
                    <button class="menu_button" id="um-batch-start">Start</button>
                    <button class="menu_button" id="um-batch-pause" style="display: none;">Pause</button>
                    <button class="menu_button" id="um-batch-stop" style="display: none;">Stop</button>
                    <button class="menu_button" id="um-batch-close">Cancel</button>
                </div>
            </div>
        `;

        const dialog = createDialogPopup(popupHtml);

        // Reset state
        batchState = {
            isRunning: false,
            isPaused: false,
            shouldStop: false,
            processed: 0,
            total: 0,
            success: 0,
            failed: 0,
        };

        const updateProgress = () => {
            const percent = batchState.total > 0 ? (batchState.processed / batchState.total * 100).toFixed(1) : 0;
            dialog.querySelector('#um-batch-progress-fill').style.width = `${percent}%`;
            dialog.querySelector('#um-batch-progress-text').textContent = `${batchState.processed} / ${batchState.total}`;
            dialog.querySelector('#um-batch-success').textContent = batchState.success;
            dialog.querySelector('#um-batch-failed').textContent = batchState.failed;
        };

        const closePopup = () => {
            batchState.shouldStop = true;
            dialog.close();
            dialog.remove();
            resolve({
                success: batchState.success,
                failed: batchState.failed,
                total: batchState.total,
                processed: batchState.processed,
            });
        };

        // Show the dialog
        dialog.showModal();

        // Event handlers using vanilla JS for dialog-scoped elements
        dialog.querySelector('#um-batch-start').addEventListener('click', async () => {
            const limit = parseInt(dialog.querySelector('#um-batch-limit').value) || items.length;
            const itemsToProcess = items.slice(0, limit);

            batchState.total = itemsToProcess.length;
            batchState.isRunning = true;

            // Update UI
            dialog.querySelector('.um-batch-options').style.display = 'none';
            dialog.querySelector('.um-batch-progress').style.display = 'block';
            dialog.querySelector('#um-batch-start').style.display = 'none';
            dialog.querySelector('#um-batch-pause').style.display = 'inline-block';
            dialog.querySelector('#um-batch-stop').style.display = 'inline-block';
            dialog.querySelector('#um-batch-close').textContent = 'Close';

            // Process items
            for (let i = 0; i < itemsToProcess.length; i += batchSize) {
                if (batchState.shouldStop) break;

                // Wait while paused
                while (batchState.isPaused && !batchState.shouldStop) {
                    await sleep(100);
                }

                if (batchState.shouldStop) break;

                const batch = itemsToProcess.slice(i, i + batchSize);

                for (const item of batch) {
                    if (batchState.shouldStop) break;

                    try {
                        await onProcess(item);
                        batchState.success++;
                    } catch (error) {
                        console.error('Batch process error:', error);
                        batchState.failed++;
                    }

                    batchState.processed++;
                    updateProgress();
                }

                // Delay between batches
                if (i + batchSize < itemsToProcess.length && !batchState.shouldStop) {
                    await sleep(delayMs);
                }
            }

            // Finished
            batchState.isRunning = false;
            dialog.querySelector('#um-batch-pause').style.display = 'none';
            dialog.querySelector('#um-batch-stop').style.display = 'none';

            const statusText = batchState.shouldStop ? ' (Stopped)' : ' (Complete)';
            dialog.querySelector('#um-batch-progress-text').textContent += statusText;
        });

        dialog.querySelector('#um-batch-pause').addEventListener('click', () => {
            batchState.isPaused = !batchState.isPaused;
            dialog.querySelector('#um-batch-pause').textContent = batchState.isPaused ? 'Resume' : 'Pause';
        });

        dialog.querySelector('#um-batch-stop').addEventListener('click', () => {
            batchState.shouldStop = true;
        });

        dialog.querySelector('#um-batch-close').addEventListener('click', closePopup);

        // Close on dialog close event (ESC key, etc.)
        dialog.addEventListener('close', () => {
            if (document.body.contains(dialog)) {
                closePopup();
            }
        });
    });
}

/**
 * Show edit modal for memory summary
 * @param {string} currentText - Current summary text
 * @param {Function} onSave - Save callback (newText) => Promise
 * @returns {Promise<void>}
 */
function showEditModal(currentText, onSave) {
    return new Promise((resolve) => {
        const modalHtml = `
            <div class="um-edit-popup">
                <h4>Edit Summary</h4>
                <textarea id="um-edit-textarea" class="text_pole" rows="6">${escapeHtml(currentText)}</textarea>
                <div class="um-edit-actions">
                    <button class="menu_button" id="um-edit-save">Save</button>
                    <button class="menu_button" id="um-edit-cancel">Cancel</button>
                </div>
            </div>
        `;

        const dialog = createDialogPopup(modalHtml);
        dialog.classList.add('um-edit-dialog');
        dialog.showModal();

        const closeModal = () => {
            dialog.close();
            dialog.remove();
            resolve();
        };

        dialog.querySelector('#um-edit-save').addEventListener('click', async () => {
            const newText = dialog.querySelector('#um-edit-textarea').value.trim();
            if (newText && newText !== currentText) {
                try {
                    await onSave(newText);
                    toastr.success('Memory updated');
                } catch (error) {
                    toastr.error('Failed to update memory');
                }
            }
            closeModal();
        });

        dialog.querySelector('#um-edit-cancel').addEventListener('click', closeModal);

        dialog.addEventListener('close', () => {
            if (document.body.contains(dialog)) {
                closeModal();
            }
        });

        // Focus textarea
        setTimeout(() => dialog.querySelector('#um-edit-textarea').focus(), 100);
    });
}

/**
 * Show memory management popup
 * @param {object} options - Options
 * @param {Function} options.getMemories - Get memories callback
 * @param {Function} options.onDelete - Delete callback (hash) => Promise
 * @param {Function} options.onEdit - Edit callback (hash, newText) => Promise
 * @param {Function} options.onViewOriginal - View original callback (msgId) => void
 */
export async function showMemoryManagementPopup(options) {
    const { getMemories, onDelete, onEdit, onViewOriginal, onRegenerate } = options;

    let memories = [];
    let currentPage = 0;
    const pageSize = 10;
    let selectedHashes = new Set();

    const popupHtml = `
        <div class="um-memory-popup">
            <div class="um-memory-popup-header">
                <h3>Memory Management</h3>
                <div class="um-memory-header">
                    <div class="um-memory-stats" id="um-memory-stats">Loading...</div>
                    <div class="um-memory-bulk-actions">
                        <label class="checkbox_label">
                            <input type="checkbox" id="um-select-all">
                            <span>Select All</span>
                        </label>
                        <button class="menu_button" id="um-bulk-delete" disabled>Delete Selected</button>
                    </div>
                </div>
            </div>
            <div class="um-memory-list-container">
                <div class="um-memory-list" id="um-memory-list">
                    <p>Loading memories...</p>
                </div>
            </div>
            <div class="um-memory-popup-footer">
                <div class="um-memory-pagination" id="um-memory-pagination"></div>
                <div class="um-memory-actions">
                    <button class="menu_button" id="um-mem-refresh">Refresh</button>
                    <button class="menu_button" id="um-mem-close">Close</button>
                </div>
            </div>
        </div>
    `;

    const dialog = createDialogPopup(popupHtml, { wide: true });

    const updateBulkDeleteButton = () => {
        const count = selectedHashes.size;
        const btn = dialog.querySelector('#um-bulk-delete');
        btn.disabled = count === 0;
        btn.textContent = count > 0 ? `Delete Selected (${count})` : 'Delete Selected';
    };

    const renderMemoryList = () => {
        const start = currentPage * pageSize;
        const pageMemories = memories.slice(start, start + pageSize);
        const totalPages = Math.ceil(memories.length / pageSize);
        const listEl = dialog.querySelector('#um-memory-list');

        let html = '';

        if (pageMemories.length === 0) {
            html = '<p class="um-no-memories">No memories found for this chat.</p>';
        } else {
            for (const mem of pageMemories) {
                const date = new Date(mem.createdAt || Date.now()).toLocaleString();
                const isChecked = selectedHashes.has(mem.hash) ? 'checked' : '';
                html += `
                    <div class="um-memory-item" data-hash="${mem.hash}">
                        <div class="um-memory-item-header">
                            <input type="checkbox" class="um-item-checkbox" data-hash="${mem.hash}" ${isChecked}>
                            <span class="um-memory-item-turn">Turn ${mem.turnIndex || mem.index || '?'}</span>
                            <span class="um-memory-item-date">${date}</span>
                        </div>
                        <div class="um-memory-item-content">${escapeHtml(mem.text || mem.summary || '')}</div>
                        <div class="um-memory-item-actions">
                            <button class="menu_button um-btn-regenerate" data-hash="${mem.hash}" data-msgid="${mem.msgId || ''}" title="Regenerate summary">
                                <i class="fa-solid fa-recycle"></i>
                            </button>
                            <button class="menu_button um-btn-view" data-msgid="${mem.msgId || ''}">View</button>
                            <button class="menu_button um-btn-edit" data-hash="${mem.hash}">Edit</button>
                            <button class="menu_button um-btn-delete" data-hash="${mem.hash}">Delete</button>
                        </div>
                    </div>
                `;
            }
        }

        listEl.innerHTML = html;

        // Update select all checkbox state
        const pageHashes = pageMemories.map(m => m.hash);
        const allPageSelected = pageHashes.length > 0 && pageHashes.every(h => selectedHashes.has(h));
        dialog.querySelector('#um-select-all').checked = allPageSelected;

        // Pagination with page jump
        const paginationEl = dialog.querySelector('#um-memory-pagination');
        const effectiveTotalPages = totalPages || 1;
        paginationEl.innerHTML = `
            <button class="menu_button" id="um-mem-prev" ${currentPage === 0 ? 'disabled' : ''}>Prev</button>
            <span>Page </span>
            <input type="number" id="um-mem-page-input" class="text_pole"
                min="1" max="${effectiveTotalPages}" value="${currentPage + 1}"
                style="width: 50px; text-align: center; padding: 4px;">
            <span> / ${effectiveTotalPages}</span>
            <button class="menu_button" id="um-mem-next" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
        `;

        // Re-bind pagination buttons
        paginationEl.querySelector('#um-mem-prev')?.addEventListener('click', () => {
            if (currentPage > 0) {
                currentPage--;
                renderMemoryList();
            }
        });
        paginationEl.querySelector('#um-mem-next')?.addEventListener('click', () => {
            if (currentPage < totalPages - 1) {
                currentPage++;
                renderMemoryList();
            }
        });
        // Page jump input handler
        paginationEl.querySelector('#um-mem-page-input')?.addEventListener('change', function() {
            let page = parseInt(this.value) - 1;
            if (isNaN(page) || page < 0) page = 0;
            if (page >= effectiveTotalPages) page = effectiveTotalPages - 1;
            currentPage = page;
            renderMemoryList();
        });

        // Stats
        dialog.querySelector('#um-memory-stats').textContent = `Total: ${memories.length} memories`;

        updateBulkDeleteButton();

        // Bind memory item events
        bindMemoryItemEvents();
    };

    const bindMemoryItemEvents = () => {
        // Individual checkboxes (unified class: um-item-checkbox)
        dialog.querySelectorAll('.um-item-checkbox').forEach(cb => {
            cb.addEventListener('change', function() {
                const hash = this.dataset.hash;
                if (this.checked) {
                    selectedHashes.add(hash);
                } else {
                    selectedHashes.delete(hash);
                }
                updateBulkDeleteButton();

                // Update select all state
                const start = currentPage * pageSize;
                const pageMemories = memories.slice(start, start + pageSize);
                const pageHashes = pageMemories.map(m => m.hash);
                const allPageSelected = pageHashes.every(h => selectedHashes.has(h));
                dialog.querySelector('#um-select-all').checked = allPageSelected;
            });
        });

        // View original buttons (unified class: um-btn-view)
        dialog.querySelectorAll('.um-btn-view').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const msgId = this.dataset.msgid;
                if (msgId && onViewOriginal) {
                    onViewOriginal(msgId);
                }
            });
        });

        // Edit buttons (unified class: um-btn-edit)
        dialog.querySelectorAll('.um-btn-edit').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                const hash = this.dataset.hash;
                const mem = memories.find(m => m.hash === hash);
                if (!mem) return;

                await showEditModal(mem.text || mem.summary || '', async (newText) => {
                    await onEdit(hash, newText);
                    await loadMemories();
                });
            });
        });

        // Delete buttons (unified class: um-btn-delete)
        dialog.querySelectorAll('.um-btn-delete').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                const hash = this.dataset.hash;

                try {
                    await onDelete(hash);
                    selectedHashes.delete(hash);
                    await loadMemories();
                    toastr.success('Memory deleted');
                } catch (error) {
                    toastr.error('Failed to delete memory');
                }
            });
        });

        // Regenerate buttons (unified class: um-btn-regenerate)
        dialog.querySelectorAll('.um-btn-regenerate').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();

                if (!onRegenerate) return;

                const hash = this.dataset.hash;
                const msgId = this.dataset.msgid;
                if (!msgId) {
                    toastr.warning('Cannot regenerate: original message ID not found');
                    return;
                }

                const icon = this.querySelector('i');
                const originalClass = icon.className;
                icon.className = 'fa-solid fa-spinner fa-spin';
                this.disabled = true;

                try {
                    await onRegenerate(hash, msgId);
                    await loadMemories();
                    toastr.success('Summary regenerated');
                } catch (error) {
                    toastr.error(`Failed to regenerate: ${error.message}`);
                    icon.className = originalClass;
                    this.disabled = false;
                }
            });
        });
    };

    const loadMemories = async () => {
        try {
            memories = await getMemories();
            selectedHashes.clear();
            renderMemoryList();
        } catch (error) {
            console.error('Failed to load memories:', error);
            dialog.querySelector('#um-memory-list').innerHTML = '<p class="um-error">Failed to load memories.</p>';
        }
    };

    const closePopup = () => {
        dialog.close();
        dialog.remove();
    };

    // Show dialog
    dialog.showModal();

    // Load initial data
    await loadMemories();

    // Select all checkbox
    dialog.querySelector('#um-select-all').addEventListener('change', function() {
        const isChecked = this.checked;
        const start = currentPage * pageSize;
        const pageMemories = memories.slice(start, start + pageSize);

        pageMemories.forEach(mem => {
            if (isChecked) {
                selectedHashes.add(mem.hash);
            } else {
                selectedHashes.delete(mem.hash);
            }
        });

        dialog.querySelectorAll('.um-item-checkbox').forEach(cb => {
            cb.checked = isChecked;
        });
        updateBulkDeleteButton();
    });

    // Bulk delete
    dialog.querySelector('#um-bulk-delete').addEventListener('click', async function() {
        const count = selectedHashes.size;
        if (count === 0) return;

        this.disabled = true;
        this.textContent = 'Deleting...';

        let deleted = 0;
        let failed = 0;

        for (const hash of selectedHashes) {
            try {
                await onDelete(hash);
                deleted++;
            } catch (error) {
                console.error('Failed to delete memory:', hash, error);
                failed++;
            }
        }

        selectedHashes.clear();
        await loadMemories();

        if (failed === 0) {
            toastr.success(`Deleted ${deleted} memories`);
        } else {
            toastr.warning(`Deleted ${deleted} memories, ${failed} failed`);
        }
    });

    // Refresh and close buttons
    dialog.querySelector('#um-mem-refresh').addEventListener('click', loadMemories);
    dialog.querySelector('#um-mem-close').addEventListener('click', closePopup);

    // Handle dialog close event
    dialog.addEventListener('close', () => {
        if (document.body.contains(dialog)) {
            dialog.remove();
        }
    });
}

/**
 * Show statistics popup
 * @param {object} stats - Statistics object
 */
export function showStatsPopup(stats) {
    const popupHtml = `
        <div class="um-stats-popup">
            <h3>Context Summarizer Statistics</h3>
            <div class="um-stats-grid">
                <div class="um-stats-item">
                    <span class="um-stats-label">Total Memories</span>
                    <span class="um-stats-value">${stats.totalMemories || 0}</span>
                </div>
                <div class="um-stats-item">
                    <span class="um-stats-label">With Embeddings</span>
                    <span class="um-stats-value">${stats.withEmbeddings || 0}</span>
                </div>
                <div class="um-stats-item">
                    <span class="um-stats-label">Pending</span>
                    <span class="um-stats-value">${stats.pending || 0}</span>
                </div>
                <div class="um-stats-item">
                    <span class="um-stats-label">Cache Size</span>
                    <span class="um-stats-value">${stats.cacheSize || 0}</span>
                </div>
                <div class="um-stats-item">
                    <span class="um-stats-label">Backend</span>
                    <span class="um-stats-value">${stats.backend || 'unknown'}</span>
                </div>
                <div class="um-stats-item">
                    <span class="um-stats-label">Backend Health</span>
                    <span class="um-stats-value ${stats.backendHealthy ? 'um-healthy' : 'um-unhealthy'}">
                        ${stats.backendHealthy ? 'OK' : 'Error'}
                    </span>
                </div>
            </div>
            <div class="um-stats-actions">
                <button class="menu_button" id="um-stats-close">Close</button>
            </div>
        </div>
    `;

    const dialog = createDialogPopup(popupHtml);
    dialog.showModal();

    const closePopup = () => {
        dialog.close();
        dialog.remove();
    };

    dialog.querySelector('#um-stats-close').addEventListener('click', closePopup);
    dialog.addEventListener('close', () => {
        if (document.body.contains(dialog)) {
            dialog.remove();
        }
    });
}

/**
 * Show global memory management popup
 * Displays all memory collections across all characters and chats
 * @param {object} options - Options
 * @param {Function} options.getAllCollections - Get all collections data
 * @param {Function} options.purgeCollection - Purge a collection (collectionId) => Promise
 * @param {Function} options.cleanupOrphaned - Cleanup orphaned collections () => Promise<number>
 * @param {Function} options.getCharacterName - Get character name by ID (characterId) => string
 * @param {Function} options.getMemoriesForCollection - Get memories for specific collection (collectionId) => Promise<Array>
 * @param {Function} options.deleteMemory - Delete a memory (collectionId, hash) => Promise
 * @param {Function} options.editMemory - Edit a memory (collectionId, hash, newText) => Promise
 */
export async function showGlobalMemoryManagementPopup(options) {
    const { getAllCollections, purgeCollection, cleanupOrphaned, getCharacterName, getMemoriesForCollection, deleteMemory, editMemory, regenerateMemory } = options;

    let collections = [];
    let filteredCollections = [];
    let currentFilter = ''; // '' = all, 'orphaned' = orphaned only, or characterId

    // Pagination state for global collection list
    let globalPage = 0;
    const globalPageSize = 10;

    // View state for nested navigation
    let currentView = 'global'; // 'global' or 'collection'
    let selectedCollection = null; // Current collection being viewed
    let collectionMemories = []; // Memories for the selected collection
    let collectionPage = 0;
    const collectionPageSize = 10;
    let detailSelectedHashes = new Set(); // Selected hashes in collection detail view

    const popupHtml = `
        <div class="um-global-popup">
            <!-- Global View -->
            <div id="um-global-view">
                <div class="um-global-header">
                    <h3>Global Memory Manager</h3>
                    <div class="um-global-stats" id="um-global-stats">Loading...</div>
                </div>

                <!-- Filters -->
                <div class="um-global-filters">
                    <select id="um-global-filter" class="text_pole">
                        <option value="">All Collections</option>
                        <option value="orphaned">Orphaned Only</option>
                    </select>
                    <input type="text" id="um-global-search" class="text_pole" placeholder="Search by name...">
                </div>

                <!-- Action buttons -->
                <div class="um-global-actions">
                    <button id="um-cleanup-orphaned" class="menu_button">
                        <i class="fa-solid fa-broom"></i> Cleanup Orphaned
                    </button>
                    <button id="um-refresh-global" class="menu_button">
                        <i class="fa-solid fa-sync"></i> Refresh
                    </button>
                </div>

                <!-- Collection list -->
                <div class="um-collection-list-container">
                    <div class="um-collection-list" id="um-collection-list">
                        <p>Loading collections...</p>
                    </div>
                </div>

                <!-- Pagination for collection list -->
                <div class="um-memory-pagination" id="um-global-pagination"></div>
            </div>

            <!-- Collection Detail View (hidden by default) -->
            <div id="um-collection-detail-view" style="display: none;">
                <div class="um-global-header">
                    <div class="um-header-with-back">
                        <button class="menu_button" id="um-back-to-global" title="Back to Global Manager">
                            <i class="fa-solid fa-arrow-left"></i>
                        </button>
                        <h3 id="um-collection-detail-title">Collection Memories</h3>
                    </div>
                    <div class="um-memory-header">
                        <div class="um-memory-stats" id="um-collection-detail-stats">Loading...</div>
                        <div class="um-memory-bulk-actions">
                            <label class="checkbox_label">
                                <input type="checkbox" id="um-detail-select-all">
                                <span>Select All</span>
                            </label>
                            <button class="menu_button" id="um-detail-bulk-delete" disabled>Delete Selected</button>
                        </div>
                    </div>
                </div>

                <!-- Memory list -->
                <div class="um-memory-list-container">
                    <div class="um-memory-list" id="um-collection-memory-list">
                        <p>Loading memories...</p>
                    </div>
                </div>

                <!-- Pagination -->
                <div class="um-memory-pagination" id="um-collection-pagination"></div>
            </div>

            <!-- Footer -->
            <div class="um-global-footer">
                <button class="menu_button" id="um-global-close">Close</button>
            </div>
        </div>
    `;

    const dialog = createDialogPopup(popupHtml, { wide: true });

    const updateStats = () => {
        const totalCollections = collections.length;
        const totalMemories = collections.reduce((sum, c) => sum + (c.memoryCount || 0), 0);
        const orphanedCount = collections.filter(c => c.isOrphaned).length;
        const uniqueCharacters = new Set(collections.filter(c => !c.isOrphaned && c.characterId !== null).map(c => c.characterId)).size;

        dialog.querySelector('#um-global-stats').innerHTML = `
            <span>Collections: <strong>${totalCollections}</strong></span>
            <span>Memories: <strong>${totalMemories}</strong></span>
            <span>Characters: <strong>${uniqueCharacters}</strong></span>
            ${orphanedCount > 0 ? `<span class="um-orphaned-warning">Orphaned: <strong>${orphanedCount}</strong></span>` : ''}
        `;
    };

    const updateFilterDropdown = () => {
        const select = dialog.querySelector('#um-global-filter');
        // Keep first two options (All and Orphaned)
        while (select.options.length > 2) {
            select.remove(2);
        }

        // Get unique characters
        const characters = new Map();
        for (const col of collections) {
            if (col.characterId !== null && !col.isOrphaned) {
                characters.set(col.characterId, col.characterName);
            }
        }

        // Add character options
        for (const [charId, charName] of characters) {
            const option = document.createElement('option');
            option.value = `char_${charId}`;
            option.textContent = charName || `Character ${charId}`;
            select.appendChild(option);
        }

        // Check if there are group chats
        const hasGroups = collections.some(c => c.isGroup);
        if (hasGroups) {
            const option = document.createElement('option');
            option.value = 'groups';
            option.textContent = 'Group Chats';
            select.appendChild(option);
        }
    };

    const applyFilters = () => {
        const searchText = dialog.querySelector('#um-global-search').value.toLowerCase().trim();

        filteredCollections = collections.filter(col => {
            // Filter by dropdown
            if (currentFilter === 'orphaned' && !col.isOrphaned) return false;
            if (currentFilter === 'groups' && !col.isGroup) return false;
            if (currentFilter.startsWith('char_')) {
                const charId = parseInt(currentFilter.substring(5));
                if (col.characterId !== charId) return false;
            }

            // Filter by search text
            if (searchText) {
                const nameMatch = (col.characterName || '').toLowerCase().includes(searchText);
                const chatMatch = (col.chatName || '').toLowerCase().includes(searchText);
                const idMatch = col.collectionId.toLowerCase().includes(searchText);
                if (!nameMatch && !chatMatch && !idMatch) return false;
            }

            return true;
        });

        // Reset to first page when filters change
        globalPage = 0;
        renderCollectionList();
    };

    const renderCollectionList = () => {
        const listEl = dialog.querySelector('#um-collection-list');
        const paginationEl = dialog.querySelector('#um-global-pagination');

        // Calculate pagination
        const totalPages = Math.ceil(filteredCollections.length / globalPageSize);
        const start = globalPage * globalPageSize;
        const pageCollections = filteredCollections.slice(start, start + globalPageSize);

        if (filteredCollections.length === 0) {
            listEl.innerHTML = '<p class="um-no-collections">No collections found.</p>';
            paginationEl.innerHTML = '';
            return;
        }

        let html = '';
        for (const col of pageCollections) {
            const dateStr = col.newestMemory ? new Date(col.newestMemory).toLocaleDateString() : 'N/A';
            const orphanedClass = col.isOrphaned ? 'um-collection-orphaned' : '';
            const typeIcon = col.isGroup ? 'fa-users' : 'fa-user';

            html += `
                <div class="um-collection-item ${orphanedClass}" data-collection-id="${col.collectionId}" style="cursor: pointer;">
                    <div class="um-collection-item-header">
                        <div class="um-collection-item-info">
                            <i class="fa-solid ${typeIcon}"></i>
                            <span class="um-collection-name">${escapeHtml(col.characterName || 'Unknown')}</span>
                            ${col.isOrphaned ? '<span class="um-orphaned-badge">Orphaned</span>' : ''}
                        </div>
                        <div class="um-collection-item-stats">
                            <span title="Memory count">${col.memoryCount} memories</span>
                            <span title="Last updated">${dateStr}</span>
                        </div>
                    </div>
                    <div class="um-collection-item-chat">${escapeHtml(col.chatName || 'Unnamed Chat')}</div>
                    <div class="um-collection-item-actions">
                        <button class="menu_button um-btn-purge-collection" data-collection-id="${col.collectionId}">
                            <i class="fa-solid fa-trash"></i> Purge
                        </button>
                    </div>
                </div>
            `;
        }

        listEl.innerHTML = html;

        // Render pagination with page jump input
        if (totalPages > 1) {
            paginationEl.innerHTML = `
                <button class="menu_button" id="um-global-prev" ${globalPage === 0 ? 'disabled' : ''}>Prev</button>
                <span>Page </span>
                <input type="number" id="um-global-page-input" class="text_pole"
                    min="1" max="${totalPages}" value="${globalPage + 1}"
                    style="width: 50px; text-align: center; padding: 4px;">
                <span> / ${totalPages} (${filteredCollections.length} items)</span>
                <button class="menu_button" id="um-global-next" ${globalPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
            `;

            // Bind pagination events
            paginationEl.querySelector('#um-global-prev')?.addEventListener('click', () => {
                if (globalPage > 0) {
                    globalPage--;
                    renderCollectionList();
                }
            });
            paginationEl.querySelector('#um-global-next')?.addEventListener('click', () => {
                if (globalPage < totalPages - 1) {
                    globalPage++;
                    renderCollectionList();
                }
            });
            // Page jump input
            paginationEl.querySelector('#um-global-page-input')?.addEventListener('change', function() {
                let page = parseInt(this.value) - 1;
                if (isNaN(page) || page < 0) page = 0;
                if (page >= totalPages) page = totalPages - 1;
                globalPage = page;
                renderCollectionList();
            });
            paginationEl.querySelector('#um-global-page-input')?.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    this.blur();
                }
            });
        } else {
            paginationEl.innerHTML = filteredCollections.length > 0
                ? `<span>${filteredCollections.length} collection${filteredCollections.length > 1 ? 's' : ''}</span>`
                : '';
        }

        // Bind collection item click (excluding purge button)
        listEl.querySelectorAll('.um-collection-item').forEach(item => {
            item.addEventListener('click', async function(e) {
                // Don't navigate if clicking the purge button
                if (e.target.closest('.um-btn-purge-collection')) return;

                const collectionId = this.dataset.collectionId;
                const col = collections.find(c => c.collectionId === collectionId);
                if (col && getMemoriesForCollection) {
                    await showCollectionDetail(col);
                }
            });
        });

        // Bind purge buttons
        listEl.querySelectorAll('.um-btn-purge-collection').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();

                const collectionId = this.dataset.collectionId;
                const col = collections.find(c => c.collectionId === collectionId);
                const name = col?.characterName || collectionId;

                if (!confirm(`Are you sure you want to purge all memories for "${name}"?\n\nThis will delete ${col?.memoryCount || 0} memories.`)) {
                    return;
                }

                this.disabled = true;
                this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Purging...';

                try {
                    await purgeCollection(collectionId);
                    toastr.success(`Purged memories for ${name}`);
                    await loadCollections();
                } catch (error) {
                    console.error('Failed to purge collection:', error);
                    toastr.error(`Failed to purge: ${error.message}`);
                    this.disabled = false;
                    this.innerHTML = '<i class="fa-solid fa-trash"></i> Purge';
                }
            });
        });
    };

    const loadCollections = async () => {
        try {
            collections = await getAllCollections();
            updateStats();
            updateFilterDropdown();
            applyFilters();
        } catch (error) {
            console.error('Failed to load collections:', error);
            dialog.querySelector('#um-collection-list').innerHTML = '<p class="um-error">Failed to load collections.</p>';
        }
    };

    // View switching functions
    const showGlobalView = () => {
        currentView = 'global';
        selectedCollection = null;
        collectionMemories = [];
        collectionPage = 0;

        dialog.querySelector('#um-global-view').style.display = 'block';
        dialog.querySelector('#um-collection-detail-view').style.display = 'none';
    };

    const showCollectionDetail = async (col) => {
        currentView = 'collection';
        selectedCollection = col;
        collectionPage = 0;

        // Update header
        const title = `${col.characterName} - ${col.chatName || 'Unnamed Chat'}`;
        dialog.querySelector('#um-collection-detail-title').textContent = title;

        // Switch views
        dialog.querySelector('#um-global-view').style.display = 'none';
        dialog.querySelector('#um-collection-detail-view').style.display = 'flex';

        // Load memories
        await loadCollectionMemories();
    };

    const loadCollectionMemories = async () => {
        if (!selectedCollection || !getMemoriesForCollection) {
            dialog.querySelector('#um-collection-memory-list').innerHTML = '<p class="um-error">Cannot load memories.</p>';
            return;
        }

        try {
            collectionMemories = await getMemoriesForCollection(selectedCollection.collectionId);
            detailSelectedHashes.clear();
            renderCollectionMemories();
        } catch (error) {
            console.error('Failed to load collection memories:', error);
            dialog.querySelector('#um-collection-memory-list').innerHTML = '<p class="um-error">Failed to load memories.</p>';
        }
    };

    const updateDetailBulkDeleteButton = () => {
        const count = detailSelectedHashes.size;
        const btn = dialog.querySelector('#um-detail-bulk-delete');
        btn.disabled = count === 0;
        btn.textContent = count > 0 ? `Delete Selected (${count})` : 'Delete Selected';
    };

    const renderCollectionMemories = () => {
        const listEl = dialog.querySelector('#um-collection-memory-list');
        const statsEl = dialog.querySelector('#um-collection-detail-stats');
        const paginationEl = dialog.querySelector('#um-collection-pagination');

        const start = collectionPage * collectionPageSize;
        const pageMemories = collectionMemories.slice(start, start + collectionPageSize);
        const totalPages = Math.ceil(collectionMemories.length / collectionPageSize);

        statsEl.textContent = `Total: ${collectionMemories.length} memories`;

        if (pageMemories.length === 0) {
            listEl.innerHTML = '<p class="um-no-memories">No memories found.</p>';
            paginationEl.innerHTML = '';
            return;
        }

        let html = '';
        for (const mem of pageMemories) {
            const date = new Date(mem.createdAt || Date.now()).toLocaleString();
            const isChecked = detailSelectedHashes.has(mem.hash) ? 'checked' : '';
            html += `
                <div class="um-memory-item" data-hash="${mem.hash}">
                    <div class="um-memory-item-header">
                        <input type="checkbox" class="um-item-checkbox" data-hash="${mem.hash}" ${isChecked}>
                        <span class="um-memory-item-turn">Turn ${mem.turnIndex || mem.index || '?'}</span>
                        <span class="um-memory-item-date">${date}</span>
                    </div>
                    <div class="um-memory-item-content">${escapeHtml(mem.text || mem.summary || '')}</div>
                    <div class="um-memory-item-actions">
                        <button class="menu_button um-btn-regenerate" data-hash="${mem.hash}" data-msgid="${mem.msgId || ''}" title="Regenerate summary">
                            <i class="fa-solid fa-recycle"></i>
                        </button>
                        <button class="menu_button um-btn-edit" data-hash="${mem.hash}">Edit</button>
                        <button class="menu_button um-btn-delete" data-hash="${mem.hash}">Delete</button>
                    </div>
                </div>
            `;
        }

        listEl.innerHTML = html;

        // Update select all checkbox state
        const pageHashes = pageMemories.map(m => m.hash);
        const allPageSelected = pageHashes.length > 0 && pageHashes.every(h => detailSelectedHashes.has(h));
        dialog.querySelector('#um-detail-select-all').checked = allPageSelected;

        // Pagination with page jump
        const effectiveTotalPages = totalPages || 1;
        paginationEl.innerHTML = `
            <button class="menu_button" id="um-detail-prev" ${collectionPage === 0 ? 'disabled' : ''}>Prev</button>
            <span>Page </span>
            <input type="number" id="um-detail-page-input" class="text_pole"
                min="1" max="${effectiveTotalPages}" value="${collectionPage + 1}"
                style="width: 50px; text-align: center; padding: 4px;">
            <span> / ${effectiveTotalPages}</span>
            <button class="menu_button" id="um-detail-next" ${collectionPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
        `;

        // Bind pagination
        paginationEl.querySelector('#um-detail-prev')?.addEventListener('click', () => {
            if (collectionPage > 0) {
                collectionPage--;
                renderCollectionMemories();
            }
        });
        paginationEl.querySelector('#um-detail-next')?.addEventListener('click', () => {
            if (collectionPage < totalPages - 1) {
                collectionPage++;
                renderCollectionMemories();
            }
        });
        // Page jump input handler
        paginationEl.querySelector('#um-detail-page-input')?.addEventListener('change', function() {
            let page = parseInt(this.value) - 1;
            if (isNaN(page) || page < 0) page = 0;
            if (page >= effectiveTotalPages) page = effectiveTotalPages - 1;
            collectionPage = page;
            renderCollectionMemories();
        });

        updateDetailBulkDeleteButton();

        // Bind checkbox events (unified class: um-item-checkbox)
        listEl.querySelectorAll('.um-item-checkbox').forEach(cb => {
            cb.addEventListener('change', function() {
                const hash = this.dataset.hash;
                if (this.checked) {
                    detailSelectedHashes.add(hash);
                } else {
                    detailSelectedHashes.delete(hash);
                }
                updateDetailBulkDeleteButton();

                // Update select all state
                const pageHashes = pageMemories.map(m => m.hash);
                const allPageSelected = pageHashes.every(h => detailSelectedHashes.has(h));
                dialog.querySelector('#um-detail-select-all').checked = allPageSelected;
            });
        });

        // Bind edit buttons (unified class: um-btn-edit)
        listEl.querySelectorAll('.um-btn-edit').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                const hash = this.dataset.hash;
                const mem = collectionMemories.find(m => m.hash === hash);
                if (!mem || !editMemory) return;

                await showEditModal(mem.text || mem.summary || '', async (newText) => {
                    await editMemory(selectedCollection.collectionId, hash, newText);
                    await loadCollectionMemories();
                });
            });
        });

        // Bind delete buttons (unified class: um-btn-delete)
        listEl.querySelectorAll('.um-btn-delete').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                const hash = this.dataset.hash;
                if (!deleteMemory) return;

                try {
                    await deleteMemory(selectedCollection.collectionId, hash);
                    detailSelectedHashes.delete(hash);
                    await loadCollectionMemories();
                    toastr.success('Memory deleted');
                } catch (error) {
                    toastr.error('Failed to delete memory');
                }
            });
        });

        // Bind regenerate buttons (unified class: um-btn-regenerate)
        listEl.querySelectorAll('.um-btn-regenerate').forEach(btn => {
            btn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();

                if (!regenerateMemory) {
                    toastr.warning('Regenerate not available');
                    return;
                }

                const hash = this.dataset.hash;
                const msgId = this.dataset.msgid;
                if (!msgId) {
                    toastr.warning('Cannot regenerate: original message ID not found');
                    return;
                }

                const icon = this.querySelector('i');
                const originalClass = icon.className;
                icon.className = 'fa-solid fa-spinner fa-spin';
                this.disabled = true;

                try {
                    await regenerateMemory(selectedCollection.collectionId, hash, msgId);
                    await loadCollectionMemories();
                    toastr.success('Summary regenerated');
                } catch (error) {
                    toastr.error(`Failed to regenerate: ${error.message}`);
                    icon.className = originalClass;
                    this.disabled = false;
                }
            });
        });
    };

    const closePopup = () => {
        dialog.close();
        dialog.remove();
    };

    // Show dialog
    dialog.showModal();

    // Load initial data
    await loadCollections();

    // Event handlers
    // Back button handler
    dialog.querySelector('#um-back-to-global').addEventListener('click', () => {
        showGlobalView();
    });

    // Collection Detail - Select all checkbox
    dialog.querySelector('#um-detail-select-all').addEventListener('change', function() {
        const isChecked = this.checked;
        const start = collectionPage * collectionPageSize;
        const pageMemories = collectionMemories.slice(start, start + collectionPageSize);

        pageMemories.forEach(mem => {
            if (isChecked) {
                detailSelectedHashes.add(mem.hash);
            } else {
                detailSelectedHashes.delete(mem.hash);
            }
        });

        dialog.querySelectorAll('#um-collection-memory-list .um-item-checkbox').forEach(cb => {
            cb.checked = isChecked;
        });
        updateDetailBulkDeleteButton();
    });

    // Collection Detail - Bulk delete
    dialog.querySelector('#um-detail-bulk-delete').addEventListener('click', async function() {
        const count = detailSelectedHashes.size;
        if (count === 0) return;
        if (!deleteMemory || !selectedCollection) return;

        this.disabled = true;
        this.textContent = 'Deleting...';

        let deleted = 0;
        let failed = 0;

        for (const hash of detailSelectedHashes) {
            try {
                await deleteMemory(selectedCollection.collectionId, hash);
                deleted++;
            } catch (error) {
                console.error('Failed to delete memory:', hash, error);
                failed++;
            }
        }

        detailSelectedHashes.clear();
        await loadCollectionMemories();

        if (failed === 0) {
            toastr.success(`Deleted ${deleted} memories`);
        } else {
            toastr.warning(`Deleted ${deleted} memories, ${failed} failed`);
        }
    });

    dialog.querySelector('#um-global-filter').addEventListener('change', function() {
        currentFilter = this.value;
        applyFilters();
    });

    dialog.querySelector('#um-global-search').addEventListener('input', applyFilters);

    dialog.querySelector('#um-cleanup-orphaned').addEventListener('click', async function() {
        const orphanedCount = collections.filter(c => c.isOrphaned).length;
        if (orphanedCount === 0) {
            toastr.info('No orphaned collections found');
            return;
        }

        if (!confirm(`This will delete ${orphanedCount} orphaned collections.\n\nOrphaned collections belong to deleted characters and are no longer accessible.\n\nContinue?`)) {
            return;
        }

        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cleaning...';

        try {
            const cleaned = await cleanupOrphaned();
            toastr.success(`Cleaned up ${cleaned} orphaned collections`);
            await loadCollections();
        } catch (error) {
            console.error('Failed to cleanup orphaned:', error);
            toastr.error(`Cleanup failed: ${error.message}`);
        }

        this.disabled = false;
        this.innerHTML = '<i class="fa-solid fa-broom"></i> Cleanup Orphaned';
    });

    dialog.querySelector('#um-refresh-global').addEventListener('click', loadCollections);
    dialog.querySelector('#um-global-close').addEventListener('click', closePopup);

    dialog.addEventListener('close', () => {
        if (document.body.contains(dialog)) {
            dialog.remove();
        }
    });
}

/**
 * Escape HTML
 * @param {string} str - String to escape
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
