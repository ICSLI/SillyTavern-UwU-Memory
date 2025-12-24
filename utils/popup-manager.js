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
    const { getMemories, onDelete, onEdit, onViewOriginal } = options;

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
                            <input type="checkbox" class="um-memory-checkbox" data-hash="${mem.hash}" ${isChecked}>
                            <span class="um-memory-item-turn">Turn ${mem.turnIndex || mem.index || '?'}</span>
                            <span class="um-memory-item-date">${date}</span>
                        </div>
                        <div class="um-memory-item-content">${escapeHtml(mem.text || mem.summary || '')}</div>
                        <div class="um-memory-item-actions">
                            <button class="menu_button um-btn-view-original" data-msgid="${mem.msgId || ''}">View</button>
                            <button class="menu_button um-btn-edit-memory" data-hash="${mem.hash}">Edit</button>
                            <button class="menu_button um-btn-delete-memory" data-hash="${mem.hash}">Delete</button>
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

        // Pagination
        dialog.querySelector('#um-memory-pagination').innerHTML = `
            <button class="menu_button" id="um-mem-prev" ${currentPage === 0 ? 'disabled' : ''}>Prev</button>
            <span>Page ${currentPage + 1} / ${totalPages || 1}</span>
            <button class="menu_button" id="um-mem-next" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
        `;

        // Re-bind pagination buttons
        dialog.querySelector('#um-mem-prev')?.addEventListener('click', () => {
            if (currentPage > 0) {
                currentPage--;
                renderMemoryList();
            }
        });
        dialog.querySelector('#um-mem-next')?.addEventListener('click', () => {
            if (currentPage < totalPages - 1) {
                currentPage++;
                renderMemoryList();
            }
        });

        // Stats
        dialog.querySelector('#um-memory-stats').textContent = `Total: ${memories.length} memories`;

        updateBulkDeleteButton();

        // Bind memory item events
        bindMemoryItemEvents();
    };

    const bindMemoryItemEvents = () => {
        // Individual checkboxes
        dialog.querySelectorAll('.um-memory-checkbox').forEach(cb => {
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

        // View original buttons - scroll to message in background (don't close popup)
        dialog.querySelectorAll('.um-btn-view-original').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const msgId = this.dataset.msgid;
                if (msgId && onViewOriginal) {
                    onViewOriginal(msgId);
                }
            });
        });

        // Edit buttons
        dialog.querySelectorAll('.um-btn-edit-memory').forEach(btn => {
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

        // Delete buttons
        dialog.querySelectorAll('.um-btn-delete-memory').forEach(btn => {
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

        dialog.querySelectorAll('.um-memory-checkbox').forEach(cb => {
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
 * Escape HTML
 * @param {string} str - String to escape
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
