// ==UserScript==
// @name         Gemini Bridge
// @namespace    http://tampermonkey.net/
// @version      2.2.0
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
    statusDiv.innerText = 'GemBridge v2.2.0: Initializing...';
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

    function reportError(message, stack, jobId = null) {
        updateStatus(`Error: ${message} `);
        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE}/error`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                message: message,
                stack_trace: stack,
                url: window.location.href,
                job_id: jobId
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

                // Normalize text helper
                const cleanText = (text) => (text || "").replace(/\s+/g, "").trim();
                const cleanTarget = cleanText(targetText);

                // Candidates: Prioritize aria-haspopup menus
                const getModeButton = () => {
                    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
                    return candidates.find(el => {
                        if (el.offsetParent === null) return false;
                        const text = cleanText(el.textContent);
                        return text.includes(cleanTarget) || text.includes("高速モード") || text.includes("思考モード");
                    });
                };

                updateStatus("Waiting for mode selector...", "Mode Check");
                let modeButton = null;
                // Wait up to 15 seconds for the button to appear
                for (let i = 0; i < 30; i++) {
                    modeButton = getModeButton();
                    if (modeButton) break;
                    await new Promise(r => setTimeout(r, 500));
                }

                if (!modeButton) {
                    log("Mode selector button NOT found after waiting. Dumping visible buttons for debug:");
                    const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    candidates.slice(0, 10).forEach(b => {
                        if (b.offsetParent) log(`- [${b.tagName}] text='${cleanText(b.textContent)}' aria-label='${b.ariaLabel}'`);
                    });
                    return;
                }

                log(`Found mode button: ${cleanText(modeButton.textContent)}`);

                const currentText = cleanText(modeButton.textContent);
                const currentIsThinking = currentText.includes('思考モード');
                const currentIsHighSpeed = currentText.includes('高速モード');

                if (targetMode === 'thinking' && currentIsThinking) {
                    log("Already in Thinking Mode.");
                    return;
                }
                if (targetMode === 'high-speed' && currentIsHighSpeed) {
                    log("Already in High Speed Mode.");
                    return;
                }

                // Keyboard Simulation Helper
                const simulateKey = (el, key, code) => {
                    const event = new KeyboardEvent('keydown', {
                        key: key,
                        code: code,
                        bubbles: true,
                        cancelable: true
                    });
                    el.dispatchEvent(event);
                };

                // Open Dropdown
                updateStatus("Switching model (Keyboard)...", "Switching Model");
                modeButton.click();
                await new Promise(r => setTimeout(r, 1000)); // Wait for menu

                // Simulating Keyboard Navigation
                // Focus should be on the menu or the button.
                // We try sending ArrowDown to document.activeElement
                log("Starting keyboard navigation...");

                let found = false;
                for (let i = 0; i < 5; i++) { // Try up to 5 steps down
                    simulateKey(document.activeElement, 'ArrowDown', 'ArrowDown');
                    await new Promise(r => setTimeout(r, 200)); // Wait for UI update

                    const activeEl = document.activeElement;
                    const activeText = cleanText(activeEl ? activeEl.textContent : "");
                    log(`Step ${i}: Selected '${activeText}'`);

                    if (activeText.includes(cleanTarget)) {
                        log("Target found! Simulating Click on focused item.");
                        // Enter might not be enough, so we also click the active element which we know is correct.
                        simulateKey(activeEl, 'Enter', 'Enter');
                        activeEl.click();
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    log("Keyboard navigation failed to find target. Trying fallback selector approach...");
                    // Fallback to original click logic
                    const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"], li[role="menuitem"], span, div'));
                    const targetItem = menuItems.find(item => {
                        if (item.offsetParent === null) return false;
                        const text = cleanText(item.textContent);
                        return text.includes(cleanTarget) && item !== modeButton && !item.contains(modeButton);
                    });
                    if (targetItem) {
                        targetItem.click();
                        log("Fallback selection click executed.");
                    } else {
                        log("Fallback target item not found.");
                        document.body.click(); // Close
                    }
                }

                // Wait 1s for UI stability
                await new Promise(r => setTimeout(r, 1000));

                // Verify switch
                updateStatus("Waiting for mode switch to complete...", "Switching...");
                let switched = false;
                for (let i = 0; i < 20; i++) {
                    // ... (verification loop logic remains similar but simplified context)
                    await new Promise(r => setTimeout(r, 500));
                    const btn = getModeButton();
                    if (btn) {
                        const params = cleanText(btn.textContent);
                        const isNowThinking = params.includes('思考モード');
                        const isNowHighSpeed = params.includes('高速モード');
                        if (targetMode === 'thinking' && isNowThinking) { switched = true; break; }
                        if (targetMode === 'high-speed' && isNowHighSpeed) { switched = true; break; }
                    }
                }

                if (!switched) {
                    log("Warning: Mode switch verification timed out.");
                } else {
                    log("Mode switch confirmed.");
                }
            };

            // 1. Image Upload (Paste Simulation)
            const pasteImage = async (base64Data) => {
                if (!base64Data) return;

                updateStatus("Pasting image...", "Uploading Image");
                try {
                    // Convert Base64 to Blob
                    const byteCharacters = atob(base64Data);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: "image/png" }); // Assume PNG for now, or detect
                    const file = new File([blob], "image.png", { type: "image/png" });

                    // Create DataTransfer and ClipboardEvent
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);

                    const pasteEvent = new ClipboardEvent("paste", {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: dataTransfer
                    });

                    // Dispatch to active element (rich text editor)
                    // The editor should be focused after mode switching logic usually focuses it, 
                    // or we might need to re-find it.
                    // Usually the input area is a contenteditable div.
                    const editor = document.querySelector('div[contenteditable="true"]');
                    if (editor) {
                        editor.focus();
                        editor.dispatchEvent(pasteEvent);
                        log("Paste event dispatched.");

                        // Wait for upload to complete (generic wait for now, as UI logic differs)
                        // Gemini usually shows a thumbnail.
                        await new Promise(r => setTimeout(r, 5000));
                    } else {
                        throw new Error("Editor element not found.");
                    }

                } catch (e) {
                    reportError(`Image paste failed: ${e.message}`, e.stack);
                    throw e; // Re-throw to fail job
                }
            };

            // Helper for setting prompt
            const setPrompt = async (promptText) => {
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
                document.execCommand('insertText', false, promptText);
                await new Promise(r => setTimeout(r, 1000)); // Wait a bit for UI update
            };

            // Execute Steps

            // 1. Switch Mode
            if (job.mode) {
                await switchModel(job.mode);
            }

            // 2. Paste Image (if any)
            if (job.image_data) {
                await pasteImage(job.image_data);
            }

            // 3. Input Prompt
            await setPrompt(job.prompt || "Generate Image"); // Use safe default if prompt is missing

            // 4. Click Send
            const sendButton = document.querySelector('button[aria-label*="Send"], button[aria-label*="送信"]');
            if (!sendButton) throw new Error("Send button not found");
            sendButton.click();

            updateStatus("Prompt sent, waiting for generation...", "Generating Image");

            // 5. Wait for Image
            // Strategy: Wait for a new <img> element to appear that is significantly large (not an icon)
            const waitForGeneratedImage = (timeout = 90000) => { // 90s timeout
                return new Promise((resolve, reject) => {
                    const startTime = Date.now();
                    const initialImgCount = document.querySelectorAll('img').length;

                    const check = () => {
                        const images = Array.from(document.querySelectorAll('img'));
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
            reportError(`Job processing failed: ${e.message}`, e.stack, job.id);
        }
    }


})();
