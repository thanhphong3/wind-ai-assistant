(function () {
    const vscode = acquireVsCodeApi();

    window.moveCarousel = function(button, direction) {
        const carousel = button.closest('.gravity-carousel');
        const slidesContainer = carousel.querySelector('.gravity-carousel-slides');
        const slides = Array.from(slidesContainer.children);
        let activeIdx = slides.findIndex(s => s.classList.contains('active'));
        
        if (activeIdx !== -1) {
            slides[activeIdx].classList.remove('active');
            let nextIdx = (activeIdx + direction + slides.length) % slides.length;
            slides[nextIdx].classList.add('active');
        }
    };

    const chatContainer = document.getElementById('chat-container');
    let userAtBottom = true;
    
    chatContainer.addEventListener('scroll', () => {
        const threshold = 50;
        userAtBottom = chatContainer.scrollHeight - chatContainer.clientHeight - chatContainer.scrollTop <= threshold;
        hideContextMenu();
    });
    chatContainer.addEventListener('click', (e) => {
        const fileLink = e.target.closest('.file-link');
        if (fileLink) {
            const filePath = fileLink.getAttribute('data-path');
            if (filePath) {
                vscode.postMessage({ type: 'openFile', filePath: filePath });
            }
        }

        const runBtn = e.target.closest('.step-run-btn');
        if (runBtn) {
            e.stopPropagation();
            
            // Check if plan execution is already in progress
            const mainExecBtn = document.getElementById('execute-plan-btn');
            if (mainExecBtn && (mainExecBtn.disabled || mainExecBtn.classList.contains('executing'))) {
                return; // Cannot execute while already running
            }

            const idxAttr = runBtn.getAttribute('data-index');
            if (idxAttr !== null) {
                const startIndex = parseInt(idxAttr, 10);
                
                // Retrieve selected model
                const activeModelItem = document.querySelector('#model-dropdown-menu .dropdown-item.active');
                const selectedModel = activeModelItem ? activeModelItem.getAttribute('data-value') : 'gemini-3.5-flash-high';
                const configIndexAttr = activeModelItem ? activeModelItem.getAttribute('data-config-index') : null;
                const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;

                vscode.postMessage({
                    type: 'executePlan',
                    tasks: activePlanTasks,
                    model: selectedModel,
                    configIndex: configIndex,
                    startIndex: startIndex
                });
            }
        }
    });

    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-btn');
    const runBgButton = document.getElementById('run-bg-btn');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    let attachedImages = [];

    function updateImagePreview() {
        if (!imagePreviewContainer) return;
        if (attachedImages.length === 0) {
            imagePreviewContainer.classList.add('hidden');
            imagePreviewContainer.innerHTML = '';
            return;
        }
        imagePreviewContainer.classList.remove('hidden');
        imagePreviewContainer.innerHTML = '';
        const fragment = document.createDocumentFragment();
        attachedImages.forEach((base64, index) => {
            const item = document.createElement('div');
            item.className = 'image-preview-item';
            const img = document.createElement('img');
            img.src = base64;
            const removeBtn = document.createElement('button');
            removeBtn.className = 'image-preview-remove';
            removeBtn.innerHTML = 'x';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                attachedImages.splice(index, 1);
                updateImagePreview();
            };
            item.appendChild(img);
            item.appendChild(removeBtn);
            fragment.appendChild(item);
        });
        imagePreviewContainer.appendChild(fragment);
    }

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    function isImageFile(file) {
        if (file.type && file.type.startsWith('image/')) return true;
        const name = file.name.toLowerCase();
        return imageExtensions.some(ext => name.endsWith(ext));
    }

    function handleImageFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            let result = e.target.result;
            // If the MIME type is missing, patch it based on extension
            if (result.startsWith('data:;base64,')) {
                const name = file.name.toLowerCase();
                let mime = 'image/png';
                if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
                else if (name.endsWith('.gif')) mime = 'image/gif';
                else if (name.endsWith('.webp')) mime = 'image/webp';
                else if (name.endsWith('.bmp')) mime = 'image/bmp';
                else if (name.endsWith('.svg')) mime = 'image/svg+xml';
                result = result.replace('data:;base64,', `data:${mime};base64,`);
            }
            attachedImages.push(result);
            updateImagePreview();
        };
        reader.readAsDataURL(file);
    }

    messageInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.indexOf('image') !== -1) {
                const blob = item.getAsFile();
                if (blob) {
                    handleImageFile(blob);
                }
            }
        }
    });

    const dragOverlay = document.getElementById('drag-overlay');
    let dragCounter = 0;

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (dragOverlay) {
            dragOverlay.classList.remove('hidden');
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0 && dragOverlay) {
            dragCounter = 0;
            dragOverlay.classList.add('hidden');
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        if (dragOverlay) {
            dragOverlay.classList.add('hidden');
        }

        // 1. Check for standard files (e.g. from OS)
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                if (file.path) {
                    // Bypass frontend FileReader sandbox limitations for local files
                    vscode.postMessage({
                        type: 'resolveDraggedFile',
                        uri: file.path
                    });
                } else if (isImageFile(file)) {
                    handleImageFile(file);
                } else {
                    vscode.postMessage({
                        type: 'resolveDraggedFile',
                        uri: file.name
                    });
                }
            }
            return;
        }

        // 2. Check for items (alternative file list)
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            let hasFiles = false;
            for (let i = 0; i < e.dataTransfer.items.length; i++) {
                if (e.dataTransfer.items[i].kind === 'file') {
                    const file = e.dataTransfer.items[i].getAsFile();
                    if (file) {
                        if (file.path) {
                            vscode.postMessage({
                                type: 'resolveDraggedFile',
                                uri: file.path
                            });
                            hasFiles = true;
                        } else if (isImageFile(file)) {
                            handleImageFile(file);
                            hasFiles = true;
                        }
                    }
                }
            }
            if (hasFiles) return;
        }

        // 3. Check for VS Code Explorer / editor tab drops using text/uri-list or text/plain
        const uriList = e.dataTransfer.getData('text/uri-list');
        const textData = e.dataTransfer.getData('text/plain');

        if (uriList) {
            const uris = uriList.split('\n').map(u => u.trim()).filter(Boolean);
            uris.forEach(uri => {
                vscode.postMessage({
                    type: 'resolveDraggedFile',
                    uri: uri
                });
            });
        } else if (textData) {
            if (textData.startsWith('file://') || textData.startsWith('vscode-file://') || /^[a-zA-Z]:\\/.test(textData) || textData.startsWith('/')) {
                vscode.postMessage({
                    type: 'resolveDraggedFile',
                    uri: textData
                });
            }
        }
    });
    const clearButton = document.getElementById('clear-chat');
    const modifiedFilesPanel = document.getElementById('modified-files-panel');
    const modifiedFilesHeader = document.getElementById('modified-files-header');
    const modifiedFilesCount = document.getElementById('modified-files-count');
    const modifiedFilesBody = document.getElementById('modified-files-body');
    const modifiedFilesFooter = document.getElementById('modified-files-footer');
    const acceptChangesBtn = document.getElementById('accept-changes-btn');
    const discardChangesBtn = document.getElementById('discard-changes-btn');

    if (acceptChangesBtn) {
        acceptChangesBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'acceptChanges' });
        });
    }

    if (discardChangesBtn) {
        discardChangesBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'discardChanges' });
        });
    }

    // Upgrade selectors & initialization
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTabId = btn.getAttribute('data-tab');
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tabPanels.forEach(panel => {
                if (panel.id === targetTabId) {
                    panel.classList.remove('hidden');
                } else {
                    panel.classList.add('hidden');
                }
            });
        });
    });

    // Browser playback state and handlers
    let browserScreenshots = [];
    let playbackIndex = -1;
    let playbackInterval = null;

    function updatePlaybackUI() {
        const img = document.getElementById('browser-playback-img');
        const overlay = document.getElementById('viewport-overlay');
        const playBtn = document.getElementById('browser-play-btn');
        const prevBtn = document.getElementById('browser-prev-btn');
        const nextBtn = document.getElementById('browser-next-btn');

        if (!img || !overlay || !playBtn || !prevBtn || !nextBtn) return;

        if (browserScreenshots.length === 0) {
            img.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
            overlay.classList.remove('hidden');
            overlay.textContent = "No Active Session";
            playBtn.disabled = true;
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            return;
        }

        overlay.classList.add('hidden');
        img.src = browserScreenshots[playbackIndex];

        playBtn.disabled = false;
        playBtn.textContent = playbackInterval ? 'Pause' : 'Play';
        prevBtn.disabled = playbackIndex <= 0;
        nextBtn.disabled = playbackIndex >= browserScreenshots.length - 1;
    }

    const browserPlayBtn = document.getElementById('browser-play-btn');
    if (browserPlayBtn) {
        browserPlayBtn.addEventListener('click', () => {
            if (playbackInterval) {
                clearInterval(playbackInterval);
                playbackInterval = null;
            } else {
                if (playbackIndex >= browserScreenshots.length - 1) {
                    playbackIndex = 0;
                }
                playbackInterval = setInterval(() => {
                    if (playbackIndex < browserScreenshots.length - 1) {
                        playbackIndex++;
                        updatePlaybackUI();
                    } else {
                        clearInterval(playbackInterval);
                        playbackInterval = null;
                        updatePlaybackUI();
                    }
                }, 1000);
            }
            updatePlaybackUI();
        });
    }

    const browserPrevBtn = document.getElementById('browser-prev-btn');
    if (browserPrevBtn) {
        browserPrevBtn.addEventListener('click', () => {
            if (playbackInterval) {
                clearInterval(playbackInterval);
                playbackInterval = null;
            }
            if (playbackIndex > 0) {
                playbackIndex--;
                updatePlaybackUI();
            }
        });
    }

    const browserNextBtn = document.getElementById('browser-next-btn');
    if (browserNextBtn) {
        browserNextBtn.addEventListener('click', () => {
            if (playbackInterval) {
                clearInterval(playbackInterval);
                playbackInterval = null;
            }
            if (playbackIndex < browserScreenshots.length - 1) {
                playbackIndex++;
                updatePlaybackUI();
            }
        });
    }

    // Permissions List Rendering
    function renderPermissionsList(permissions) {
        const container = document.getElementById('permissions-list-container');
        if (!container) return;

        if (permissions.length === 0) {
            container.innerHTML = '<p class="empty-state">No active whitelist permissions granted in this session.</p>';
            return;
        }

        container.innerHTML = '';
        permissions.forEach(scope => {
            const card = document.createElement('div');
            card.className = 'permission-scope-card';

            const text = document.createElement('span');
            text.className = 'permission-scope-text';
            text.textContent = scope;

            const revokeBtn = document.createElement('button');
            revokeBtn.className = 'revoke-permission-btn';
            revokeBtn.title = 'Revoke this permission';
            revokeBtn.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
            revokeBtn.onclick = () => {
                vscode.postMessage({
                    type: 'revokePermissionScope',
                    scope: scope
                });
            };

            card.appendChild(text);
            card.appendChild(revokeBtn);
            container.appendChild(card);
        });
    }

    const clearPermissionsBtn = document.getElementById('clear-permissions-btn');
    if (clearPermissionsBtn) {
        clearPermissionsBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearPermissions' });
        });
    }

    // Checklist synchronization helper
    function syncChecklistUI(tasks, statuses = []) {
        const container = document.getElementById('artifacts-checklist-container');
        if (!container) return;

        if (!tasks || tasks.length === 0) {
            container.innerHTML = '<p class="empty-state">No checklist tasks loaded. Plan a goal to get started!</p>';
            return;
        }

        container.innerHTML = '';
        tasks.forEach((task, idx) => {
            const status = statuses[idx] || ' ';
            const item = document.createElement('div');
            item.className = 'checklist-item';
            if (status === 'x') item.classList.add('completed');
            if (status === '/') item.classList.add('in-progress');

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'checklist-checkbox';
            if (status === 'x') {
                cb.checked = true;
            } else if (status === '/') {
                cb.indeterminate = true;
            } else {
                cb.checked = false;
            }

            const label = document.createElement('span');
            label.className = 'checklist-label';
            label.textContent = task;

            item.appendChild(cb);
            item.appendChild(label);

            const handleToggle = (e) => {
                e.preventDefault();
                e.stopPropagation();
                let nextStatus = ' ';
                if (status === ' ') {
                    nextStatus = '/';
                } else if (status === '/') {
                    nextStatus = 'x';
                } else {
                    nextStatus = ' ';
                }
                
                let currentStatuses = Array.from({length: tasks.length}, (_, i) => {
                    const el = container.children[i];
                    if (!el) return ' ';
                    if (el.classList.contains('completed')) return 'x';
                    if (el.classList.contains('in-progress')) return '/';
                    return ' ';
                });
                currentStatuses[idx] = nextStatus;

                vscode.postMessage({
                    type: 'updateTaskStatus',
                    index: idx,
                    status: nextStatus
                });

                syncChecklistUI(tasks, currentStatuses);

                const step = document.getElementById(`plan-step-${idx}`);
                if (step) {
                    const icon = step.querySelector('.step-status-icon');
                    if (icon) {
                        icon.className = `step-status-icon ${nextStatus === 'x' ? 'completed' : nextStatus === '/' ? 'running' : 'pending'}`;
                    }
                }
                const floatingStep = document.getElementById(`floating-plan-step-${idx}`);
                if (floatingStep) {
                    const icon = floatingStep.querySelector('.step-status-icon');
                    if (icon) {
                        icon.className = `step-status-icon ${nextStatus === 'x' ? 'completed' : nextStatus === '/' ? 'running' : 'pending'}`;
                    }
                }
                updateFloatingProgress();
            };

            item.onclick = handleToggle;
            cb.onclick = handleToggle;

            container.appendChild(item);
        });
    }

    // Ask Question Modal interactive handler
    function handleAskQuestion(toolId, paramValue) {
        let args = {};
        try {
            args = JSON.parse(paramValue);
        } catch (e) {
            console.error('Failed to parse paramValue for askQuestion:', e);
            return;
        }

        const question = args.question || '';
        let options = args.options || [];
        if (!Array.isArray(options) || options.length === 0) {
            options = ['Yes', 'No'];
        }
        const isMultiSelect = !!args.isMultiSelect;

        const modal = document.getElementById('question-modal');
        const modalText = document.getElementById('question-modal-text');
        const optionsContainer = document.getElementById('question-modal-options');
        const submitBtn = document.getElementById('question-modal-submit');
        const writeInInput = document.getElementById('question-modal-write-in');

        if (!modal || !modalText || !optionsContainer || !submitBtn) return;

        if (messageInput) messageInput.disabled = true;
        if (sendButton) sendButton.disabled = true;

        modalText.innerHTML = formatMarkdown(question);
        optionsContainer.innerHTML = '';
        if (writeInInput) {
            writeInInput.value = '';
        }

        const selectedOptions = new Set();

        options.forEach((optText, optIdx) => {
            const row = document.createElement('div');
            row.className = 'option-row';
            
            const input = document.createElement('input');
            input.type = isMultiSelect ? 'checkbox' : 'radio';
            input.name = 'ask-question-option';
            input.className = 'option-input';
            input.value = optText;
            input.id = `opt-input-${optIdx}`;

            const label = document.createElement('label');
            label.className = 'option-label';
            label.setAttribute('for', `opt-input-${optIdx}`);
            label.textContent = optText;

            row.appendChild(input);
            row.appendChild(label);

            const toggleSelect = () => {
                if (isMultiSelect) {
                    if (input.checked) {
                        input.checked = false;
                        row.classList.remove('selected');
                        selectedOptions.delete(optText);
                    } else {
                        input.checked = true;
                        row.classList.add('selected');
                        selectedOptions.add(optText);
                    }
                } else {
                    optionsContainer.querySelectorAll('.option-row').forEach(r => r.classList.remove('selected'));
                    optionsContainer.querySelectorAll('.option-input').forEach(i => i.checked = false);
                    input.checked = true;
                    row.classList.add('selected');
                    selectedOptions.clear();
                    selectedOptions.add(optText);
                }
            };

            row.onclick = (e) => {
                if (e.target === input || e.target === label) return;
                toggleSelect();
            };

            input.onchange = () => {
                if (isMultiSelect) {
                    if (input.checked) {
                        row.classList.add('selected');
                        selectedOptions.add(optText);
                    } else {
                        row.classList.remove('selected');
                        selectedOptions.delete(optText);
                    }
                } else {
                    optionsContainer.querySelectorAll('.option-row').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    selectedOptions.clear();
                    selectedOptions.add(optText);
                }
            };

            optionsContainer.appendChild(row);
        });

        modal.classList.remove('hidden');

        submitBtn.onclick = () => {
            const writeInVal = writeInInput ? writeInInput.value.trim() : '';
            if (!isMultiSelect && selectedOptions.size === 0 && !writeInVal) {
                return;
            }
            
            modal.classList.add('hidden');
            
            if (messageInput) messageInput.disabled = false;
            if (sendButton) sendButton.disabled = false;

            const answers = Array.from(selectedOptions);
            if (writeInVal) {
                answers.push(writeInVal);
            }
            
            vscode.postMessage({
                type: 'submitQuestionResponse',
                toolId: toolId,
                answer: answers
            });
        };
    }

    // Custom Context Menu implementation for Files Modified items
    const contextMenu = document.getElementById('custom-context-menu');
    let contextMenuFilePath = null;

    function showContextMenu(x, y, filePath) {
        if (!contextMenu) return;
        contextMenuFilePath = filePath;
        
        contextMenu.classList.remove('hidden');
        
        // Temporarily position to get accurate dimension values if they are 0
        contextMenu.style.left = '-1000px';
        contextMenu.style.top = '-1000px';
        
        const menuWidth = contextMenu.offsetWidth || 145;
        const menuHeight = contextMenu.offsetHeight || 64;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        
        let left = x;
        let top = y;
        
        if (x + menuWidth > windowWidth) {
            left = windowWidth - menuWidth - 4;
        }
        if (y + menuHeight > windowHeight) {
            top = windowHeight - menuHeight - 4;
        }
        
        // Prevent negative values if window is too small
        left = Math.max(0, left);
        top = Math.max(0, top);

        contextMenu.style.left = `${left}px`;
        contextMenu.style.top = `${top}px`;
    }

    function hideContextMenu() {
        if (contextMenu) {
            contextMenu.classList.add('hidden');
        }
        contextMenuFilePath = null;
    }

    document.addEventListener('click', () => {
        hideContextMenu();
    });



    if (modifiedFilesBody) {
        modifiedFilesBody.addEventListener('scroll', () => {
            hideContextMenu();
        });
    }

    if (contextMenu) {
        contextMenu.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
        
        const ctxOpenDiff = document.getElementById('ctx-open-diff');
        if (ctxOpenDiff) {
            ctxOpenDiff.addEventListener('click', (e) => {
                e.stopPropagation();
                if (contextMenuFilePath) {
                    vscode.postMessage({ type: 'openDiff', filePath: contextMenuFilePath });
                }
                hideContextMenu();
            });
        }
        
        const ctxOpenEditor = document.getElementById('ctx-open-editor');
        if (ctxOpenEditor) {
            ctxOpenEditor.addEventListener('click', (e) => {
                e.stopPropagation();
                if (contextMenuFilePath) {
                    vscode.postMessage({ type: 'openFileDirectly', filePath: contextMenuFilePath });
                }
                hideContextMenu();
            });
        }
        
        const ctxOpenBrowser = document.getElementById('ctx-open-browser');
        if (ctxOpenBrowser) {
            ctxOpenBrowser.addEventListener('click', (e) => {
                e.stopPropagation();
                if (contextMenuFilePath) {
                    vscode.postMessage({ type: 'openInBrowser', filePath: contextMenuFilePath });
                }
                hideContextMenu();
            });
        }
    }


    let currentStreamingBubble = null;
    let currentStreamingText = '';
    let isStreaming = false;
    let currentWorkedCard = null;
    let workedStartTime = null;
    let workedTimerInterval = null;
    let isRestoringSession = false;
    let isAgentRunning = false;

    function setAgentRunningUI(running) {
        isAgentRunning = running;
        const appContainer = document.querySelector('.app-container');
        const floatingControls = document.getElementById('floating-agent-controls');
        if (appContainer) {
            if (running) {
                appContainer.classList.add('agent-running');
                if (floatingControls) floatingControls.classList.remove('hidden');
            } else {
                appContainer.classList.remove('agent-running');
                if (floatingControls) floatingControls.classList.add('hidden');
            }
        }
    }

    // Setup floating agent control actions
    const floatingStopBtn = document.getElementById('floating-stop-btn');
    if (floatingStopBtn) {
        floatingStopBtn.onclick = () => {
            const sendButton = document.getElementById('send-btn');
            if (sendButton && sendButton.classList.contains('stop-mode')) {
                sendButton.click();
            }
        };
    }
    const floatingRunBgBtn = document.getElementById('floating-run-bg-btn');
    if (floatingRunBgBtn) {
        floatingRunBgBtn.onclick = () => {
            const runBgButton = document.getElementById('run-bg-btn');
            if (runBgButton) {
                runBgButton.click();
            }
        };
    }
    let currentMode = 'plan';
    let savedModelValue = null;
    let savedConfigIndex = null;
    let savedMode = null;
    let sendContext = true;
    let fastAction = false;

    let attachedContext = [];
    let workspaceFiles = [];
    const staticMentions = [
        {
            value: 'Files',
            label: 'Files',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
            </svg>`
        },
        {
            value: 'Directories',
            label: 'Directories',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>`
        },
        {
            value: 'Rules',
            label: 'Rules',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="7" y1="8" x2="17" y2="8"></line>
                <line x1="7" y1="12" x2="17" y2="12"></line>
                <line x1="7" y1="16" x2="12" y2="16"></line>
            </svg>`
        },
        {
            value: 'Terminal',
            label: 'Terminal',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>`
        },
        {
            value: 'Conversation',
            label: 'Conversation',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>`
        },
        {
            value: 'MCP Servers',
            label: 'MCP Servers',
            icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
                <line x1="20" y1="6" x2="20.01" y2="6"></line>
                <line x1="20" y1="18" x2="20.01" y2="18"></line>
            </svg>`
        }
    ];

    // Auto-resize input textarea
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = (messageInput.scrollHeight) + 'px';
        if (!sendButton.classList.contains('stop-mode')) {
            sendButton.disabled = messageInput.value.trim() === '';
        }
        checkMentions();
        checkSlashCommands();
    });

    messageInput.addEventListener('focus', () => {
        checkMentions();
        checkSlashCommands();
    });

    messageInput.addEventListener('blur', () => {
        setTimeout(() => {
            const dropdown = document.getElementById('mention-dropdown');
            if (dropdown) dropdown.classList.add('hidden');
            if (slashDropdown) slashDropdown.classList.add('hidden');
        }, 200);
    });

    const mentionDropdown = document.getElementById('mention-dropdown');
    if (mentionDropdown) {
        mentionDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.mention-item');
            if (item) {
                e.stopPropagation();
                selectMention(item.getAttribute('data-value'));
            }
        });
    }

    const slashDropdown = document.getElementById('slash-dropdown');
    if (slashDropdown) {
        slashDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.mention-item');
            if (item) {
                e.stopPropagation();
                selectSlashCommand(item.getAttribute('data-value'));
            }
        });
    }

    function selectSlashCommand(value) {
        const text = messageInput.value;
        const cursorPosition = messageInput.selectionStart;
        const textBeforeCursor = text.slice(0, cursorPosition);
        const textAfterCursor = text.slice(cursorPosition);
        
        const match = textBeforeCursor.match(/(?:^|\n)\/(\w*)$/);
        if (match) {
            const index = textBeforeCursor.lastIndexOf(match[0]);
            messageInput.value = textBeforeCursor.slice(0, index) + value + textAfterCursor;
            const newCursorPos = index + value.length;
            messageInput.setSelectionRange(newCursorPos, newCursorPos);
        }
        
        slashDropdown.classList.add('hidden');
        messageInput.focus();
        sendButton.disabled = false;
        
        // Auto-resize
        messageInput.style.height = 'auto';
        messageInput.style.height = (messageInput.scrollHeight) + 'px';
    }

    function checkSlashCommands() {
        if (!slashDropdown) return;
        
        const text = messageInput.value;
        const cursorPosition = messageInput.selectionStart;
        const textBeforeCursor = text.slice(0, cursorPosition);
        
        // Match "/" at the start of input or start of a line, followed by optional letters (no spaces)
        const match = textBeforeCursor.match(/(?:^|\n)\/(\w*)$/);
        
        if (match) {
            const query = match[1].toLowerCase();
            const items = slashDropdown.querySelectorAll('.mention-item');
            let visibleCount = 0;
            
            items.forEach((item, index) => {
                const val = item.getAttribute('data-value').trim().toLowerCase(); // e.g. "/goal"
                if (val.includes('/' + query)) {
                    item.style.display = 'flex';
                    if (visibleCount === 0) {
                        item.classList.add('active');
                    } else {
                        item.classList.remove('active');
                    }
                    visibleCount++;
                } else {
                    item.style.display = 'none';
                    item.classList.remove('active');
                }
            });
            
            if (visibleCount > 0) {
                slashDropdown.classList.remove('hidden');
                if (mentionDropdown) mentionDropdown.classList.add('hidden');
            } else {
                slashDropdown.classList.add('hidden');
            }
        } else {
            slashDropdown.classList.add('hidden');
        }
    }

    function selectMention(value) {
        const textBeforeCursor = messageInput.value.slice(0, messageInput.selectionStart);
        const textAfterCursor = messageInput.value.slice(messageInput.selectionStart);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        if (lastAtIndex !== -1) {
            // Remove the '@...' part from input text
            messageInput.value = textBeforeCursor.slice(0, lastAtIndex) + textAfterCursor;
            messageInput.setSelectionRange(lastAtIndex, lastAtIndex);
        }
        
        // Add to attachedContext
        const isFile = workspaceFiles.includes(value);
        if (isFile) {
            const name = value.split('/').pop().split('\\').pop();
            const isDup = attachedContext.some(item => item.type === 'file' && item.filePath === value);
            if (!isDup) {
                attachedContext.push({
                    type: 'file',
                    filePath: value,
                    name: name
                });
            }
        } else {
            const isDup = attachedContext.some(item => item.type === 'static' && item.value === value);
            if (!isDup) {
                attachedContext.push({
                    type: 'static',
                    value: value,
                    name: value
                });
            }
        }
        
        updateContextChips();
        
        // Adjust message input height since text changed
        messageInput.style.height = 'auto';
        messageInput.style.height = (messageInput.scrollHeight) + 'px';
        
        const dropdown = document.getElementById('mention-dropdown');
        if (dropdown) dropdown.classList.add('hidden');
        messageInput.focus();
        sendButton.disabled = (messageInput.value.trim() === '' && attachedContext.length === 0);
    }

    function updateContextChips() {
        const container = document.getElementById('context-chips-container');
        if (!container) return;
        
        container.innerHTML = '';
        if (attachedContext.length === 0) {
            container.classList.add('hidden');
            return;
        }
        
        container.classList.remove('hidden');
        const fragment = document.createDocumentFragment();
        attachedContext.forEach((item, idx) => {
            const chip = document.createElement('div');
            chip.className = 'context-chip';
            
            let icon = '📄';
            let label = item.name;
            if (item.type === 'selection') {
                icon = '⚡';
                label = `${item.name}:${item.startLine}-${item.endLine}`;
            } else if (item.type === 'static') {
                icon = '🏷️';
                label = `@${item.name}`;
            }
            
            chip.innerHTML = `
                <span class="context-chip-icon">${icon}</span>
                <span class="context-chip-label" title="${escapeHtml(item.filePath || item.name)}">${escapeHtml(label)}</span>
                <button type="button" class="context-chip-remove" title="Remove attachment">✕</button>
            `;
            
            const removeBtn = chip.querySelector('.context-chip-remove');
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                attachedContext.splice(idx, 1);
                updateContextChips();
                if (messageInput) {
                    sendButton.disabled = (messageInput.value.trim() === '' && attachedContext.length === 0);
                }
            };
            
            fragment.appendChild(chip);
        });
        container.appendChild(fragment);
    }

    function scrollDropdownIntoView(container, element) {
        if (!container || !element) return;
        const containerTop = container.scrollTop;
        const containerBottom = containerTop + container.clientHeight;
        const elemTop = element.offsetTop;
        const elemBottom = elemTop + element.offsetHeight;

        if (elemTop < containerTop) {
            container.scrollTop = elemTop;
        } else if (elemBottom > containerBottom) {
            container.scrollTop = elemBottom - container.clientHeight;
        }
    }

    function checkMentions() {
        const dropdown = document.getElementById('mention-dropdown');
        if (!dropdown) return;

        const textBeforeCursor = messageInput.value.slice(0, messageInput.selectionStart);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        if (lastAtIndex !== -1) {
            const mentionQuery = textBeforeCursor.slice(lastAtIndex + 1);
            const hasSpace = /\s/.test(mentionQuery);
            const isMentionActive = !hasSpace && (lastAtIndex === 0 || !/\w/.test(textBeforeCursor.charAt(lastAtIndex - 1)));
            
            if (isMentionActive) {
                const queryLower = mentionQuery.toLowerCase();
                
                const maxItems = 50; // Safeguard
                let html = '';
                let index = 0;
                
                // Filter static categories
                for (let i = 0; i < staticMentions.length; i++) {
                    if (index >= maxItems) break;
                    const item = staticMentions[i];
                    if (item.value.toLowerCase().includes(queryLower)) {
                        html += `
                            <div class="mention-item${index === 0 ? ' active' : ''}" data-value="${item.value}">
                                <span class="mention-icon">${item.icon}</span>
                                <span class="mention-label">${item.label}</span>
                            </div>
                        `;
                        index++;
                    }
                }
                
                // Filter, score, and sort files
                const scoredFiles = [];
                for (let i = 0; i < workspaceFiles.length; i++) {
                    const file = workspaceFiles[i];
                    const fileLower = file.toLowerCase();
                    if (fileLower.includes(queryLower)) {
                        const lastSlash = file.lastIndexOf('/');
                        const filename = lastSlash !== -1 ? file.slice(lastSlash + 1) : file;
                        const filenameLower = filename.toLowerCase();
                        
                        let score = 0;
                        if (filenameLower === queryLower) {
                            score = 4; // Exact filename match
                        } else if (filenameLower.startsWith(queryLower)) {
                            score = 3; // Filename starts with query
                        } else if (filenameLower.includes(queryLower)) {
                            score = 2; // Filename contains query
                        } else {
                            score = 1; // Only path contains query
                        }
                        scoredFiles.push({ file, filename, score });
                    }
                }
                
                // Sort by score descending, then by filename length ascending, then alphabetically
                scoredFiles.sort((a, b) => {
                    if (b.score !== a.score) {
                        return b.score - a.score;
                    }
                    if (a.filename.length !== b.filename.length) {
                        return a.filename.length - b.filename.length;
                    }
                    return a.file.localeCompare(b.file);
                });

                // Display top sorted files
                for (let i = 0; i < scoredFiles.length; i++) {
                    if (index >= maxItems) break;
                    const { file, filename } = scoredFiles[i];
                    const lastSlash = file.lastIndexOf('/');
                    const folder = lastSlash !== -1 ? file.slice(0, lastSlash) : '';
                    
                    html += `
                        <div class="mention-item${index === 0 ? ' active' : ''}" data-value="${file}">
                            <span class="mention-icon">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                    <polyline points="14 2 14 8 20 8"></polyline>
                                </svg>
                            </span>
                            <span class="mention-label">
                                ${filename}
                                ${folder ? `<span class="mention-path">${folder}</span>` : ''}
                            </span>
                        </div>
                    `;
                    index++;
                }
                
                if (index > 0) {
                    dropdown.innerHTML = html;
                    dropdown.classList.remove('hidden');
                } else {
                    dropdown.classList.add('hidden');
                }
            } else {
                dropdown.classList.add('hidden');
            }
        } else {
            dropdown.classList.add('hidden');
        }
    }

    // Handle pressing Enter
    messageInput.addEventListener('keydown', (e) => {
        const mentionOpen = mentionDropdown && !mentionDropdown.classList.contains('hidden');
        const slashOpen = slashDropdown && !slashDropdown.classList.contains('hidden');
        const activeDropdown = mentionOpen ? mentionDropdown : (slashOpen ? slashDropdown : null);

        if (activeDropdown) {
            const visibleItems = Array.from(activeDropdown.querySelectorAll('.mention-item')).filter(item => item.style.display !== 'none');
            const activeIndex = visibleItems.findIndex(item => item.classList.contains('active'));

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (visibleItems.length > 0) {
                    if (activeIndex !== -1) {
                        visibleItems[activeIndex].classList.remove('active');
                    }
                    const nextIndex = (activeIndex + 1) % visibleItems.length;
                    visibleItems[nextIndex].classList.add('active');
                    scrollDropdownIntoView(activeDropdown, visibleItems[nextIndex]);
                }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (visibleItems.length > 0) {
                    if (activeIndex !== -1) {
                        visibleItems[activeIndex].classList.remove('active');
                    }
                    const prevIndex = (activeIndex - 1 + visibleItems.length) % visibleItems.length;
                    visibleItems[prevIndex].classList.add('active');
                    scrollDropdownIntoView(activeDropdown, visibleItems[prevIndex]);
                }
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const activeItem = visibleItems[activeIndex];
                if (activeItem) {
                    const val = activeItem.getAttribute('data-value');
                    if (mentionOpen) {
                        selectMention(val);
                    } else {
                        selectSlashCommand(val);
                    }
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                activeDropdown.classList.add('hidden');
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendButton.classList.contains('stop-mode')) {
                sendMessage();
            }
        }
    });

    sendButton.addEventListener('click', () => {
        if (sendButton.classList.contains('stop-mode')) {
            vscode.postMessage({ type: 'stop' });
        } else {
            sendMessage();
        }
    });
    if (runBgButton) {
        runBgButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'sendToBackground' });
        });
    }
    if (clearButton) {
        clearButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });
    }
    if (modifiedFilesHeader && modifiedFilesPanel) {
        modifiedFilesHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            modifiedFilesPanel.classList.toggle('collapsed');
        });
    }

    const settingsBtn = document.getElementById('settings-btn');
    const settingsDrawer = document.getElementById('settings-drawer');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const autoExecutionSelect = document.getElementById('setting-auto-execution');
    const autoExecutePlanSelect = document.getElementById('setting-auto-execute-plan');
    const browserSelect = document.getElementById('setting-browser');
    const btnOpenConfig = document.getElementById('btn-open-config');

    if (settingsBtn && settingsDrawer) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsDrawer.classList.toggle('hidden');
            if (!settingsDrawer.classList.contains('hidden')) {
                vscode.postMessage({ type: 'getSettings' });
            }
        });
    }

    if (closeSettingsBtn && settingsDrawer) {
        closeSettingsBtn.addEventListener('click', () => {
            settingsDrawer.classList.add('hidden');
        });
    }

    if (autoExecutionSelect) {
        autoExecutionSelect.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'autoExecution',
                value: autoExecutionSelect.value
            });
        });
    }

    if (autoExecutePlanSelect) {
        autoExecutePlanSelect.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'autoExecutePlan',
                value: autoExecutePlanSelect.value === 'true'
            });
        });
    }

    if (browserSelect) {
        browserSelect.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'browser',
                value: browserSelect.value
            });
        });
    }

    const autocompleteSelect = document.getElementById('setting-inline-autocomplete');
    if (autocompleteSelect) {
        autocompleteSelect.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'enableInlineCompletion',
                value: autocompleteSelect.value === 'true'
            });
        });
    }

    const autocompleteModelSelect = document.getElementById('setting-inline-autocomplete-model');
    if (autocompleteModelSelect) {
        autocompleteModelSelect.addEventListener('change', () => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'inlineCompletionModel',
                value: autocompleteModelSelect.value
            });
        });
    }

    const autocompleteTimeoutInput = document.getElementById('setting-inline-autocomplete-timeout');
    if (autocompleteTimeoutInput) {
        autocompleteTimeoutInput.addEventListener('change', () => {
            const val = parseInt(autocompleteTimeoutInput.value, 10);
            if (!isNaN(val) && val >= 1000) {
                vscode.postMessage({
                    type: 'updateSetting',
                    key: 'inlineCompletionTimeout',
                    value: val
                });
            }
        });
    }

    if (btnOpenConfig) {
        btnOpenConfig.addEventListener('click', () => {
            vscode.postMessage({ type: 'openConfig' });
        });
    }

    // History drawer toggling
    const historyBtn = document.getElementById('history-btn');
    const historyDrawer = document.getElementById('history-drawer');
    const closeDrawerBtn = document.getElementById('close-drawer-btn');

    if (historyBtn && historyDrawer) {
        historyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            historyDrawer.classList.toggle('hidden');
            if (!historyDrawer.classList.contains('hidden')) {
                vscode.postMessage({ type: 'loadHistory' });
            }
        });
    }

    if (closeDrawerBtn && historyDrawer) {
        closeDrawerBtn.addEventListener('click', () => {
            historyDrawer.classList.add('hidden');
        });
    }

    // Model dropdown select logic
    const modelSelectBtn = document.getElementById('model-select-btn');
    const modelDropdownMenu = document.getElementById('model-dropdown-menu');

    if (modelSelectBtn && modelDropdownMenu) {
        modelSelectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            modelDropdownMenu.classList.toggle('hidden');
            if (modeDropdownMenu) modeDropdownMenu.classList.add('hidden');
            if (plusDropdownMenu) plusDropdownMenu.classList.add('hidden');
        });
    }

    // Mode dropdown select logic
    const modeSelectBtn = document.getElementById('mode-select-btn');
    const modeDropdownMenu = document.getElementById('mode-dropdown-menu');

    if (modeSelectBtn && modeDropdownMenu) {
        modeSelectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            modeDropdownMenu.classList.toggle('hidden');
            if (modelDropdownMenu) modelDropdownMenu.classList.add('hidden');
            if (plusDropdownMenu) plusDropdownMenu.classList.add('hidden');
        });
    }

    // Plus button context/image upload dropdown
    const plusBtn = document.getElementById('plus-btn');
    const plusDropdownMenu = document.getElementById('plus-dropdown-menu');
    const imageFileInput = document.getElementById('image-file-input');
    const btnAddImage = document.getElementById('btn-add-image');

    if (plusBtn && plusDropdownMenu) {
        plusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            plusDropdownMenu.classList.toggle('hidden');
            if (modelDropdownMenu) modelDropdownMenu.classList.add('hidden');
            if (modeDropdownMenu) modeDropdownMenu.classList.add('hidden');
        });
    }

    if (btnAddImage && imageFileInput) {
        btnAddImage.addEventListener('click', (e) => {
            e.stopPropagation();
            imageFileInput.click();
            if (plusDropdownMenu) plusDropdownMenu.classList.add('hidden');
        });
    }

    if (imageFileInput) {
        imageFileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (isImageFile(file)) {
                        handleImageFile(file);
                    }
                }
            }
            // Reset to allow selecting the same file again
            imageFileInput.value = '';
        });
    }

    // Context Toggle
    const contextToggleBtn = document.getElementById('context-toggle-btn');
    if (contextToggleBtn) {
        contextToggleBtn.onclick = () => {
            sendContext = !sendContext;
            updateContextToggleUI();
            vscode.postMessage({
                type: 'selectSendContext',
                sendContext: sendContext
            });
        };
    }

    function updateContextToggleUI() {
        if (!contextToggleBtn) return;
        if (sendContext) {
            contextToggleBtn.classList.add('active');
            contextToggleBtn.classList.remove('inactive');
            contextToggleBtn.querySelector('.toggle-icon').textContent = '🔗';
            contextToggleBtn.title = 'Send chat history as context (Context)';
        } else {
            contextToggleBtn.classList.remove('active');
            contextToggleBtn.classList.add('inactive');
            contextToggleBtn.querySelector('.toggle-icon').textContent = '❌';
            contextToggleBtn.title = 'Do not send chat history as context (No Context)';
        }
    }

    // Fast Action Toggle
    const fastActionToggleBtn = document.getElementById('fast-action-toggle-btn');
    if (fastActionToggleBtn) {
        fastActionToggleBtn.onclick = () => {
            fastAction = !fastAction;
            updateFastActionToggleUI();
            vscode.postMessage({
                type: 'selectFastAction',
                fastAction: fastAction
            });
        };
    }

    function updateFastActionToggleUI() {
        if (!fastActionToggleBtn) return;
        if (fastAction) {
            fastActionToggleBtn.classList.add('active');
            fastActionToggleBtn.classList.remove('inactive');
            fastActionToggleBtn.querySelector('.toggle-icon').textContent = '⚡';
            fastActionToggleBtn.title = 'Fast Action: On (Agent executes without explanation)';
        } else {
            fastActionToggleBtn.classList.remove('active');
            fastActionToggleBtn.classList.add('inactive');
            fastActionToggleBtn.querySelector('.toggle-icon').textContent = '❌';
            fastActionToggleBtn.title = 'Fast Action: Off';
        }
    }



    // Close dropdowns and drawer when clicking outside
    document.addEventListener('click', (e) => {
        if (modelDropdownMenu) modelDropdownMenu.classList.add('hidden');
        if (modeDropdownMenu) modeDropdownMenu.classList.add('hidden');
        if (plusDropdownMenu) plusDropdownMenu.classList.add('hidden');
        if (historyDrawer && !historyDrawer.classList.contains('hidden')) {
            if (!historyDrawer.contains(e.target) && e.target !== historyBtn && !historyBtn.contains(e.target)) {
                historyDrawer.classList.add('hidden');
            }
        }
        if (settingsDrawer && !settingsDrawer.classList.contains('hidden')) {
            if (!settingsDrawer.contains(e.target) && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
                settingsDrawer.classList.add('hidden');
            }
        }
        const addAiDrawer = document.getElementById('add-ai-drawer');
        if (addAiDrawer && !addAiDrawer.classList.contains('hidden')) {
            const clickedAddModelDropdown = e.target.closest('.add-model-item');
            const clickedAddAiBtn = e.target.closest('#btn-add-ai');
            if (!addAiDrawer.contains(e.target) && !clickedAddModelDropdown && !clickedAddAiBtn) {
                addAiDrawer.classList.add('hidden');
            }
        }
    });

    // Dropdown item selection (using event delegation for dynamic items)
    if (modelDropdownMenu) {
        modelDropdownMenu.addEventListener('click', (e) => {
            const refreshBtn = e.target.closest('#refresh-models-btn');
            if (refreshBtn) {
                e.stopPropagation();
                refreshBtn.classList.add('spinning');
                vscode.postMessage({ type: 'refreshModels' });
                return;
            }

            const addModelItem = e.target.closest('.add-model-item');
            if (addModelItem) {
                e.stopPropagation();
                modelDropdownMenu.classList.add('hidden');
                openAddAiDrawer();
                return;
            }

            const item = e.target.closest('.dropdown-item');
            if (!item) return;
            e.stopPropagation();
            
            // Remove active from siblings
            modelDropdownMenu.querySelectorAll('.dropdown-item').forEach(el => {
                el.classList.remove('active');
            });
            
            // Add active to current
            item.classList.add('active');
            
            // Update button label
            const label = item.getAttribute('data-label');
            const labelEl = document.getElementById('selected-model-label');
            if (labelEl) labelEl.textContent = label;
            
            // Save selected model
            const selectedModel = item.getAttribute('data-value');
            const configIndexAttr = item.getAttribute('data-config-index');
            const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;
            vscode.postMessage({
                type: 'selectModel',
                model: selectedModel,
                configIndex: configIndex
            });
            
            // Hide menu
            modelDropdownMenu.classList.add('hidden');
        });
    }

    // Mode dropdown selection
    if (modeDropdownMenu) {
        modeDropdownMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.dropdown-item');
            if (!item) return;
            e.stopPropagation();
            
            // Remove active from siblings
            modeDropdownMenu.querySelectorAll('.dropdown-item').forEach(el => {
                el.classList.remove('active');
            });
            
            // Add active to current
            item.classList.add('active');
            
            // Update currentMode variable
            currentMode = item.getAttribute('data-value');
            
            // Save selected mode
            vscode.postMessage({
                type: 'selectMode',
                mode: currentMode
            });
            
            // Update button label
            const label = item.getAttribute('data-label');
            const labelEl = document.getElementById('selected-mode-label');
            if (labelEl) labelEl.textContent = label;
            
            // Hide menu
            modeDropdownMenu.classList.add('hidden');
        });
    }

    // Handle suggestion pill clicks
    document.querySelectorAll('.suggest-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            messageInput.value = pill.getAttribute('data-prompt');
            messageInput.style.height = 'auto';
            messageInput.style.height = (messageInput.scrollHeight) + 'px';
            sendButton.disabled = false;
            sendMessage();
        });
    });

    function sendMessage() {
        if (sendButton.classList.contains('stop-mode')) return;
        const text = messageInput.value.trim();
        if (!text && attachedContext.length === 0) return;

        // Retrieve selected model and mode
        const activeModelItem = document.querySelector('#model-dropdown-menu .dropdown-item.active');
        const selectedModel = activeModelItem ? activeModelItem.getAttribute('data-value') : 'gemini-3.5-flash-high';
        
        const configIndexAttr = activeModelItem ? activeModelItem.getAttribute('data-config-index') : null;
        const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;

        const activeModeItem = document.querySelector('#mode-dropdown-menu .dropdown-item.active');
        const selectedMode = activeModeItem ? activeModeItem.getAttribute('data-value') : 'plan';
        currentMode = selectedMode;

        // Clear input
        messageInput.value = '';
        messageInput.style.height = 'auto';
        sendButton.disabled = true;

        // Hide welcome container if present
        const welcome = document.getElementById('welcome-container');
        if (welcome) welcome.style.display = 'none';

        isStreaming = true;
        currentStreamingBubble = null;
        currentStreamingText = '';
        finalizeWorkedCard();
        setAgentRunningUI(true);

        // Send to extension host
        vscode.postMessage({
            type: 'message',
            text: text,
            images: attachedImages,
            contextItems: attachedContext,
            model: selectedModel,
            configIndex: configIndex,
            mode: selectedMode
        });
        
        attachedImages = [];
        updateImagePreview();
        
        attachedContext = [];
        updateContextChips();
    }

    let activePlanTasks = [];
    let planObserver = null;

    function destroyFloatingPlan() {
        if (planObserver) {
            planObserver.disconnect();
            planObserver = null;
        }
        const existingWidget = document.getElementById('floating-plan-widget');
        if (existingWidget) {
            existingWidget.remove();
        }
        floatingPlanTasks = [];
    }

    let floatingPlanTasks = [];

    function createOrUpdateFloatingPlan(tasks, forceCompleted = false) {
        destroyFloatingPlan();
        if (!tasks || tasks.length === 0) return;
        floatingPlanTasks = tasks;

        const appContainer = document.querySelector('.app-container');
        if (!appContainer) return;

        // Create the floating plan widget container
        const widget = document.createElement('div');
        widget.id = 'floating-plan-widget';
        widget.className = 'floating-plan-widget hidden';

        // 1. Create the floating pill (collapsed view)
        const pill = document.createElement('div');
        pill.id = 'floating-plan-pill';
        pill.className = 'floating-plan-pill';
        pill.innerHTML = `
            <span class="pill-icon">📋</span>
            <span class="pill-text">Plan: <strong id="floating-progress-text">0/${tasks.length}</strong></span>
            <span class="pill-arrow">▲</span>
        `;
        widget.appendChild(pill);

        // 2. Create the detailed popup panel (expanded view)
        const panel = document.createElement('div');
        panel.id = 'floating-plan-panel';
        panel.className = 'floating-plan-panel hidden';
        
        const header = document.createElement('div');
        header.className = 'floating-panel-header';
        header.innerHTML = `
            <span>📋 Plan Steps</span>
            <button class="floating-panel-close" id="floating-panel-close-btn">&times;</button>
        `;
        panel.appendChild(header);

        const list = document.createElement('div');
        list.className = 'floating-steps-list';
        tasks.forEach((task, idx) => {
            const item = document.createElement('div');
            item.className = 'floating-step-item';
            item.id = `floating-plan-step-${idx}`;
            
            let statusClass = 'pending';
            if (forceCompleted) {
                statusClass = 'completed';
            } else {
                const mainStep = document.getElementById(`plan-step-${idx}`);
                if (mainStep) {
                    const mainIcon = mainStep.querySelector('.step-status-icon');
                    if (mainIcon) {
                        if (mainIcon.classList.contains('running')) statusClass = 'running';
                        else if (mainIcon.classList.contains('completed')) statusClass = 'completed';
                        else if (mainIcon.classList.contains('failed')) statusClass = 'failed';
                    }
                }
            }

            item.innerHTML = `
                <div class="step-status-icon ${statusClass}"></div>
                <div class="step-text">${task}</div>
                ${!forceCompleted ? `<button class="step-run-btn" title="Execute plan starting from this step" data-index="${idx}">▶</button>` : ''}
            `;

            const stepTextEl = item.querySelector('.step-text');
            if (stepTextEl) {
                stepTextEl.onclick = (e) => {
                    e.stopPropagation();
                    jumpToTaskText(idx, task);
                };
            }

            const runBtn = item.querySelector('.step-run-btn');
            if (runBtn) {
                runBtn.onclick = (e) => {
                    e.stopPropagation();
                    const mainExecBtn = document.getElementById('execute-plan-btn');
                    if (mainExecBtn && (mainExecBtn.disabled || mainExecBtn.classList.contains('executing'))) {
                        return;
                    }
                    
                    const activeModelItem = document.querySelector('#model-dropdown-menu .dropdown-item.active');
                    const selectedModel = activeModelItem ? activeModelItem.getAttribute('data-value') : 'gemini-3.5-flash-high';
                    const configIndexAttr = activeModelItem ? activeModelItem.getAttribute('data-config-index') : null;
                    const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;

                    vscode.postMessage({
                        type: 'executePlan',
                        tasks: tasks,
                        model: selectedModel,
                        configIndex: configIndex,
                        startIndex: idx
                    });
                };
            }

            list.appendChild(item);
        });
        panel.appendChild(list);

        const footer = document.createElement('div');
        footer.className = 'floating-panel-footer';

        const mainExecBtn = document.getElementById('execute-plan-btn');
        const isExecuting = mainExecBtn ? mainExecBtn.classList.contains('executing') : false;

        const executeBtn = document.createElement('button');
        executeBtn.className = 'plan-execute-btn';
        executeBtn.id = 'floating-execute-plan-btn';
        executeBtn.textContent = isExecuting ? 'Executing...' : (forceCompleted ? 'Completed' : 'Execute Plan');
        executeBtn.type = 'button';
        if (isExecuting || forceCompleted) {
            executeBtn.disabled = true;
            if (isExecuting) {
                executeBtn.classList.add('executing');
            }
        }

        executeBtn.onclick = () => {
            const mainBtn = document.getElementById('execute-plan-btn');
            if (mainBtn && !mainBtn.disabled) {
                mainBtn.click();
                executeBtn.disabled = true;
                executeBtn.textContent = 'Executing...';
                executeBtn.classList.add('executing');
            }
        };
        footer.appendChild(executeBtn);
        panel.appendChild(footer);

        widget.appendChild(panel);
        appContainer.appendChild(widget);

        // Click listeners
        pill.onclick = (e) => {
            e.stopPropagation();
            panel.classList.toggle('hidden');
            pill.querySelector('.pill-arrow').textContent = panel.classList.contains('hidden') ? '▲' : '▼';
        };

        const closeBtn = panel.querySelector('#floating-panel-close-btn');
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            panel.classList.add('hidden');
            pill.querySelector('.pill-arrow').textContent = '▲';
        };

        // Click outside panel to close it
        document.addEventListener('click', (e) => {
            if (!widget.contains(e.target)) {
                panel.classList.add('hidden');
                pill.querySelector('.pill-arrow').textContent = '▲';
            }
        });

        // Setup Intersection Observer on the main plan card
        const mainPlanCard = document.getElementById('active-plan-card');
        if (mainPlanCard) {
            planObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        widget.classList.add('hidden');
                        panel.classList.add('hidden');
                        pill.querySelector('.pill-arrow').textContent = '▲';
                    } else {
                        widget.classList.remove('hidden');
                        updateFloatingProgress();
                    }
                });
            }, {
                root: chatContainer,
                threshold: 0.1
            });
            planObserver.observe(mainPlanCard);
        }

        updateFloatingProgress();
    }

    function updateFloatingProgress() {
        const widget = document.getElementById('floating-plan-widget');
        if (!widget) return;

        let completed = 0;
        let runningIdx = -1;
        const items = widget.querySelectorAll('.floating-step-item');
        items.forEach((item, idx) => {
            const icon = item.querySelector('.step-status-icon');
            if (icon) {
                if (icon.classList.contains('completed')) {
                    completed++;
                } else if (icon.classList.contains('running')) {
                    runningIdx = idx;
                }
            }
        });

        const progressText = document.getElementById('floating-progress-text');
        if (progressText) {
            progressText.textContent = `${completed}/${floatingPlanTasks.length}`;
        }

        const pill = document.getElementById('floating-plan-pill');
        if (pill) {
            if (runningIdx !== -1) {
                pill.classList.add('running');
            } else {
                pill.classList.remove('running');
            }
        }

        // Sync execute buttons
        const mainExecBtn = document.getElementById('execute-plan-btn');
        const floatExecBtn = document.getElementById('floating-execute-plan-btn');
        if (mainExecBtn && floatExecBtn) {
            if (mainExecBtn.disabled) {
                floatExecBtn.disabled = true;
                floatExecBtn.textContent = mainExecBtn.textContent;
                if (mainExecBtn.classList.contains('executing')) {
                    floatExecBtn.classList.add('executing');
                } else {
                    floatExecBtn.classList.remove('executing');
                }
            } else {
                floatExecBtn.disabled = false;
                floatExecBtn.textContent = 'Execute Plan';
                floatExecBtn.classList.remove('executing');
            }
        }
    }

    function deactivateActivePlanCard() {
        const oldCard = document.getElementById('active-plan-card');
        if (oldCard) {
            oldCard.removeAttribute('id');
            oldCard.classList.add('outdated-plan-card');
            
            const oldExecBtn = oldCard.querySelector('#execute-plan-btn');
            if (oldExecBtn) {
                oldExecBtn.removeAttribute('id');
                oldExecBtn.disabled = true;
                oldExecBtn.textContent = 'Outdated';
            }
            
            oldCard.querySelectorAll('.plan-step-item').forEach(step => {
                step.removeAttribute('id');
            });

            oldCard.querySelectorAll('.step-run-btn').forEach(btn => {
                btn.remove();
            });
        }
        destroyFloatingPlan();
    }

    function renderPlanCard(planText, forceCompleted = false, taskStatuses = []) {
        deactivateActivePlanCard();

        const lines = planText.split('\n');
        activePlanTasks = [];
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            let cleaned = line;
            const checkboxMatch = cleaned.match(/^[-*+]\s*\[\s*[xX\s]?\s*\]\s*(.+)$/);
            if (checkboxMatch) {
                cleaned = checkboxMatch[1].trim();
            } else {
                const listMatch = cleaned.match(/^([-*+]|[\d]+[\.)])\s*(.+)$/);
                if (listMatch) {
                    cleaned = listMatch[2].trim();
                }
            }
            if (cleaned) {
                activePlanTasks.push(cleaned);
            }
        }

        if (activePlanTasks.length === 0) return null;

        const card = document.createElement('div');
        card.classList.add('plan-execution-card');
        card.id = 'active-plan-card';

        const header = document.createElement('div');
        header.classList.add('plan-card-header');
        header.innerHTML = `📋 <span>Wind Implementation Plan</span>`;
        card.appendChild(header);

        const list = document.createElement('div');
        list.classList.add('plan-steps-list');
        activePlanTasks.forEach((task, idx) => {
            const step = document.createElement('div');
            step.className = 'plan-step-item';
            step.id = `plan-step-${idx}`;
            
            let statusClass = forceCompleted ? 'completed' : 'pending';
            if (!forceCompleted && taskStatuses && taskStatuses[idx]) {
                const status = taskStatuses[idx];
                if (status === 'x' || status === 'X') {
                    statusClass = 'completed';
                }
            }
            
            step.innerHTML = `
                <div class="step-status-icon ${statusClass}"></div>
                <div class="step-text">${task}</div>
                ${!forceCompleted ? `<button class="step-run-btn" title="Execute plan starting from this step" data-index="${idx}">▶</button>` : ''}
            `;
            const stepTextEl = step.querySelector('.step-text');
            if (stepTextEl) {
                stepTextEl.onclick = (e) => {
                    e.stopPropagation();
                    jumpToTaskText(idx, task);
                };
            }
            list.appendChild(step);
        });
        card.appendChild(list);

        const footer = document.createElement('div');
        footer.classList.add('plan-card-footer');
        
        const executeBtn = document.createElement('button');
        executeBtn.className = 'plan-execute-btn';
        executeBtn.id = 'execute-plan-btn';
        executeBtn.textContent = forceCompleted ? 'Completed' : 'Execute Plan';
        executeBtn.type = 'button';
        if (forceCompleted) {
            executeBtn.disabled = true;
        }
        executeBtn.onclick = () => {
            executeBtn.disabled = true;
            executeBtn.textContent = 'Executing...';
            executeBtn.classList.add('executing');

            isStreaming = true;
            currentStreamingBubble = null;
            currentStreamingText = '';
            finalizeWorkedCard();
            setAgentRunningUI(true);
            
            // Retrieve selected model
            const activeModelItem = document.querySelector('#model-dropdown-menu .dropdown-item.active');
            const selectedModel = activeModelItem ? activeModelItem.getAttribute('data-value') : 'gemini-3.5-flash-high';
            const configIndexAttr = activeModelItem ? activeModelItem.getAttribute('data-config-index') : null;
            const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;

            vscode.postMessage({
                type: 'executePlan',
                tasks: activePlanTasks,
                model: selectedModel,
                configIndex: configIndex
            });
        };
        footer.appendChild(executeBtn);
        card.appendChild(footer);

        // Initialize/update floating plan widget
        setTimeout(() => {
            createOrUpdateFloatingPlan(activePlanTasks, forceCompleted);
        }, 50);

        const initialStatuses = forceCompleted ? activePlanTasks.map(() => 'x') : taskStatuses;
        syncChecklistUI(activePlanTasks, initialStatuses);

        return card;
    }

    // Helper to turn file references into links
    function linkifyFilePaths(html) {
        if (!workspaceFiles || workspaceFiles.length === 0) return html;

        const candidateMap = new Map();
        for (const file of workspaceFiles) {
            candidateMap.set(file.toLowerCase(), file);
            const fileName = file.split('/').pop().split('\\').pop();
            if (fileName && fileName.includes('.') && fileName.length > 3) {
                candidateMap.set(fileName.toLowerCase(), file);
            }
        }

        const tokens = html.split(/(<[^>]+>)/g);
        const placeholders = [];
        const pathRegex = /[a-zA-Z0-9_\-\/\\~\.]+/g;

        for (let i = 0; i < tokens.length; i += 2) {
            let text = tokens[i];
            if (!text) continue;

            text = text.replace(pathRegex, (rawMatch) => {
                let cleanMatch = rawMatch;
                let trailing = '';
                while (cleanMatch.length > 0 && /[\.,;!\?\)\>\]]$/.test(cleanMatch)) {
                    if (candidateMap.has(cleanMatch.toLowerCase())) {
                        break;
                    }
                    trailing = cleanMatch.slice(-1) + trailing;
                    cleanMatch = cleanMatch.slice(0, -1);
                }

                let leading = '';
                while (cleanMatch.length > 0 && /^[\(\<\[]/.test(cleanMatch)) {
                    if (candidateMap.has(cleanMatch.toLowerCase())) {
                        break;
                    }
                    leading = leading + cleanMatch.slice(0, 1);
                    cleanMatch = cleanMatch.slice(1);
                }

                if (cleanMatch.length > 0) {
                    const matchLower = cleanMatch.toLowerCase();
                    if (candidateMap.has(matchLower)) {
                        const targetPath = candidateMap.get(matchLower);
                        const placeholder = `___FILE_PLACEHOLDER_${placeholders.length}___`;
                        placeholders.push(`<span class="file-link" data-path="${targetPath}">${cleanMatch}</span>`);
                        return leading + placeholder + trailing;
                    }
                }
                return rawMatch;
            });

            tokens[i] = text;
        }

        let resultHtml = tokens.join('');
        for (let i = 0; i < placeholders.length; i++) {
            resultHtml = resultHtml.replace(`___FILE_PLACEHOLDER_${i}___`, placeholders[i]);
        }

        return resultHtml;
    }

    // Process basic Markdown to HTML
    function formatMarkdown(text, skipLinkify = false) {
        if (!text) return '';
        
        let processedText = text;

        const codeBlocks = [];

        // Extract and format carousels (four backticks)
        let html = processedText.replace(/````carousel\n([\s\S]*?)\n````/g, (match, content) => {
            const slides = content.split(/<!--\s*slide\s*-->/i);
            const formattedSlides = slides.map((slide, idx) => {
                const activeClass = idx === 0 ? 'active' : '';
                let slideHtml = slide.trim();
                
                const imgMatch = slideHtml.match(/!\[([^\]]*?)\]\((.*?)\)/);
                if (imgMatch) {
                    const caption = imgMatch[1];
                    const url = imgMatch[2];
                    slideHtml = `<div class="carousel-slide-content img-slide"><img src="${url}" alt="${caption}" /><div class="carousel-caption">${caption}</div></div>`;
                } else {
                    const codeMatch = slideHtml.match(/```(\w*)\n([\s\S]*?)```/);
                    if (codeMatch) {
                        const lang = codeMatch[1];
                        const code = codeMatch[2];
                        slideHtml = `<div class="carousel-slide-content code-slide"><pre><code class="language-${lang}">${code.trim()}</code></pre></div>`;
                    } else {
                        slideHtml = `<div class="carousel-slide-content text-slide"><p>${slideHtml.replace(/\n/g, '<br/>')}</p></div>`;
                    }
                }
                
                return `<div class="gravity-carousel-slide ${activeClass}">${slideHtml}</div>`;
            }).join('\n');
            
            const carouselPlaceholder = `___GRAVITY_CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}___`;
            codeBlocks.push(`
<div class="gravity-carousel">
    <div class="gravity-carousel-slides">
        ${formattedSlides}
    </div>
    <div class="gravity-carousel-controls">
        <button class="carousel-btn prev" onclick="moveCarousel(this, -1)">&#10094;</button>
        <button class="carousel-btn next" onclick="moveCarousel(this, 1)">&#10095;</button>
    </div>
</div>
`);
            return carouselPlaceholder;
        });

        // Extract and temporarily store code blocks to prevent them from being formatted or escaped
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const placeholder = `___GRAVITY_CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}___`;
            codeBlocks.push(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
            return placeholder;
        });

        // Strip thinking/thought tags from response
        html = html.replace(/^<thought>\s*/i, '');
        html = html.replace(/^<thought\s+/i, '');
        html = html.replace(/<\/thought>\s*$/i, '');
        html = html.replace(/<\/thought>/gi, '');
        html = html.replace(/^<thinking>\s*/i, '');
        html = html.replace(/^<thinking\s+/i, '');
        html = html.replace(/<\/thinking>\s*$/i, '');
        html = html.replace(/<\/thinking>/gi, '');
        html = html.replace(/^<think>\s*/i, '');
        html = html.replace(/^<think\s+/i, '');
        html = html.replace(/<\/think>\s*$/i, '');
        html = html.replace(/<\/think>/gi, '');

        // Escape HTML characters
        html = html
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Inline code: `code`
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold text: **text**
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Split text by lines to process blockquotes and alerts
        html = html.replace(/(?:^|\n)>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>\s*.*\n?)*)/gmi, (match, type, content) => {
            const lines = content.split('\n').map(l => l.replace(/^>\s*/, '')).join('\n');
            const typeLower = type.toLowerCase();
            return `\n<div class="github-alert ${typeLower}">
                <div class="github-alert-title">${type}</div>
                <div class="github-alert-content">${lines.trim()}</div>
            </div>\n`;
        });

        // Split text by lines to process paragraphs and bullet points
        const lines = html.split('\n');
        let processedLines = [];
        let currentListType = null; // 'ul', 'ol', or null

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            
            // Check if line is a code block placeholder
            if (line.startsWith('___GRAVITY_CODE_BLOCK_PLACEHOLDER_')) {
                if (currentListType) {
                    processedLines.push(`</${currentListType}>`);
                    currentListType = null;
                }
                processedLines.push(line);
                continue;
            }

            // Bullet points: starting with optional spaces/tabs, then - or * or •, then space
            const bulletMatch = line.match(/^\s*([-*•])\s+(.+)$/);
            // Numbered list: starting with optional spaces/tabs, then digits, then dot, then space
            const numberMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);

            if (bulletMatch) {
                if (currentListType !== 'ul') {
                    if (currentListType) {
                        processedLines.push(`</${currentListType}>`);
                    }
                    processedLines.push('<ul>');
                    currentListType = 'ul';
                }
                const content = bulletMatch[2];
                processedLines.push(`<li>${content}</li>`);
            } else if (numberMatch) {
                if (currentListType !== 'ol') {
                    if (currentListType) {
                        processedLines.push(`</${currentListType}>`);
                    }
                    processedLines.push('<ol>');
                    currentListType = 'ol';
                }
                const content = numberMatch[2];
                processedLines.push(`<li>${content}</li>`);
            } else {
                if (currentListType) {
                    processedLines.push(`</${currentListType}>`);
                    currentListType = null;
                }
                
                // For non-list lines, add line breaks properly
                if (line.trim() === '') {
                    processedLines.push('<br/>');
                } else {
                    processedLines.push(line + '<br/>');
                }
            }
        }
        
        if (currentListType) {
            processedLines.push(`</${currentListType}>`);
        }

        // Join processed lines
        html = processedLines.join('\n');

        // Remove double <br/> caused by empty lines getting <br/>
        html = html.replace(/<br\/><br\/>/g, '<br/>');

        // Restore the code blocks
        for (let i = 0; i < codeBlocks.length; i++) {
            html = html.replace(`___GRAVITY_CODE_BLOCK_PLACEHOLDER_${i}___`, codeBlocks[i]);
        }

        if (!skipLinkify) {
            html = linkifyFilePaths(html);
        }

        return html;
    }

    function finalizeWorkedCard() {
        if (currentWorkedCard) {
            if (workedTimerInterval) {
                clearInterval(workedTimerInterval);
                workedTimerInterval = null;
            }

            if (workedStartTime) {
                const elapsedMs = Date.now() - workedStartTime;
                const elapsedSec = Math.floor(elapsedMs / 1000);
                let timeStr = '';
                if (elapsedSec < 60) {
                    timeStr = `${elapsedSec}s`;
                } else {
                    const mins = Math.floor(elapsedSec / 60);
                    const secs = elapsedSec % 60;
                    timeStr = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
                }
                const titleEl = currentWorkedCard.querySelector('.worked-card-title');
                if (titleEl) {
                    titleEl.textContent = `Worked for ${timeStr}`;
                }
            }

            currentWorkedCard.classList.add('completed');
            
            const spinner = currentWorkedCard.querySelector('.worked-card-spinner');
            if (spinner) {
                spinner.classList.add('hidden');
            }
            
            const statusLabel = currentWorkedCard.querySelector('.worked-card-status-label');
            if (statusLabel) {
                statusLabel.classList.remove('hidden');
            }

            const body = currentWorkedCard.querySelector('.worked-card-body');
            if (body) {
                const wasNearBottom = userAtBottom;

                body.classList.add('hidden'); // Collapse the body when finalized
                const activeDetails = body.querySelector('details.thinking-details.streaming');
                if (activeDetails) {
                    activeDetails.classList.remove('streaming');
                    activeDetails.open = false;
                    const activeContent = activeDetails.querySelector('.thinking-content');
                    if (activeContent) {
                        activeContent.classList.remove('streaming');
                        const cursor = activeContent.querySelector('.typing-cursor');
                        if (cursor) cursor.remove();
                    }
                }

                if (wasNearBottom) {
                    setTimeout(() => {
                        scrollToBottom(true);
                    }, 0);
                }
            }
            const arrow = currentWorkedCard.querySelector('.worked-card-arrow');
            if (arrow) {
                arrow.textContent = '▶'; // Reset the arrow to collapsed state
            }
            currentWorkedCard = null;
        }
    }

    function createWorkedCard(title = 'Thinking Process') {
        finalizeWorkedCard();
        
        currentWorkedCard = document.createElement('div');
        currentWorkedCard.className = 'worked-card';
        if (isRestoringSession) {
            currentWorkedCard.classList.add('completed');
        }
        
        workedStartTime = Date.now();
        
        currentWorkedCard.innerHTML = `
            <div class="worked-card-header">
                <span class="worked-card-arrow">${isRestoringSession ? '▶' : '▼'}</span>
                <span class="worked-card-icon">⚙️</span>
                <span class="worked-card-title">${isRestoringSession ? 'Worked' : 'Worked for 0s'}</span>
                <span class="worked-card-status">
                    <span class="worked-card-spinner ${isRestoringSession ? 'hidden' : ''}"></span>
                    <span class="worked-card-status-label ${isRestoringSession ? '' : 'hidden'}">✓</span>
                </span>
            </div>
            <div class="worked-card-body ${isRestoringSession ? 'hidden' : ''}"></div>
        `;
        
        const header = currentWorkedCard.querySelector('.worked-card-header');
        const body = currentWorkedCard.querySelector('.worked-card-body');
        const arrow = currentWorkedCard.querySelector('.worked-card-arrow');
        const cardElement = currentWorkedCard;
        
        if (title) {
            const stepMatch = title.match(/Executing\s+Step\s+(\d+)/i);
            if (stepMatch) {
                const stepIndex = parseInt(stepMatch[1], 10) - 1;
                currentWorkedCard.setAttribute('data-step-index', stepIndex);
            }
        }
        
        header.onclick = () => {
            const wasNearBottom = userAtBottom;
            const isHidden = body.classList.toggle('hidden');
            arrow.textContent = isHidden ? '▶' : '▼';
            if (!isHidden) {
                setTimeout(() => {
                    scrollIntoViewSafe(chatContainer, cardElement);
                }, 0);
            } else if (wasNearBottom) {
                setTimeout(() => {
                    scrollToBottom(true);
                }, 0);
            }
        };

        const tempBubble = document.getElementById('temp-thinking-bubble');
        if (tempBubble) {
            chatContainer.insertBefore(currentWorkedCard, tempBubble);
        } else {
            chatContainer.appendChild(currentWorkedCard);
        }
        
        if (!isRestoringSession) {
            workedTimerInterval = setInterval(() => {
                if (!currentWorkedCard) return;
                const elapsedMs = Date.now() - workedStartTime;
                const elapsedSec = Math.floor(elapsedMs / 1000);
                let timeStr = '';
                if (elapsedSec < 60) {
                    timeStr = `${elapsedSec}s`;
                } else {
                    const mins = Math.floor(elapsedSec / 60);
                    const secs = elapsedSec % 60;
                    timeStr = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
                }
                const titleEl = currentWorkedCard.querySelector('.worked-card-title');
                if (titleEl) {
                    titleEl.textContent = `Worked for ${timeStr}`;
                }
            }, 1000);
        }
        
        scrollToBottom();
    }

    function appendThought(thoughtText, isStreamingChunk = false, title = 'Thinking Process') {
        let isNew = false;
        if (!currentWorkedCard) {
            isNew = true;
            createWorkedCard(title);
        }
        
        const body = currentWorkedCard.querySelector('.worked-card-body');
        const threshold = 15;
        const bodyAtBottom = isNew || (body.scrollHeight - body.clientHeight - body.scrollTop <= threshold);

        const rawText = thoughtText || '';
        let cleanThought = rawText
            .replace(/^<thought\s+/i, '')
            .replace(/^<thinking\s+/i, '')
            .replace(/^<think\s+/i, '')
            .replace(/<\/?thought>/gi, '')
            .replace(/<\/?thinking>/gi, '')
            .replace(/<\/?think>/gi, '');
        if (!isStreamingChunk) {
            cleanThought = cleanThought.trim();
        }

        if (isStreamingChunk) {
            let activeDetails = body.querySelector('details.thinking-details.streaming');
            if (!activeDetails) {
                activeDetails = document.createElement('details');
                activeDetails.className = 'thinking-details streaming';
                activeDetails.open = true;
                activeDetails.innerHTML = `
                    <summary class="thinking-summary">
                        <span class="thinking-summary-icon">💭</span>
                        <span class="thinking-summary-text">${escapeHtml(title)}</span>
                    </summary>
                    <div class="thinking-content streaming"></div>
                `;
                body.appendChild(activeDetails);
                currentStreamingText = '';
            }
            const activeContent = activeDetails.querySelector('.thinking-content');
            if (activeContent) {
                currentStreamingText += cleanThought;
                activeContent.innerHTML = formatMarkdown(currentStreamingText, true) + '<span class="typing-cursor"></span>';
            }
        } else {
            const activeDetails = body.querySelector('details.thinking-details.streaming');
            if (activeDetails) {
                activeDetails.classList.remove('streaming');
                activeDetails.open = false;
                const activeContent = activeDetails.querySelector('.thinking-content');
                if (activeContent) {
                    activeContent.classList.remove('streaming');
                    const cursor = activeContent.querySelector('.typing-cursor');
                    if (cursor) cursor.remove();
                    if (cleanThought) {
                        activeContent.innerHTML = formatMarkdown(cleanThought, false);
                    } else if (currentStreamingText) {
                        activeContent.innerHTML = formatMarkdown(currentStreamingText, false);
                    }
                }
            } else {
                if (cleanThought) {
                    const details = document.createElement('details');
                    details.className = 'thinking-details';
                    details.open = !isRestoringSession;
                    details.innerHTML = `
                        <summary class="thinking-summary">
                            <span class="thinking-summary-icon">💭</span>
                            <span class="thinking-summary-text">${escapeHtml(title)}</span>
                        </summary>
                        <div class="thinking-content">${formatMarkdown(cleanThought, false)}</div>
                    `;
                    body.appendChild(details);
                }
            }
        }

        if (bodyAtBottom) {
            body.scrollTop = body.scrollHeight;
        }

        if (isNew) {
            scrollToBottom();
        } else if (isStreamingChunk && !body.classList.contains('hidden')) {
            scrollToBottom();
        }
    }

    function isErrorMessage(text) {
        if (!text) return false;
        const lowerText = text.toLowerCase();
        
        // Check prefixes and phrases
        if (text.startsWith('❌') || 
            text.startsWith('🛑') || 
            text.startsWith('⚠️') ||
            (text.startsWith('[System]') && (lowerText.includes('lỗi') || lowerText.includes('error') || lowerText.includes('failed') || lowerText.includes('thất bại'))) ||
            lowerText.startsWith('error running agent') ||
            lowerText.startsWith('error:') ||
            lowerText.startsWith('**error running agent:**') ||
            lowerText.startsWith('llm api call failed') ||
            lowerText.includes('vòng lặp vô tận') ||
            lowerText.includes('infinite loop prevented') ||
            lowerText.includes('halted due to error') ||
            lowerText.includes('failed to execute') ||
            lowerText.includes('failed for inline') ||
            lowerText.includes('error in test loop')
        ) {
            return true;
        }
        return false;
    }

    function appendErrorCard(text, index = null) {
        if (!isAgentRunning) {
            finalizeWorkedCard();
        }

        const card = document.createElement('div');
        card.classList.add('error-card', 'collapsed');
        if (index !== null) {
            card.setAttribute('data-index', index);
        }

        // Parse title and details
        let titleText = 'Error';
        let detailsText = text;

        const firstLine = text.split('\n')[0].trim();
        if (firstLine) {
            // Strip formatting symbols for clean title text
            titleText = firstLine.replace(/\*\*|❌|⚠️|🛑|\[System\]/gi, '').trim();
            if (titleText.startsWith(':')) {
                titleText = titleText.substring(1).trim();
            }
            if (titleText.length > 100) {
                titleText = titleText.substring(0, 97) + '...';
            }
        }

        // Set title prefix for context if it was System-based
        if (text.startsWith('[System]')) {
            titleText = 'System: ' + titleText;
        }

        // Determine icon based on message content
        let icon = '❌';
        if (text.includes('Warning') || text.includes('⚠️') || text.includes('vòng lặp') || text.includes('loop')) {
            icon = '⚠️';
            card.classList.add('warning');
        } else if (text.includes('🛑') || text.includes('stopped')) {
            icon = '🛑';
        }

        card.innerHTML = `
            <div class="error-card-header">
                <span class="error-card-arrow">▶</span>
                <span class="error-card-icon">${icon}</span>
                <span class="error-card-title">${escapeHtml(titleText)}</span>
            </div>
            <div class="error-card-body hidden">
                <div class="error-card-content">${formatMarkdown(detailsText, false)}</div>
            </div>
        `;

        const header = card.querySelector('.error-card-header');
        const body = card.querySelector('.error-card-body');
        const arrow = card.querySelector('.error-card-arrow');

        header.onclick = (e) => {
            e.stopPropagation();
            const isHidden = body.classList.toggle('hidden');
            card.classList.toggle('collapsed', isHidden);
            arrow.textContent = isHidden ? '▶' : '▼';
            if (!isHidden) {
                setTimeout(() => {
                    scrollIntoViewSafe(chatContainer, card);
                }, 0);
            }
        };

        const tempBubble = document.getElementById('temp-thinking-bubble');
        if (tempBubble) {
            chatContainer.insertBefore(card, tempBubble);
        } else {
            chatContainer.appendChild(card);
        }
        scrollToBottom();
    }

    // Append a message bubble to the container
    function appendMessage(sender, text, isStreamStart = false, index = null, images = [], contextItems = []) {
        if (!isAgentRunning) {
            finalizeWorkedCard();
        }

        if (sender === 'agent' && !isStreamStart && isErrorMessage(text)) {
            appendErrorCard(text, index);
            return;
        }

        const row = document.createElement('div');
        row.classList.add('message-row', sender);
        if (index !== null) {
            row.setAttribute('data-index', index);
        }

        const avatar = document.createElement('div');
        avatar.classList.add('avatar');
        if (sender === 'user') {
            avatar.innerHTML = `<div class="user-avatar">U</div>`;
        } else {
            avatar.innerHTML = `
                <div class="agent-avatar">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z" fill="url(#gemini-grad)"/>
                    </svg>
                </div>`;
        }

        const msgContent = document.createElement('div');
        msgContent.classList.add('message-content');

        const bubble = document.createElement('div');
        bubble.classList.add('message-bubble');
        
        if (isStreamStart) {
            bubble.innerHTML = formatMarkdown(text, true) + '<span class="typing-cursor"></span>';
            currentStreamingBubble = bubble;
        } else {
            bubble.innerHTML = formatMarkdown(text, false);
        }

        if (contextItems && contextItems.length > 0) {
            const chipsContainer = document.createElement('div');
            chipsContainer.className = 'message-context-chips';
            contextItems.forEach(item => {
                const chip = document.createElement('div');
                chip.className = 'message-context-chip';
                
                let icon = '📄';
                let label = item.name;
                if (item.type === 'selection') {
                    icon = '⚡';
                    label = `${item.name}:${item.startLine}-${item.endLine}`;
                } else if (item.type === 'static') {
                    icon = '🏷️';
                    label = `@${item.name}`;
                }
                
                chip.innerHTML = `
                    <span class="context-chip-icon">${icon}</span>
                    <span class="context-chip-label" title="${escapeHtml(item.filePath || item.name)}">${escapeHtml(label)}</span>
                `;
                
                if (item.filePath) {
                    chip.style.cursor = 'pointer';
                    chip.onclick = () => {
                        vscode.postMessage({ type: 'openFile', filePath: item.filePath });
                    };
                }
                
                chipsContainer.appendChild(chip);
            });
            bubble.appendChild(chipsContainer);
        }

        const bubbleWrapper = document.createElement('div');
        bubbleWrapper.classList.add('message-bubble-wrapper');
        bubbleWrapper.appendChild(bubble);

        if (images && images.length > 0) {
            const imagesContainer = document.createElement('div');
            imagesContainer.className = 'message-images';
            images.forEach(base64 => {
                const img = document.createElement('img');
                img.src = base64;
                img.className = 'message-image';
                imagesContainer.appendChild(img);
            });
            // Insert images before the bubble wrapper in the message content
            msgContent.appendChild(imagesContainer);
        }

        if (sender === 'user' && index !== null) {
            const editBtn = document.createElement('button');
            editBtn.className = 'message-edit-btn';
            editBtn.title = 'Edit message';
            editBtn.type = 'button';
            editBtn.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>`;
            editBtn.onclick = () => {
                enterEditMode(row, text, index);
            };
            bubbleWrapper.appendChild(editBtn);
        }

        msgContent.appendChild(bubbleWrapper);
        row.appendChild(avatar);
        row.appendChild(msgContent);

        const tempBubble = document.getElementById('temp-thinking-bubble');
        if (tempBubble) {
            chatContainer.insertBefore(row, tempBubble);
        } else {
            chatContainer.appendChild(row);
        }
        scrollToBottom(sender === 'user');
    }

    function enterEditMode(row, originalText, index) {
        const msgContent = row.querySelector('.message-content');
        const bubbleWrapper = row.querySelector('.message-bubble-wrapper');
        
        bubbleWrapper.style.display = 'none';

        const form = document.createElement('div');
        form.className = 'edit-message-form';

        const textarea = document.createElement('textarea');
        textarea.className = 'edit-message-textarea';
        textarea.value = originalText;
        form.appendChild(textarea);

        const actions = document.createElement('div');
        actions.className = 'edit-message-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'edit-btn-cancel';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => {
            form.remove();
            bubbleWrapper.style.display = 'flex';
        };

        const saveBtn = document.createElement('button');
        saveBtn.className = 'edit-btn-save';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save & Submit';
        saveBtn.onclick = () => {
            const newText = textarea.value.trim();
            if (!newText) return;

            form.remove();

            // Retrieve selected model and mode
            const activeModelItem = document.querySelector('#model-dropdown-menu .dropdown-item.active');
            const selectedModel = activeModelItem ? activeModelItem.getAttribute('data-value') : 'gemini-3.5-flash-high';
            
            const configIndexAttr = activeModelItem ? activeModelItem.getAttribute('data-config-index') : null;
            const configIndex = configIndexAttr !== null ? parseInt(configIndexAttr, 10) : undefined;

            const activeModeItem = document.querySelector('#mode-dropdown-menu .dropdown-item.active');
            const selectedMode = activeModeItem ? activeModeItem.getAttribute('data-value') : 'plan';

            isStreaming = true;
            currentStreamingBubble = null;
            currentStreamingText = '';
            finalizeWorkedCard();

            vscode.postMessage({
                type: 'editMessage',
                index: index,
                text: newText,
                model: selectedModel,
                configIndex: configIndex,
                mode: selectedMode
            });
        };

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        form.appendChild(actions);

        msgContent.appendChild(form);
        textarea.focus();
        scrollIntoViewSafe(chatContainer, form);
    }

    function appendThinkingBubble() {
        if (document.getElementById('temp-thinking-bubble')) return;

        const row = document.createElement('div');
        row.classList.add('message-row', 'agent');
        row.id = 'temp-thinking-bubble';

        const avatar = document.createElement('div');
        avatar.classList.add('avatar');
        avatar.innerHTML = `
            <div class="agent-avatar">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z" fill="url(#gemini-grad)"/>
                </svg>
            </div>`;

        const msgContent = document.createElement('div');
        msgContent.classList.add('message-content');

        const bubble = document.createElement('div');
        bubble.classList.add('message-bubble', 'thinking-placeholder');
        bubble.innerHTML = `
            <div class="shimmer-line short"></div>
            <div class="shimmer-line medium"></div>
        `;

        msgContent.appendChild(bubble);
        row.appendChild(avatar);
        row.appendChild(msgContent);

        chatContainer.appendChild(row);
        scrollToBottom();
    }

    function removeThinkingBubble() {
        const bubble = document.getElementById('temp-thinking-bubble');
        if (bubble) {
            bubble.remove();
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Append a tool call card to the container (requires approval or shows action progress)
    function appendToolCallCard(toolId, toolName, paramValue, requiresApproval, requiredScope = '', isPermissionGranted = false) {
        // Finalize any active streaming bubble
        if (currentStreamingBubble) {
            currentStreamingBubble.innerHTML = formatMarkdown(currentStreamingText, false);
            const cursor = currentStreamingBubble.querySelector('.typing-cursor');
            if (cursor) cursor.remove();
            currentStreamingBubble = null;
            currentStreamingText = '';
        }

        if (!currentWorkedCard) {
            createWorkedCard();
        }
        const body = currentWorkedCard.querySelector('.worked-card-body');
        const card = document.createElement('div');
        card.classList.add('tool-call-card');
        card.id = `tool-call-${toolId}`;

        let args = {};
        try {
            args = JSON.parse(paramValue);
        } catch (e) {
            console.error('Failed to parse paramValue:', e);
        }

        let actionText = '';
        if (toolName === 'writeFile') {
            actionText = `Creating/Writing file <strong>${escapeHtml(args.relativeFilePath || '')}</strong>`;
        } else if (toolName === 'readFile') {
            if (args.startLine !== undefined && args.endLine !== undefined) {
                actionText = `Reading file <strong>${escapeHtml(args.relativeFilePath || '')}</strong> (lines ${args.startLine}-${args.endLine})`;
            } else {
                actionText = `Reading file <strong>${escapeHtml(args.relativeFilePath || '')}</strong>`;
            }
        } else if (toolName === 'runCommand') {
            if (args.runInBackground) {
                actionText = `Running command in background: <code>${escapeHtml(args.command || '')}</code>`;
            } else {
                actionText = `Running command: <code>${escapeHtml(args.command || '')}</code>`;
            }
        } else if (toolName === 'listFiles') {
            actionText = `Listing workspace files`;
        } else if (toolName === 'listDir') {
            actionText = `Listing directory contents of <strong>${escapeHtml(args.relativeDirPath || '.')}</strong>`;
        } else if (toolName === 'searchWeb') {
            actionText = `Searching the web for: <strong>"${escapeHtml(args.query || '')}"</strong>`;
        } else if (toolName === 'getCommandStatus') {
            actionText = `Checking status of background command <code>${escapeHtml(args.commandId || '')}</code>`;
        } else if (toolName === 'sendCommandInput') {
            if (args.terminate) {
                actionText = `Terminating background command <code>${escapeHtml(args.commandId || '')}</code>`;
            } else {
                actionText = `Sending input to background command <code>${escapeHtml(args.commandId || '')}</code>`;
            }
        } else {
            actionText = `Running tool: <strong>${escapeHtml(toolName)}</strong>`;
        }

        card.innerHTML = `
            <div class="tool-call-main">
                <div class="tool-status-icon ${requiresApproval ? 'pending' : 'running'}"></div>
                <div class="tool-action-text">${actionText}</div>
                <div class="tool-actions-inline" id="tool-footer-${toolId}"></div>
            </div>
            <div class="tool-error-container hidden"></div>
        `;

        const textSpan = card.querySelector('.tool-action-text');
        if (textSpan) {
            const rawText = actionText.replace(/<[^>]*>/g, '');
            textSpan.setAttribute('title', rawText);
        }

        if (requiresApproval) {
            const footer = card.querySelector(`#tool-footer-${toolId}`);
            
            // Setup sandbox whitelist permission checkbox
            let whitelistCheckbox = null;
            if (requiredScope) {
                const whitelistContainer = document.createElement('div');
                whitelistContainer.className = 'sandbox-whitelist-container';
                
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'sandbox-whitelist-cb';
                cb.id = `whitelist-cb-${toolId}`;
                
                const lbl = document.createElement('label');
                lbl.className = 'sandbox-whitelist-lbl';
                lbl.setAttribute('for', `whitelist-cb-${toolId}`);
                lbl.textContent = `Auto-approve future ${requiredScope} actions`;
                
                whitelistContainer.appendChild(cb);
                whitelistContainer.appendChild(lbl);
                card.appendChild(whitelistContainer);
                
                whitelistCheckbox = cb;
            }

            const approveBtn = document.createElement('button');
            approveBtn.classList.add('tool-btn', 'approve');
            approveBtn.textContent = 'Approve';
            approveBtn.onclick = () => {
                approveBtn.disabled = true;
                rejectBtn.disabled = true;
                if (whitelistCheckbox && whitelistCheckbox.checked) {
                    vscode.postMessage({
                        type: 'grantPermissionScope',
                        scope: requiredScope
                    });
                }
                const icon = card.querySelector('.tool-status-icon');
                if (icon) {
                    icon.className = 'tool-status-icon running';
                }
                vscode.postMessage({ type: 'approveTool', toolId: toolId });
                footer.innerHTML = '<span class="tool-status-label approved">✓ Approved</span>';
                
                const wlContainer = card.querySelector('.sandbox-whitelist-container');
                if (wlContainer) wlContainer.classList.add('hidden');
            };

            const rejectBtn = document.createElement('button');
            rejectBtn.classList.add('tool-btn', 'reject');
            rejectBtn.textContent = 'Reject';
            rejectBtn.onclick = () => {
                approveBtn.disabled = true;
                rejectBtn.disabled = true;
                const icon = card.querySelector('.tool-status-icon');
                if (icon) {
                    icon.className = 'tool-status-icon failed';
                }
                vscode.postMessage({ type: 'rejectTool', toolId: toolId });
                footer.innerHTML = '<span class="tool-status-label rejected">✗ Rejected</span>';
                
                const wlContainer = card.querySelector('.sandbox-whitelist-container');
                if (wlContainer) wlContainer.classList.add('hidden');
            };

            footer.appendChild(rejectBtn);
            footer.appendChild(approveBtn);
        }

        const threshold = 15;
        const bodyAtBottom = body.children.length === 0 || (body.scrollHeight - body.clientHeight - body.scrollTop <= threshold);

        body.appendChild(card);

        if (bodyAtBottom) {
            body.scrollTop = body.scrollHeight;
        }
        scrollToBottom();
    }

    function updateToolCallResult(toolId, success, resultMessage) {
        const card = document.getElementById(`tool-call-${toolId}`);
        if (!card) return;

        const icon = card.querySelector('.tool-status-icon');
        if (icon) {
            icon.className = `tool-status-icon ${success ? 'completed' : 'failed'}`;
        }

        const footer = card.querySelector(`#tool-footer-${toolId}`);
        if (footer) {
            footer.innerHTML = '';
        }

        const body = currentWorkedCard ? currentWorkedCard.querySelector('.worked-card-body') : null;
        const threshold = 15;
        const bodyAtBottom = body ? (body.scrollHeight - body.clientHeight - body.scrollTop <= threshold) : false;

        if (!success) {
            const errContainer = card.querySelector('.tool-error-container');
            if (errContainer) {
                errContainer.classList.remove('hidden');
                errContainer.innerHTML = `<pre class="tool-error">${escapeHtml(resultMessage)}</pre>`;
            }
        }
        
        if (bodyAtBottom && body) {
            body.scrollTop = body.scrollHeight;
        }
        scrollToBottom();
    }

    function scrollToBottom(force = false) {
        if (force || userAtBottom) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
            userAtBottom = true;
            requestAnimationFrame(() => {
                if (force || userAtBottom) {
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    userAtBottom = true;
                }
            });
        }
    }

    function scrollIntoViewSafe(container, element) {
        if (!container || !element) return;
        const containerTop = container.scrollTop;
        const containerBottom = containerTop + container.clientHeight;
        
        let elemTop = 0;
        let current = element;
        while (current && current !== container) {
            elemTop += current.offsetTop;
            current = current.offsetParent;
        }
        const elemBottom = elemTop + element.offsetHeight;

        if (elemTop < containerTop) {
            container.scrollTo({
                top: elemTop - 10,
                behavior: 'smooth'
            });
        } else if (elemBottom > containerBottom) {
            container.scrollTo({
                top: elemBottom - container.clientHeight + 10,
                behavior: 'smooth'
            });
        }
    }

    function jumpToTaskText(index, taskText) {
        // 1. Try to find by data-step-index attribute
        let target = chatContainer.querySelector(`.worked-card[data-step-index="${index}"]`);
        
        // 2. If not found, try to search all thinking cards by title containing index+1 and/or text
        if (!target) {
            const cards = chatContainer.querySelectorAll('.worked-card');
            for (const card of cards) {
                const titleEl = card.querySelector('.worked-card-title');
                if (titleEl && titleEl.textContent) {
                    const titleText = titleEl.textContent;
                    const match = titleText.match(/Executing\s+Step\s+(\d+)/i);
                    if (match && parseInt(match[1], 10) - 1 === index) {
                        target = card;
                        break;
                    }
                }
            }
        }
        
        // 3. If still not found, try to scroll to the step in the active-plan-card
        if (!target) {
            target = document.getElementById(`plan-step-${index}`);
        }
        
        // 4. Scroll to target if found and trigger visual feedback
        if (target) {
            // Expand worked card if it is collapsed
            if (target.classList.contains('worked-card')) {
                const body = target.querySelector('.worked-card-body');
                const arrow = target.querySelector('.worked-card-arrow');
                if (body && body.classList.contains('hidden')) {
                    body.classList.remove('hidden');
                    if (arrow) arrow.textContent = '▼';
                }
            }
            
            // Scroll element to top of chat container
            let elemTop = 0;
            let current = target;
            while (current && current !== chatContainer) {
                elemTop += current.offsetTop;
                current = current.offsetParent;
            }
            chatContainer.scrollTo({
                top: elemTop - 20,
                behavior: 'smooth'
            });
            
            // Visual highlight pulse
            target.classList.remove('highlight-pulse');
            // Trigger reflow to restart animation
            void target.offsetWidth; 
            target.classList.add('highlight-pulse');
            setTimeout(() => {
                target.classList.remove('highlight-pulse');
            }, 2000);
        }
    }

    // Handle messages from the extension host
    window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
            case 'workspaceFiles':
                workspaceFiles = message.files || [];
                break;
            case 'draggedFileResolved':
                if (message.dataUrl) {
                    attachedImages.push(message.dataUrl);
                    updateImagePreview();
                } else if (message.fileContentReference) {
                    const name = message.filePath.split('/').pop().split('\\').pop();
                    const isDup = attachedContext.some(item => 
                        item.type === 'file' && 
                        item.filePath === message.filePath
                    );
                    if (!isDup) {
                        attachedContext.push({
                            type: 'file',
                            filePath: message.filePath,
                            name: name,
                            text: message.fileContentReference,
                            languageId: message.languageId
                        });
                        updateContextChips();
                    }
                    sendButton.disabled = false;
                    messageInput.focus();
                }
                break;
            case 'requestDiagnosticFix':
                if (messageInput) {
                    messageInput.value = message.text;
                    messageInput.style.height = 'auto';
                    messageInput.style.height = (messageInput.scrollHeight) + 'px';
                    sendButton.disabled = false;
                    messageInput.focus();
                    const modeDropdown = document.getElementById('mode-dropdown-menu');
                    if (modeDropdown) {
                        modeDropdown.querySelectorAll('.dropdown-item').forEach(el => {
                            if (el.getAttribute('data-value') === 'agent') {
                                el.classList.add('active');
                                const label = el.getAttribute('data-label');
                                const labelEl = document.getElementById('selected-mode-label');
                                if (labelEl) labelEl.textContent = label;
                            } else {
                                el.classList.remove('active');
                            }
                        });
                        currentMode = 'agent';
                        vscode.postMessage({
                            type: 'selectMode',
                            mode: 'agent'
                        });
                    }
                    setTimeout(() => {
                        sendMessage();
                    }, 300);
                }
                break;
            case 'pinSelection':
                if (messageInput) {
                    const name = message.filePath.split('/').pop().split('\\').pop();
                    const isDup = attachedContext.some(item => 
                        item.type === 'selection' && 
                        item.filePath === message.filePath && 
                        item.startLine === message.startLine && 
                        item.endLine === message.endLine
                    );
                    if (!isDup) {
                        attachedContext.push({
                            type: 'selection',
                            filePath: message.filePath,
                            name: name,
                            startLine: message.startLine,
                            endLine: message.endLine,
                            text: message.text,
                            languageId: message.languageId
                        });
                        updateContextChips();
                    }
                    sendButton.disabled = false;
                    messageInput.focus();
                }
                break;
            case 'toggleHistory':
                if (historyDrawer) {
                    historyDrawer.classList.toggle('hidden');
                    if (!historyDrawer.classList.contains('hidden')) {
                        vscode.postMessage({ type: 'loadHistory' });
                    }
                    if (settingsDrawer) settingsDrawer.classList.add('hidden');
                }
                break;
            case 'toggleSettings':
                if (settingsDrawer) {
                    settingsDrawer.classList.toggle('hidden');
                    if (!settingsDrawer.classList.contains('hidden')) {
                        vscode.postMessage({ type: 'getSettings' });
                    }
                    if (historyDrawer) historyDrawer.classList.add('hidden');
                }
                break;
            case 'updateModels':
                const menu = document.getElementById('model-dropdown-menu');
                if (menu) {
                    // Store the saved/restored values from backend in module scope variables
                    if (message.savedModel !== undefined) savedModelValue = message.savedModel;
                    if (message.savedConfigIndex !== undefined && message.savedConfigIndex !== null) {
                        savedConfigIndex = message.savedConfigIndex.toString();
                    } else if (message.savedConfigIndex === null) {
                        savedConfigIndex = null;
                    }
                    if (message.savedSendContext !== undefined && message.savedSendContext !== null) {
                        sendContext = message.savedSendContext;
                        updateContextToggleUI();
                    }
                    if (message.savedFastAction !== undefined && message.savedFastAction !== null) {
                        fastAction = message.savedFastAction;
                        updateFastActionToggleUI();
                    }
                    if (message.savedMode !== undefined && message.savedMode !== null) {
                        savedMode = message.savedMode;
                        currentMode = savedMode;
                        
                        // Update Mode UI
                        const modeMenu = document.getElementById('mode-dropdown-menu');
                        if (modeMenu) {
                            modeMenu.querySelectorAll('.dropdown-item').forEach(el => {
                                if (el.getAttribute('data-value') === savedMode) {
                                    el.classList.add('active');
                                    const label = el.getAttribute('data-label');
                                    const labelEl = document.getElementById('selected-mode-label');
                                    if (labelEl) labelEl.textContent = label;
                                } else {
                                    el.classList.remove('active');
                                }
                            });
                        }
                    }

                    // Remember selection
                    let selectedConfigIndex = null;
                    let selectedModelValue = null;

                    // Prioritize saved/restored values from backend if present
                    if (savedModelValue !== null && savedModelValue !== undefined) {
                        selectedModelValue = savedModelValue;
                        selectedConfigIndex = savedConfigIndex;
                    } else {
                        // Otherwise, fallback to the current active selection in DOM
                        const activeItem = menu.querySelector('.dropdown-item.active');
                        if (activeItem) {
                            selectedConfigIndex = activeItem.getAttribute('data-config-index');
                            selectedModelValue = activeItem.getAttribute('data-value');
                        }
                    }

                    let firstModelLabel = '';
                    let hasSelectedAny = false;

                    let hasModels = false;
                    if (message.configs && Array.isArray(message.configs)) {
                        message.configs.forEach((config) => {
                            if (config.models && config.models.length > 0) {
                                hasModels = true;
                            }
                        });
                    }

                    const noModelsWarning = document.getElementById('no-models-warning');
                    const inputCard = document.getElementById('input-card');
                    const suggestionsGrid = document.getElementById('suggestions-grid');

                    if (!hasModels) {
                        if (noModelsWarning) noModelsWarning.classList.remove('hidden');
                        if (inputCard) inputCard.classList.add('hidden');
                        if (suggestionsGrid) suggestionsGrid.classList.add('hidden');
                        firstModelLabel = '➕ Add AI Model...';

                        // Dropdown should only show "+ Add AI Model"
                        menu.innerHTML = '';
                        const addModelItem = document.createElement('div');
                        addModelItem.className = 'dropdown-item add-model-item';
                        addModelItem.style.color = 'var(--accent-blue)';
                        addModelItem.style.fontWeight = '500';
                        addModelItem.style.padding = '8px 12px';
                        addModelItem.innerHTML = '<span>➕ Add AI Model...</span>';
                        menu.appendChild(addModelItem);
                    } else {
                        if (noModelsWarning) noModelsWarning.classList.add('hidden');
                        if (inputCard) inputCard.classList.remove('hidden');
                        if (suggestionsGrid) suggestionsGrid.classList.remove('hidden');

                        menu.innerHTML = '<div class="dropdown-header"><span>Model</span><button class="refresh-btn" id="refresh-models-btn" title="Refresh models" type="button">↻</button></div>';

                        message.configs.forEach((config, configIndex) => {
                            const groupHeader = document.createElement('div');
                            groupHeader.className = 'dropdown-group-header';
                            
                            const titleSpan = document.createElement('span');
                            titleSpan.textContent = config.name;
                            groupHeader.appendChild(titleSpan);

                            const actionsDiv = document.createElement('div');
                            actionsDiv.className = 'group-header-actions';

                            // Edit Button
                            const editBtn = document.createElement('button');
                            editBtn.type = 'button';
                            editBtn.className = 'group-header-action-btn edit';
                            editBtn.title = 'Edit AI Settings';
                            editBtn.innerHTML = `
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 20h9"></path>
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                                </svg>
                            `;
                            editBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                menu.classList.add('hidden');
                                editAIConfig(config, configIndex);
                            });
                            actionsDiv.appendChild(editBtn);

                            // Delete Button
                            const deleteBtn = document.createElement('button');
                            deleteBtn.type = 'button';
                            deleteBtn.className = 'group-header-action-btn delete';
                            deleteBtn.title = 'Delete AI';
                            deleteBtn.innerHTML = `
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            `;
                            deleteBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                menu.classList.add('hidden');
                                vscode.postMessage({
                                    type: 'deleteAIProvider',
                                    configIndex: configIndex
                                });
                            });
                            actionsDiv.appendChild(deleteBtn);

                            groupHeader.appendChild(actionsDiv);
                            menu.appendChild(groupHeader);

                            config.models.forEach((modelName) => {
                                const item = document.createElement('div');
                                item.className = 'dropdown-item';
                                item.setAttribute('data-config-index', configIndex);
                                item.setAttribute('data-value', modelName);
                                
                                const modelLower = modelName.toLowerCase();
                                const canRunAgent = !modelLower.includes('deepseek') && !modelLower.includes('gemma');
                                const prefix = canRunAgent ? '🤖 ' : '';
                                
                                item.setAttribute('data-label', `${prefix}${config.name} - ${modelName}`);

                                const span = document.createElement('span');
                                span.textContent = prefix + modelName;
                                item.appendChild(span);

                                menu.appendChild(item);

                                let isActive = false;
                                if (selectedConfigIndex !== null && selectedModelValue !== null) {
                                    isActive = (configIndex.toString() === selectedConfigIndex && modelName === selectedModelValue);
                                } else if (selectedModelValue !== null) {
                                    // Match by model value if config index is not available/matched
                                    isActive = (modelName === selectedModelValue);
                                } else if (!hasSelectedAny) {
                                    isActive = true;
                                }

                                if (isActive) {
                                    item.classList.add('active');
                                    firstModelLabel = `${prefix}${config.name} - ${modelName}`;
                                    hasSelectedAny = true;
                                }
                            });
                        });

                        // Add Divider and "Add AI Model..." Option
                        const divider = document.createElement('div');
                        divider.style.borderTop = '1px solid var(--border-color)';
                        divider.style.margin = '6px 0 2px 0';
                        menu.appendChild(divider);

                        const addModelItem = document.createElement('div');
                        addModelItem.className = 'dropdown-item add-model-item';
                        addModelItem.style.color = 'var(--accent-blue)';
                        addModelItem.style.fontWeight = '500';
                        addModelItem.style.padding = '8px 12px';
                        addModelItem.innerHTML = '<span>➕ Add AI Model...</span>';
                        menu.appendChild(addModelItem);
                    }

                    // Set triggers label
                    const labelEl = document.getElementById('selected-model-label');
                    if (labelEl && firstModelLabel) {
                        labelEl.textContent = firstModelLabel;
                    }

                    const autocompleteModelSelect = document.getElementById('setting-inline-autocomplete-model');
                    if (autocompleteModelSelect) {
                        const currentSelection = autocompleteModelSelect.value || autocompleteModelSelect.getAttribute('data-pending-value') || '';
                        autocompleteModelSelect.innerHTML = '';
                        
                        message.configs.forEach((config) => {
                            const optGroup = document.createElement('optgroup');
                            optGroup.label = config.name;
                            
                            config.models.forEach((modelName) => {
                                const option = document.createElement('option');
                                option.value = modelName;
                                option.textContent = modelName;
                                optGroup.appendChild(option);
                            });
                            autocompleteModelSelect.appendChild(optGroup);
                        });
                        
                        if (currentSelection) {
                            autocompleteModelSelect.value = currentSelection;
                        }
                    }

                    // Populate Configured AIs list in Settings Drawer
                    const configuredAisList = document.getElementById('configured-ais-list');
                    if (configuredAisList) {
                        configuredAisList.innerHTML = '';
                        if (message.configs && message.configs.length > 0) {
                            message.configs.forEach((config, configIndex) => {
                                const item = document.createElement('div');
                                item.className = 'configured-ai-item';
                                
                                const info = document.createElement('div');
                                info.className = 'configured-ai-info';
                                
                                const nameSpan = document.createElement('span');
                                nameSpan.className = 'configured-ai-name';
                                nameSpan.textContent = config.name;
                                info.appendChild(nameSpan);
                                
                                const metaSpan = document.createElement('span');
                                metaSpan.className = 'configured-ai-meta';
                                const providerLabel = DEFAULT_NAMES[config.provider] || config.provider || 'Custom';
                                const modelsCount = config.models ? config.models.length : 0;
                                metaSpan.textContent = `${providerLabel} • ${modelsCount} model${modelsCount !== 1 ? 's' : ''}`;
                                info.appendChild(metaSpan);
                                
                                item.appendChild(info);
                                
                                const actions = document.createElement('div');
                                actions.className = 'configured-ai-actions';
                                
                                // Edit button
                                const editBtn = document.createElement('button');
                                editBtn.type = 'button';
                                editBtn.className = 'configured-ai-action-btn edit';
                                editBtn.title = 'Edit';
                                editBtn.innerHTML = `
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 20h9"></path>
                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                                    </svg>
                                `;
                                editBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    editAIConfig(config, configIndex);
                                });
                                actions.appendChild(editBtn);
                                
                                // Delete button
                                const deleteBtn = document.createElement('button');
                                deleteBtn.type = 'button';
                                deleteBtn.className = 'configured-ai-action-btn delete';
                                deleteBtn.title = 'Delete';
                                deleteBtn.innerHTML = `
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                    </svg>
                                `;
                                deleteBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({
                                        type: 'deleteAIProvider',
                                        configIndex: configIndex
                                    });
                                });
                                actions.appendChild(deleteBtn);
                                
                                item.appendChild(actions);
                                configuredAisList.appendChild(item);
                            });
                        } else {
                            const emptyState = document.createElement('div');
                            emptyState.style.fontSize = '11px';
                            emptyState.style.color = 'var(--text-secondary)';
                            emptyState.style.textAlign = 'center';
                            emptyState.style.padding = '8px';
                            emptyState.textContent = 'No AI configurations have been added yet.';
                            configuredAisList.appendChild(emptyState);
                        }
                    }
                }
                break;

            case 'settings':
                const autoExecVal = message.autoExecution;
                const autoExecSelectElement = document.getElementById('setting-auto-execution');
                if (autoExecSelectElement && autoExecVal) {
                    autoExecSelectElement.value = autoExecVal;
                }
                
                const autoExecutePlanVal = message.autoExecutePlan;
                const autoExecutePlanSelectElement = document.getElementById('setting-auto-execute-plan');
                if (autoExecutePlanSelectElement && autoExecutePlanVal !== undefined) {
                    autoExecutePlanSelectElement.value = autoExecutePlanVal.toString();
                }

                const browserVal = message.browser;
                const browserSelectElement = document.getElementById('setting-browser');
                if (browserSelectElement && browserVal) {
                    browserSelectElement.value = browserVal;
                }

                const enableAutocompleteVal = message.enableInlineCompletion;
                const autocompleteSelectElement = document.getElementById('setting-inline-autocomplete');
                if (autocompleteSelectElement && enableAutocompleteVal !== undefined) {
                    autocompleteSelectElement.value = enableAutocompleteVal.toString();
                }

                const autocompleteModelVal = message.inlineCompletionModel;
                const autocompleteModelSelectElement = document.getElementById('setting-inline-autocomplete-model');
                if (autocompleteModelSelectElement && autocompleteModelVal) {
                    autocompleteModelSelectElement.setAttribute('data-pending-value', autocompleteModelVal);
                    autocompleteModelSelectElement.value = autocompleteModelVal;
                }

                const autocompleteTimeoutVal = message.inlineCompletionTimeout;
                const autocompleteTimeoutInputElement = document.getElementById('setting-inline-autocomplete-timeout');
                if (autocompleteTimeoutInputElement && autocompleteTimeoutVal !== undefined) {
                    autocompleteTimeoutInputElement.value = autocompleteTimeoutVal.toString();
                }
                break;
            case 'streamThought':
                removeThinkingBubble();
                appendThought(message.text, true, message.title);
                break;
            case 'streamChunk':
                removeThinkingBubble();
                isStreaming = true;
                if (!currentStreamingBubble) {
                    currentStreamingText = message.text;
                    appendMessage('agent', currentStreamingText, true);
                } else {
                    currentStreamingText += message.text;
                    currentStreamingBubble.innerHTML = formatMarkdown(currentStreamingText, true) + '<span class="typing-cursor"></span>';
                    scrollToBottom();
                }
                break;
            case 'addMessage':
                // Hide welcome card
                const welcome = document.getElementById('welcome-container');
                if (welcome) welcome.style.display = 'none';

                let rawText = message.text || '';
                let cleanText = rawText;
                let planBlock = null;

                const planStartRegex = /\[PLAN_START\]/i;
                const planEndRegex = /\[PLAN_END\]/i;
                const planStartMatch = rawText.match(planStartRegex);
                const planEndMatch = rawText.match(planEndRegex);
                if (planStartMatch && planEndMatch && planStartMatch.index !== undefined && planEndMatch.index !== undefined) {
                    cleanText = rawText.substring(0, planStartMatch.index) + rawText.substring(planEndMatch.index + planEndMatch[0].length);
                    planBlock = rawText.substring(planStartMatch.index + planStartMatch[0].length, planEndMatch.index);
                }

                if (cleanText && cleanText.startsWith('[Thought]')) {
                    const thoughtText = cleanText.replace(/^\[Thought\]\s*/i, '');
                    appendThought(thoughtText, false, message.title);
                    break;
                }

                if (message.sender === 'user') {
                    removeThinkingBubble();
                    appendMessage(message.sender, cleanText, false, message.index, message.images, message.contextItems);
                    appendThinkingBubble();
                } else if (message.sender === 'agent' && isStreaming) {
                    removeThinkingBubble();

                    // Finalize the current thinking card (hide spinner, clear streaming cursors)
                    if (!isAgentRunning) {
                        finalizeWorkedCard();
                    }

                    if (currentStreamingBubble) {
                        currentStreamingBubble.innerHTML = formatMarkdown(cleanText, false);
                        const row = currentStreamingBubble.closest('.message-row');
                        if (row && message.index !== undefined && message.index !== null) {
                            row.setAttribute('data-index', message.index);
                        }
                        currentStreamingBubble = null;
                    } else {
                        appendMessage('agent', cleanText, false, message.index, message.images, message.contextItems);
                    }
                    isStreaming = false;
                } else {
                    removeThinkingBubble();
                    appendMessage(message.sender, cleanText, false, message.index, message.images, message.contextItems);
                }

                if (planBlock) {
                    const planCard = renderPlanCard(planBlock);
                    if (planCard) {
                        const tempBubble = document.getElementById('temp-thinking-bubble');
                        if (tempBubble) {
                            chatContainer.insertBefore(planCard, tempBubble);
                        } else {
                            chatContainer.appendChild(planCard);
                        }
                        scrollToBottom();
                    }
                }
                break;
            case 'planStepStart':
                const activeStep = document.getElementById(`plan-step-${message.index}`);
                if (activeStep) {
                    const icon = activeStep.querySelector('.step-status-icon');
                    icon.className = 'step-status-icon running';
                    if (userAtBottom) {
                        scrollIntoViewSafe(chatContainer, activeStep);
                    }
                }
                const floatingStep = document.getElementById(`floating-plan-step-${message.index}`);
                if (floatingStep) {
                    const icon = floatingStep.querySelector('.step-status-icon');
                    if (icon) icon.className = 'step-status-icon running';
                }
                updateFloatingProgress();
                // Update artifacts checklist
                const checklistContainerStart = document.getElementById('artifacts-checklist-container');
                if (checklistContainerStart) {
                    const item = checklistContainerStart.children[message.index];
                    if (item) {
                        item.classList.remove('completed');
                        item.classList.add('in-progress');
                        const cb = item.querySelector('.checklist-checkbox');
                        if (cb) {
                            cb.checked = false;
                            cb.indeterminate = true;
                        }
                    }
                }
                break;
            case 'planStepComplete':
                const completedStep = document.getElementById(`plan-step-${message.index}`);
                if (completedStep) {
                    const icon = completedStep.querySelector('.step-status-icon');
                    icon.className = 'step-status-icon completed';
                }
                const floatingCompletedStep = document.getElementById(`floating-plan-step-${message.index}`);
                if (floatingCompletedStep) {
                    const icon = floatingCompletedStep.querySelector('.step-status-icon');
                    if (icon) icon.className = 'step-status-icon completed';
                }
                updateFloatingProgress();
                // Update artifacts checklist
                const checklistContainerComplete = document.getElementById('artifacts-checklist-container');
                if (checklistContainerComplete) {
                    const item = checklistContainerComplete.children[message.index];
                    if (item) {
                        item.classList.remove('in-progress');
                        item.classList.add('completed');
                        const cb = item.querySelector('.checklist-checkbox');
                        if (cb) {
                            cb.checked = true;
                            cb.indeterminate = false;
                        }
                    }
                }
                break;
            case 'planStepFail':
                const failedStep = document.getElementById(`plan-step-${message.index}`);
                if (failedStep) {
                    const icon = failedStep.querySelector('.step-status-icon');
                    icon.className = 'step-status-icon failed';
                }
                const floatingFailedStep = document.getElementById(`floating-plan-step-${message.index}`);
                if (floatingFailedStep) {
                    const icon = floatingFailedStep.querySelector('.step-status-icon');
                    if (icon) icon.className = 'step-status-icon failed';
                }
                updateFloatingProgress();
                // Update artifacts checklist
                const checklistContainerFail = document.getElementById('artifacts-checklist-container');
                if (checklistContainerFail) {
                    const item = checklistContainerFail.children[message.index];
                    if (item) {
                        item.classList.remove('in-progress');
                        item.classList.remove('completed');
                        const cb = item.querySelector('.checklist-checkbox');
                        if (cb) {
                            cb.checked = false;
                            cb.indeterminate = false;
                        }
                    }
                }
                break;
            case 'clearChat':
                chatContainer.innerHTML = '';
                currentWorkedCard = null;
                setAgentRunningUI(false);
                destroyFloatingPlan();
                attachedContext = [];
                updateContextChips();
                // Reset checklist
                const checklistContainerClear = document.getElementById('artifacts-checklist-container');
                if (checklistContainerClear) {
                    checklistContainerClear.innerHTML = '<p class="empty-state">No checklist tasks loaded. Plan a goal to get started!</p>';
                }
                // Reset browser live session images
                browserScreenshots = [];
                playbackIndex = -1;
                if (playbackInterval) {
                    clearInterval(playbackInterval);
                    playbackInterval = null;
                }
                updatePlaybackUI();
                // Restore welcome container
                const restoredWelcome = document.createElement('div');
                restoredWelcome.className = 'welcome-container';
                restoredWelcome.id = 'welcome-container';
                restoredWelcome.innerHTML = `
                    <div class="welcome-header">
                        <svg class="welcome-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z" fill="url(#gemini-grad)"/>
                        </svg>
                        <h2>Hi, I'm Wind</h2>
                        <p class="welcome-subtitle">Your AI coding assistant. Ask me to write code, modify files, or run commands.</p>
                    </div>
                    <div class="suggestions-grid">
                        <button class="suggest-pill" data-prompt="List all files in the project">
                            <span class="pill-icon">📁</span>
                            <span class="pill-text">List workspace files</span>
                        </button>
                        <button class="suggest-pill" data-prompt="Write sample code for file hello.js">
                            <span class="pill-icon">✍️</span>
                            <span class="pill-text">Write hello.js</span>
                        </button>
                        <button class="suggest-pill" data-prompt="Run npm run build and check for errors">
                            <span class="pill-icon">⚙️</span>
                            <span class="pill-text">Run npm build</span>
                        </button>
                    </div>
                `;
                chatContainer.appendChild(restoredWelcome);

                // Re-bind suggestion click handlers
                restoredWelcome.querySelectorAll('.suggest-pill').forEach(pill => {
                    pill.addEventListener('click', () => {
                        messageInput.value = pill.getAttribute('data-prompt');
                        messageInput.style.height = 'auto';
                        messageInput.style.height = (messageInput.scrollHeight) + 'px';
                        sendButton.disabled = false;
                        sendMessage();
                    });
                });
                break;
            case 'setLoading':
                const glowingLoader = document.getElementById('glowing-loader');
                const appContainer = document.querySelector('.app-container');
                if (message.isLoading) {
                    setAgentRunningUI(true);
                    if (glowingLoader) glowingLoader.classList.remove('hidden');
                    if (runBgButton) runBgButton.classList.remove('hidden');
                    sendButton.classList.add('stop-mode');
                    sendButton.disabled = false;
                    sendButton.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="1.5"></rect>
                        </svg>
                    `;
                    if (message.title === 'Executing Plan...') {
                        const execBtn = document.getElementById('execute-plan-btn');
                        if (execBtn) {
                            execBtn.disabled = true;
                            execBtn.textContent = 'Executing...';
                            execBtn.classList.add('executing');
                        }
                    }
                } else {
                    setAgentRunningUI(false);
                    if (glowingLoader) glowingLoader.classList.add('hidden');
                    if (runBgButton) runBgButton.classList.add('hidden');
                    isStreaming = false;
                    currentStreamingBubble = null;
                    finalizeWorkedCard();
                    sendButton.classList.remove('stop-mode');
                    sendButton.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                        </svg>
                    `;
                    sendButton.disabled = messageInput.value.trim() === '';

                    // Reset execute plan buttons
                    const execBtn = document.getElementById('execute-plan-btn');
                    if (execBtn) {
                        execBtn.classList.remove('executing');
                        let allCompleted = false;
                        if (activePlanTasks && activePlanTasks.length > 0) {
                            let completedCount = 0;
                            activePlanTasks.forEach((_, idx) => {
                                const step = document.getElementById(`plan-step-${idx}`);
                                if (step) {
                                    const icon = step.querySelector('.step-status-icon');
                                    if (icon && icon.classList.contains('completed')) {
                                        completedCount++;
                                    }
                                }
                            });
                            allCompleted = (completedCount === activePlanTasks.length);
                        }
                        if (allCompleted) {
                            execBtn.textContent = 'Completed';
                            execBtn.disabled = true;
                        } else {
                            execBtn.textContent = 'Execute Plan';
                            execBtn.disabled = false;
                        }
                    }
                    updateFloatingProgress();
                }
                break;
            case 'toolCall':
                appendToolCallCard(
                    message.toolId, 
                    message.toolName, 
                    message.paramValue, 
                    message.requiresApproval, 
                    message.requiredScope, 
                    message.isPermissionGranted
                );
                break;
            case 'toolResult':
                updateToolCallResult(message.toolId, message.success, message.resultMessage);
                break;
            case 'modelSwitched': {
                // Update model selector label to reflect the active fallback model
                const modelMenu = document.getElementById('model-dropdown-menu');
                if (modelMenu && message.model) {
                    const items = modelMenu.querySelectorAll('.dropdown-item');
                    let found = false;
                    items.forEach(item => {
                        if (item.getAttribute('data-value') === message.model) {
                            // Highlight the active model
                            items.forEach(i => i.classList.remove('active'));
                            item.classList.add('active');
                            const labelEl = document.getElementById('selected-model-label');
                            if (labelEl) labelEl.textContent = item.getAttribute('data-label') || message.model;
                            found = true;
                        }
                    });
                    // Show a toast/notification indicator
                    const loaderEl = document.getElementById('glowing-loader');
                    if (loaderEl) {
                        const switchBadge = document.createElement('div');
                        switchBadge.className = 'model-switch-badge';
                        switchBadge.textContent = `\u21aa Switching to ${message.model}`;
                        loaderEl.parentNode.insertBefore(switchBadge, loaderEl.nextSibling);
                        setTimeout(() => {
                            if (switchBadge.parentNode) switchBadge.parentNode.removeChild(switchBadge);
                        }, 4000);
                    }
                }
                break;
            }
            case 'modifiedFiles':
                if (!modifiedFilesPanel || !modifiedFilesCount || !modifiedFilesBody) break;
                
                const files = message.files || [];
                if (files.length === 0) {
                    modifiedFilesPanel.classList.add('hidden');
                    if (modifiedFilesFooter) modifiedFilesFooter.classList.add('hidden');
                } else {
                    modifiedFilesPanel.classList.remove('hidden');
                    modifiedFilesCount.textContent = files.length;
                    if (modifiedFilesFooter) {
                        const hasPending = files.some(f => !f.accepted);
                        if (hasPending) {
                            modifiedFilesFooter.classList.remove('hidden');
                        } else {
                            modifiedFilesFooter.classList.add('hidden');
                        }
                    }
                    
                    modifiedFilesBody.innerHTML = '';
                    files.forEach(file => {
                        const item = document.createElement('div');
                        item.className = 'modified-file-item' + (file.accepted ? ' accepted' : '');
                        item.title = file.accepted ? `Click to open ${file.path}` : `Click to show diff for ${file.path}`;
                        
                        let changesHtml = '';
                        if (file.accepted) {
                            changesHtml = `<span class="modified-file-accepted-badge">Accepted</span>`;
                        } else if (file.additions > 0 || file.deletions > 0) {
                            changesHtml = `
                                ${file.additions > 0 ? `<span class="modified-file-additions">+${file.additions}</span>` : ''}
                                ${file.deletions > 0 ? `<span class="modified-file-deletions">-${file.deletions}</span>` : ''}
                            `;
                        } else {
                            changesHtml = `<span class="modified-file-additions">new</span>`;
                        }

                        let icon = '📄';
                        const ext = file.path.split('.').pop().toLowerCase();
                        if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) icon = '⚡';
                        else if (ext === 'html') icon = '🌐';
                        else if (ext === 'css') icon = '🎨';
                        else if (ext === 'json') icon = '⚙️';
                        else if (ext === 'md') icon = '📝';

                        let buttonsHtml = '';
                        // Open File and Diff action buttons (always visible on hover for ease of access)
                        buttonsHtml += `
                            <button class="file-action-btn view-diff" title="Compare with Original (Split Diff)">📊</button>
                            <button class="file-action-btn open-file" title="Open Current File">📄</button>
                        `;
                        if (!file.accepted) {
                            buttonsHtml += `
                                <button class="file-action-btn accept" title="Accept changes for this file">✓</button>
                                <button class="file-action-btn discard" title="Discard changes for this file">✕</button>
                            `;
                        }

                        item.innerHTML = `
                            <div class="modified-file-info">
                                <span class="modified-file-icon">${icon}</span>
                                <span class="modified-file-path">${file.path}</span>
                            </div>
                            <div class="modified-file-actions">
                                <div class="modified-file-changes">
                                    ${changesHtml}
                                </div>
                                ${buttonsHtml}
                            </div>
                        `;
                        
                        item.onclick = () => {
                            vscode.postMessage({ type: 'openFile', filePath: file.path });
                        };

                        item.oncontextmenu = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            showContextMenu(e.clientX, e.clientY, file.path);
                        };

                        const diffBtn = item.querySelector('.file-action-btn.view-diff');
                        if (diffBtn) {
                            diffBtn.onclick = (e) => {
                                e.stopPropagation();
                                vscode.postMessage({ type: 'openDiff', filePath: file.path });
                            };
                        }

                        const openFileBtn = item.querySelector('.file-action-btn.open-file');
                        if (openFileBtn) {
                            openFileBtn.onclick = (e) => {
                                e.stopPropagation();
                                vscode.postMessage({ type: 'openFileDirectly', filePath: file.path });
                            };
                        }

                        if (!file.accepted) {
                            const acceptBtn = item.querySelector('.file-action-btn.accept');
                            if (acceptBtn) {
                                acceptBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({ type: 'acceptSingleFile', filePath: file.path });
                                };
                            }

                            const discardBtn = item.querySelector('.file-action-btn.discard');
                            if (discardBtn) {
                                discardBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({ type: 'discardSingleFile', filePath: file.path });
                                };
                            }
                        }
                        
                        modifiedFilesBody.appendChild(item);
                    });
                }
                break;
            case 'historyList':
                const container = document.getElementById('history-list-container');
                if (container) {
                    container.innerHTML = '';
                    if (message.history.length === 0) {
                        container.innerHTML = '<div class="empty-history">No past conversations.</div>';
                    } else {
                        message.history.forEach(item => {
                            const div = document.createElement('div');
                            div.className = 'history-item';
                            const dateStr = new Date(item.timestamp).toLocaleString();
                            div.innerHTML = `
                                <div class="history-item-details">
                                    <span class="history-item-title">${item.title}</span>
                                    <span class="history-item-time">${dateStr}</span>
                                </div>
                                <button class="delete-history-btn" title="Delete conversation" type="button">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                        <line x1="10" y1="11" x2="10" y2="17"></line>
                                        <line x1="14" y1="11" x2="14" y2="17"></line>
                                    </svg>
                                </button>
                            `;
                            div.querySelector('.history-item-details').onclick = () => {
                                vscode.postMessage({ type: 'selectSession', sessionId: item.id });
                                historyDrawer.classList.add('hidden');
                            };
                            div.querySelector('.delete-history-btn').onclick = (e) => {
                                e.stopPropagation();
                                vscode.postMessage({ type: 'deleteSession', sessionId: item.id });
                            };
                            container.appendChild(div);
                        });
                    }
                }
                break;
            case 'restoreSession':
                chatContainer.innerHTML = '';
                currentWorkedCard = null;
                isRestoringSession = true;
                setAgentRunningUI(false);
                destroyFloatingPlan();
                
                const hasSuccessMessage = message.messages.some(msg => 
                    msg.type === 'addMessage' && 
                    msg.sender === 'agent' && 
                    msg.text && 
                    msg.text.includes('All steps in the plan have been executed successfully')
                );

                let lastPlanMsgIndex = -1;
                message.messages.forEach((msg, idx) => {
                    if (msg.type === 'addMessage' && msg.text) {
                        const planStartRegex = /\[PLAN_START\]/i;
                        const planEndRegex = /\[PLAN_END\]/i;
                        if (planStartRegex.test(msg.text) && planEndRegex.test(msg.text)) {
                            lastPlanMsgIndex = idx;
                        }
                    }
                });

                message.messages.forEach((msg, idx) => {
                    if (msg.type === 'addMessage') {
                        if (msg.text && msg.text.startsWith('[Thought]')) {
                            const thoughtText = msg.text.replace(/^\[Thought\]\s*/i, '');
                            appendThought(thoughtText, false, msg.title);
                        } else {
                            currentWorkedCard = null;
                            
                            let rawText = msg.text || '';
                            let cleanText = rawText;
                            let planBlock = null;
                            const planStartRegex = /\[PLAN_START\]/i;
                            const planEndRegex = /\[PLAN_END\]/i;
                            const planStartMatch = rawText.match(planStartRegex);
                            const planEndMatch = rawText.match(planEndRegex);
                            if (planStartMatch && planEndMatch && planStartMatch.index !== undefined && planEndMatch.index !== undefined) {
                                cleanText = rawText.substring(0, planStartMatch.index) + rawText.substring(planEndMatch.index + planEndMatch[0].length);
                                planBlock = rawText.substring(planStartMatch.index + planStartMatch[0].length, planEndMatch.index);
                            }

                            appendMessage(msg.sender, cleanText, false, idx, msg.images, msg.contextItems);
                            if (planBlock) {
                                const isLatestPlan = (idx === lastPlanMsgIndex);
                                const planCard = renderPlanCard(
                                    planBlock,
                                    isLatestPlan ? hasSuccessMessage : true,
                                    isLatestPlan ? (message.taskStatuses || []) : []
                                );
                                if (planCard) {
                                    const tempBubble = document.getElementById('temp-thinking-bubble');
                                    if (tempBubble) {
                                        chatContainer.insertBefore(planCard, tempBubble);
                                    } else {
                                        chatContainer.appendChild(planCard);
                                    }
                                }
                            }
                        }
                    } else if (msg.type === 'toolCall') {
                        appendToolCallCard(msg.toolId, msg.toolName, msg.paramValue, msg.requiresApproval);
                    } else if (msg.type === 'toolResult') {
                        updateToolCallResult(msg.toolId, msg.success, msg.resultMessage);
                    }
                });
                isRestoringSession = false;
                const welcomeContainer = document.getElementById('welcome-container');
                if (welcomeContainer) welcomeContainer.style.display = 'none';
                scrollToBottom(true);
                break;
            case 'permissionsList':
                renderPermissionsList(message.permissions || []);
                break;
            case 'browserScreenshotUpdate':
                if (message.screenshot) {
                    const base64Url = message.screenshot.startsWith('data:') 
                        ? message.screenshot 
                        : `data:image/webp;base64,${message.screenshot}`;
                    browserScreenshots.push(base64Url);
                    const wasAtEnd = playbackIndex === browserScreenshots.length - 2 || playbackIndex === -1;
                    if (wasAtEnd && !playbackInterval) {
                        playbackIndex = browserScreenshots.length - 1;
                    }
                    updatePlaybackUI();
                }
                break;
            case 'askQuestionCall':
                handleAskQuestion(message.toolId, message.paramValue);
                break;
        }
    });

    // --- ADD AI DRAWER LOGIC ---
    const addAiDrawer = document.getElementById('add-ai-drawer');
    const closeAddAiBtn = document.getElementById('close-add-ai-btn');
    const btnAddAi = document.getElementById('btn-add-ai');
    const addAiBackBtn = document.getElementById('add-ai-back-btn');
    const customApiBaseCheckbox = document.getElementById('add-ai-custom-apibase');
    const apiBaseInput = document.getElementById('add-ai-apibase');
    const btnSaveAi = document.getElementById('btn-save-ai');
    
    const stepProviders = document.getElementById('add-ai-step-providers');
    const stepConfig = document.getElementById('add-ai-step-config');
    const addAiTitle = document.getElementById('add-ai-drawer-title');
    
    let selectedProvider = '';
    let editingConfigIndex = null;

    const apiKeysContainer = document.getElementById('api-keys-container');
    const modelsContainer = document.getElementById('models-container');
    const addKeyBtn = document.getElementById('add-key-btn');
    const addModelBtn = document.getElementById('add-model-btn');
    
    const DEFAULT_API_BASES = {
        gemini: 'https://generativelanguage.googleapis.com',
        chatgpt: 'https://api.openai.com/v1',
        claude: 'https://openrouter.ai/api/v1',
        custom: 'http://localhost:3000/v1'
    };
    
    const DEFAULT_NAMES = {
        gemini: 'Google Gemini',
        chatgpt: 'OpenAI ChatGPT',
        claude: 'Anthropic Claude',
        custom: 'Custom AI'
    };
    
    const DEFAULT_PLACEHOLDERS = {
        gemini: {
            keys: 'Paste Gemini API Key here (e.g. AIzaSy...)',
            models: 'e.g. gemini-3.5-flash, gemini-3.5-pro'
        },
        chatgpt: {
            keys: 'Paste OpenAI API Key here (e.g. sk-...)',
            models: 'e.g. gpt-4o, gpt-4o-mini'
        },
        claude: {
            keys: 'Paste OpenRouter API Key here (e.g. sk-or-...)',
            models: 'e.g. anthropic/claude-3.5-sonnet'
        },

        custom: {
            keys: 'Paste API Key here if required',
            models: 'e.g. custom-model-name'
        }
    };
    
    function openAddAiDrawer() {
        editingConfigIndex = null;
        if (addAiDrawer) {
            addAiDrawer.classList.remove('hidden');
            if (settingsDrawer) settingsDrawer.classList.add('hidden');
            if (historyDrawer) historyDrawer.classList.add('hidden');
            showStep('providers');
        }
    }
    
    function showStep(step) {
        if (step === 'providers') {
            stepProviders.classList.remove('hidden');
            stepConfig.classList.add('hidden');
            addAiTitle.textContent = 'Add AI Model';
        } else if (step === 'config') {
            stepProviders.classList.add('hidden');
            stepConfig.classList.remove('hidden');
            if (editingConfigIndex !== null) {
                addAiTitle.textContent = `Edit AI Model`;
            } else {
                addAiTitle.textContent = `Configure ${DEFAULT_NAMES[selectedProvider]}`;
            }
        }
    }

    function editAIConfig(config, index) {
        editingConfigIndex = index;
        selectedProvider = config.provider || 'custom';
        
        if (addAiDrawer) {
            addAiDrawer.classList.remove('hidden');
            if (settingsDrawer) settingsDrawer.classList.add('hidden');
            if (historyDrawer) historyDrawer.classList.add('hidden');
            
            showStep('config');
            addAiTitle.textContent = `Edit AI: ${config.name}`;
            
            document.getElementById('add-ai-name').value = config.name || '';
            
            const defaultBase = DEFAULT_API_BASES[selectedProvider] || '';
            const isCustomUrl = config.apiBase && config.apiBase !== defaultBase;
            customApiBaseCheckbox.checked = isCustomUrl;
            apiBaseInput.value = config.apiBase || defaultBase;
            if (isCustomUrl) {
                apiBaseInput.classList.remove('hidden');
                document.getElementById('apibase-hint').classList.add('hidden');
            } else {
                apiBaseInput.classList.add('hidden');
                document.getElementById('apibase-hint').classList.remove('hidden');
            }
            
            apiKeysContainer.innerHTML = '';
            const placeholders = DEFAULT_PLACEHOLDERS[selectedProvider] || DEFAULT_PLACEHOLDERS.custom;
            
            let keys = [];
            if (Array.isArray(config.apiKey)) {
                keys = config.apiKey;
            } else if (config.apiKey) {
                keys = [config.apiKey];
            }
            
            if (keys.length === 0) {
                createInputRow(apiKeysContainer, placeholders.keys, 'key');
            } else {
                keys.forEach(val => {
                    createInputRow(apiKeysContainer, placeholders.keys, 'key', val);
                });
            }
            
            modelsContainer.innerHTML = '';
            let models = [];
            if (Array.isArray(config.rawModel)) {
                models = config.rawModel;
            } else if (config.rawModel && config.rawModel !== 'Autodetect') {
                models = [config.rawModel];
            }
            
            if (models.length === 0) {
                createInputRow(modelsContainer, placeholders.models, 'model');
            } else {
                models.forEach(val => {
                    createInputRow(modelsContainer, placeholders.models, 'model', val);
                });
            }
        }
    }
    
    if (btnAddAi) {
        btnAddAi.addEventListener('click', (e) => {
            e.stopPropagation();
            editingConfigIndex = null;
            openAddAiDrawer();
        });
    }
    
    if (closeAddAiBtn) {
        closeAddAiBtn.addEventListener('click', () => {
            addAiDrawer.classList.add('hidden');
        });
    }
    
    if (addAiBackBtn) {
        addAiBackBtn.addEventListener('click', () => {
            // When editing, if we go back to providers, reset editingConfigIndex so it works like standard adding flow
            editingConfigIndex = null;
            showStep('providers');
        });
    }
    


    function createInputRow(container, placeholder, type = 'key', initialVal = '') {
        const row = document.createElement('div');
        row.className = 'dynamic-input-row';
        row.style.display = 'flex';
        row.style.gap = '6px';
        row.style.alignItems = 'center';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'settings-input dynamic-input-field';
        input.placeholder = placeholder;
        input.value = initialVal;
        input.style.flex = '1';
        row.appendChild(input);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-input-btn';
        removeBtn.innerHTML = '✕';
        removeBtn.style.background = 'transparent';
        removeBtn.style.border = 'none';
        removeBtn.style.color = 'var(--danger-color)';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.padding = '4px 6px';
        removeBtn.style.fontSize = '12px';
        removeBtn.style.display = 'flex';
        removeBtn.style.alignItems = 'center';
        removeBtn.style.justifyContent = 'center';
        
        removeBtn.onclick = () => {
            row.remove();
        };
        row.appendChild(removeBtn);
        container.appendChild(row);
        
        return input;
    }

    if (addKeyBtn) {
        addKeyBtn.addEventListener('click', () => {
            const placeholders = DEFAULT_PLACEHOLDERS[selectedProvider] || DEFAULT_PLACEHOLDERS.custom;
            createInputRow(apiKeysContainer, placeholders.keys, 'key');
        });
    }

    if (addModelBtn) {
        addModelBtn.addEventListener('click', () => {
            const placeholders = DEFAULT_PLACEHOLDERS[selectedProvider] || DEFAULT_PLACEHOLDERS.custom;
            createInputRow(modelsContainer, placeholders.models, 'model');
        });
    }
    
    // Provider card button listeners
    document.querySelectorAll('.provider-card-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedProvider = btn.getAttribute('data-provider');
            
            // Reset and configure Step 2 form
            document.getElementById('add-ai-name').value = DEFAULT_NAMES[selectedProvider] || '';
            apiKeysContainer.innerHTML = '';
            modelsContainer.innerHTML = '';
            
            // Set placeholders & add initial rows
            const placeholders = DEFAULT_PLACEHOLDERS[selectedProvider] || DEFAULT_PLACEHOLDERS.custom;
            createInputRow(apiKeysContainer, placeholders.keys, 'key');
            createInputRow(modelsContainer, placeholders.models, 'model');
            
            // Config API Base URL section
            customApiBaseCheckbox.checked = false;
            apiBaseInput.classList.add('hidden');
            apiBaseInput.value = DEFAULT_API_BASES[selectedProvider] || '';
            
            showStep('config');
        });
    });
    
    if (customApiBaseCheckbox) {
        customApiBaseCheckbox.addEventListener('change', () => {
            if (customApiBaseCheckbox.checked) {
                apiBaseInput.classList.remove('hidden');
                apiBaseInput.focus();
            } else {
                apiBaseInput.classList.add('hidden');
                apiBaseInput.value = DEFAULT_API_BASES[selectedProvider] || '';
            }
        });
    }
    
    if (btnSaveAi) {
        btnSaveAi.addEventListener('click', () => {
            const name = document.getElementById('add-ai-name').value.trim();
            let apiBase = apiBaseInput.value.trim();
            
            if (!name) {
                vscode.postMessage({
                    type: 'showError',
                    message: 'Please enter a Display Name.'
                });
                return;
            }
            
            // Default apiBase if custom is unchecked
            if (!customApiBaseCheckbox.checked) {
                apiBase = DEFAULT_API_BASES[selectedProvider] || '';
            }
            
            if (!apiBase) {
                vscode.postMessage({
                    type: 'showError',
                    message: 'Please enter an API Base URL.'
                });
                return;
            }
            
            // Gather all API Keys
            const keyInputs = apiKeysContainer.querySelectorAll('.dynamic-input-field');
            const keysList = [];
            keyInputs.forEach(inp => {
                const val = inp.value.trim();
                if (val) keysList.push(val);
            });

            // Gather all Model Names
            const modelInputs = modelsContainer.querySelectorAll('.dynamic-input-field');
            const modelsList = [];
            modelInputs.forEach(inp => {
                const val = inp.value.trim();
                if (val) modelsList.push(val);
            });

            // Parse keys: if empty, set empty string. If 1 item, single string. If multiple, array.
            let apiKeys;
            if (keysList.length === 0) {
                apiKeys = '';
            } else if (keysList.length === 1) {
                apiKeys = keysList[0];
            } else {
                apiKeys = keysList;
            }

            // Parse models: if empty, set "Autodetect". If 1 item, single string. If multiple, array.
            let models;
            if (modelsList.length === 0) {
                models = 'Autodetect';
            } else if (modelsList.length === 1) {
                models = modelsList[0];
            } else {
                models = modelsList;
            }
            
            // Send config to extension host
            vscode.postMessage({
                type: 'addAIProvider',
                configIndex: editingConfigIndex,
                config: {
                    name: name,
                    provider: selectedProvider,
                    model: models,
                    apiBase: apiBase,
                    apiKey: apiKeys
                }
            });
            
            // Hide drawer
            addAiDrawer.classList.add('hidden');
        });
    }

    const noModelsAddBtn = document.getElementById('no-models-add-btn');
    if (noModelsAddBtn) {
        noModelsAddBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddAiDrawer();
        });
    }

    // Notify extension host that webview is ready to load configuration
    vscode.postMessage({ type: 'webviewReady' });
}());
