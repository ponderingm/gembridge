// ==UserScript==
// @name         Gemini Bridge
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Automate Gemini image generation via API
// @author       GemBridge
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'http://gemini-api:8000/api'; // Internal Docker network address
    const POLL_INTERVAL = 5000;
    let isProcessing = false;

    let currentJobId = null;

    // Status Overlay
    const statusDiv = document.createElement('div');
    statusDiv.style.position = 'fixed';
    statusDiv.style.top = '10px';
    statusDiv.style.right = '10px';
    statusDiv.style.backgroundColor = 'rgba(0,0,0,0.7)';
    statusDiv.style.color = 'white';
    statusDiv.style.padding = '10px';
    statusDiv.style.borderRadius = '5px';
    statusDiv.style.zIndex = '9999';
    statusDiv.style.fontFamily = 'monospace';
    statusDiv.innerText = 'GemBridge v2.0: Initializing...';
    document.body.appendChild(statusDiv);

    function updateStatus(msg, serverStatus = null) {
        statusDiv.innerText = `GemBridge: ${msg} `;
        console.log(`[GemBridge] ${msg} `);

        // Report progress to server if we have an active job and a specific status to report
        if (currentJobId && serverStatus) {
            GM_xmlhttpRequest({
                method: "POST",
                url: `${API_BASE}/progress`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ job_id: currentJobId, status: serverStatus }),
                onload: () => console.log(`[GemBridge] Progress reported: ${serverStatus}`),
                onerror: (err) => console.log(`[GemBridge] Failed to report progress: ${JSON.stringify(err)}`)
            });
        }
    }

    function log(msg) {
        console.log(`[GemBridge] ${msg} `);
    }

    function reportError(message, stack) {
        updateStatus(`Error: ${message} `);
        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE}/error`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                message: message,
                stack_trace: stack,
                url: window.location.href
            }),
            onload: function (response) {
                log("Error reported to server.");
            },
            onerror: function (err) {
                log(`Failed to report error: ${err}`);
            }
        });
    }

    // Check for pending job on load
    const pendingJobJson = localStorage.getItem('gembridge_pending_job');

    // Login Detection
    function checkLoginState() {
        if (window.location.hostname.includes('accounts.google.com')) {
            notifyLoginRequired();
        }
    }

    function notifyLoginRequired() {
        const LAST_NOTIFY_KEY = 'gembridge_last_login_notify';
        const COOLDOWN = 60 * 60 * 1000; // 1 hour

        const lastNotify = localStorage.getItem(LAST_NOTIFY_KEY);
        if (lastNotify && (Date.now() - parseInt(lastNotify)) < COOLDOWN) {
            updateStatus("Login required (Notification suppressed)");
            return;
        }

        reportError("⚠️ **Action Required**\nGoogle Login Required. Please access the browser and sign in.");
        localStorage.setItem(LAST_NOTIFY_KEY, Date.now().toString());
    }

    checkLoginState();

    if (pendingJobJson) {
        const job = JSON.parse(pendingJobJson);
        currentJobId = job.id;
        updateStatus(`Resuming Job ${job.id} after navigation...`, "Navigated");
        // Clear immediately to prevent loops if it crashes
        localStorage.removeItem('gembridge_pending_job');
        isProcessing = true;
        processJob(job).finally(() => {
            isProcessing = false;
            currentJobId = null;
        });
        setTimeout(pollJob, POLL_INTERVAL);
    } else {
        // Start polling if no pending job
        setTimeout(pollJob, POLL_INTERVAL);
    }

    function pollJob() {
        if (!isProcessing) updateStatus('Polling...', null); // Don't spam server on poll
        const busyParam = isProcessing ? '&busy=true' : '';

        GM_xmlhttpRequest({
            method: "GET",
            url: `${API_BASE}/job?t=${Date.now()}${busyParam}`,
            onload: function (response) {
                // Schedule next poll regardless of outcome
                setTimeout(pollJob, POLL_INTERVAL);

                if (isProcessing) return; // Heartbeat only

                try {
                    const data = JSON.parse(response.responseText);
                    if (data.status === 'processing') {
                        currentJobId = data.id;
                        updateStatus(`Job received: ${data.id}. Navigating to new chat...`, "Navigating to New Chat");
                        // Save job and navigate
                        localStorage.setItem('gembridge_pending_job', JSON.stringify(data));
                        window.location.href = 'https://gemini.google.com/app';
                    } else {
                        updateStatus('Idle (No jobs)');
                    }
                } catch (e) {
                    updateStatus(`Polling parse error: ${e.message}`);
                }
            },
            onerror: function (err) {
                if (!isProcessing) updateStatus(`Polling connection error: ${JSON.stringify(err)}`);
                setTimeout(pollJob, POLL_INTERVAL);
            }
        });
    }

    async function processJob(job) {
        try {
            updateStatus(`Processing Job ${job.id} (${job.mode})...`, "Processing Started");

            // Helper to wait for element
            const waitForElement = (selectors, timeout = 60000) => { // 60s timeout
                return new Promise((resolve, reject) => {
                    const startTime = Date.now();
                    const check = () => {
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el) {
                                resolve(el);
                                return;
                            }
                        }
                        if (Date.now() - startTime > timeout) {
                            reject(new Error(`Element not found after ${timeout}ms: ${selectors.join(', ')}`));
                        } else {
                            setTimeout(check, 500);
                        }
                    };
                    check();
                });
            };

            // 0. Mode Selection
            const switchModel = async (targetMode) => {
                // Determine target text based on mode key
                const targetText = targetMode === 'thinking' ? '思考モード' : '高速モード';

                updateStatus(`Checking model mode: target=${targetText}`, "Checking Mode");

                // Selector for the dropdown trigger (current mode display)
                // It usually has an arrow icon or is a button with text
                const dropdownSelectors = [
                    'button[aria-haspopup="menu"]',
                    'mat-select',
                    '[data-test-id="model-selector"]' // Hypothetical, need to search generically
                ];

                // Strategy: Find the button that contains "モード" or match current known modes
                const buttons = Array.from(document.querySelectorAll('button'));
                const modeButton = buttons.find(btn =>
                    btn.innerText.includes('高速モード') ||
                    btn.innerText.includes('思考モード')
                );

                if (!modeButton) {
                    log("Mode selector button not found. Assuming correct mode or UI changed.");
                    return; // Fail safe
                }

                // If current text already matches target (partial match is enough for "思考モード" matching "思考モード (3 Pro...)")
                if (modeButton.innerText.includes(targetText) && targetMode !== 'thinking') {
                    // Simple check: if we want high-speed and it says high-speed, we are good.
                    // But if we want thinking, "思考モード" match is good.
                    // Wait, if we want High Speed and it says "Thinking", we need to switch.
                    log("Already in target mode.");
                    return;
                }

                // Specific Logic:
                // If target is "thinking" and current does NOT have "思考", switch.
                // If target is "high-speed" and current does NOT have "高速", switch.
                const currentIsThinking = modeButton.innerText.includes('思考モード');
                const currentIsHighSpeed = modeButton.innerText.includes('高速モード');

                if (targetMode === 'thinking' && currentIsThinking) return;
                if (targetMode === 'high-speed' && currentIsHighSpeed) return;

                // Open Dropdown
                updateStatus("Switching model...", "Switching Model");
                modeButton.click();
                await new Promise(r => setTimeout(r, 1000)); // Wait for menu

                // Find menu item
                const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"], li[role="menuitem"], span'));
                const targetItem = menuItems.find(item => item.innerText.includes(targetText));

                if (targetItem) {
                    targetItem.click();
                    log(`Clicked ${targetText}`);
                    await new Promise(r => setTimeout(r, 2000)); // Wait for switch
                } else {
                    log(`Target mode item '${targetText}' not found in menu.`);
                    // Try to close menu by clicking background or header?
                    document.body.click();
                }
            };

            if (job.mode) {
                await switchModel(job.mode);
            }

            // 1. Input Prompt

            const inputSelectors = [
                'div[contenteditable="true"]',
                'rich-textarea > div',
                '#prompt-textarea',
                'div[data-placeholder="Enter a prompt here"]',
                'div[aria-label="Enter a prompt here"]'
            ];

            updateStatus("Waiting for input area...", "Waiting for Input Area");
            const inputArea = await waitForElement(inputSelectors);
            if (!inputArea) throw new Error("Input area not found");

            updateStatus("Input area found. Entering prompt...", "Inputting Prompt");
            inputArea.focus();
            document.execCommand('insertText', false, job.prompt);

            // Wait a bit for UI update
            await new Promise(r => setTimeout(r, 1000));

            // 2. Click Send
            const sendButton = document.querySelector('button[aria-label*="Send"], button[aria-label*="送信"]');
            if (!sendButton) throw new Error("Send button not found");
            sendButton.click();

            updateStatus("Prompt sent, waiting for generation...", "Generating Image");

            // 3. Wait for Image
            // Strategy: Wait for a new <img> element to appear that is significantly large (not an icon)
            const waitForGeneratedImage = (timeout = 90000) => { // 90s timeout
                return new Promise((resolve, reject) => {
                    const startTime = Date.now();
                    const initialImgCount = document.querySelectorAll('img').length;

                    const check = () => {
                        // Report that we are still waiting every 5 seconds or so? 
                        // Simplified: Just keep "Generating Image" status.

                        const images = Array.from(document.querySelectorAll('img'));
                        // Filter for likely generated images:
                        // 1. Must be visible
                        // 2. Must be larger than a thumbnail (e.g., > 200px width)
                        // 3. Should appear at the bottom of the chat (last in DOM usually)

                        // Simple heuristic: Take the last image that meets size criteria
                        const candidates = images.filter(img => {
                            return img.width > 200 && img.height > 200 && img.offsetParent !== null;
                        });

                        if (candidates.length > 0) {
                            // Get the very last one
                            const result = candidates[candidates.length - 1];
                            // Ensure it's fully loaded
                            if (result.complete && result.naturalWidth > 0) {
                                resolve(result);
                                return;
                            }
                        }

                        if (Date.now() - startTime > timeout) {
                            reject(new Error("Timeout waiting for image generation"));
                        } else {
                            setTimeout(check, 1000);
                        }
                    };
                    check();
                });
            };

            const generatedImage = await waitForGeneratedImage();
            updateStatus("Image detected! Downloading...", "Downloading Image");
            const imageSrc = generatedImage.src;
            log(`Image Source: ${imageSrc}`);

            // 4. Download Image (using GM_xmlhttpRequest to bypass CORS)
            const downloadImage = (url) => {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: url,
                        responseType: "blob",
                        onload: (response) => resolve(response.response),
                        onerror: (err) => reject(new Error(`Download failed: ${JSON.stringify(err)}`))
                    });
                });
            };

            const imageBlob = await downloadImage(imageSrc);
            updateStatus("Image downloaded. Uploading to API...", "Uploading Result");

            // 5. Upload to API
            const formData = new FormData();
            formData.append("job_id", job.id);
            formData.append("prompt", job.prompt);
            formData.append("image", imageBlob, `job_${job.id}.png`);

            GM_xmlhttpRequest({
                method: "POST",
                url: `${API_BASE}/result`,
                data: formData,
                onload: function (response) {
                    updateStatus(`Job ${job.id} Completed! Result uploaded.`, "Completed");
                    log(`Upload success: ${response.responseText}`);
                },
                onerror: function (err) {
                    reportError(`Failed to upload image: ${JSON.stringify(err)}`);
                }
            });

        } catch (e) {
            reportError(`Job processing failed: ${e.message}`, e.stack);
        }
    }

})();
