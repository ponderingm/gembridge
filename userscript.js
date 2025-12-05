// ==UserScript==
// @name         Gemini Bridge
// @namespace    http://tampermonkey.net/
// @version      1.2
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
    statusDiv.innerText = 'GemBridge v1.2: Initializing...';
    document.body.appendChild(statusDiv);

    function updateStatus(msg) {
        statusDiv.innerText = `GemBridge: ${msg} `;
        console.log(`[GemBridge] ${msg} `);
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
            data: JSON.stringify({ message: message, stack_trace: stack }),
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
    if (pendingJobJson) {
        const job = JSON.parse(pendingJobJson);
        updateStatus(`Resuming Job ${job.id} after navigation...`);
        // Clear immediately to prevent loops if it crashes
        localStorage.removeItem('gembridge_pending_job');
        processJob(job);
    } else {
        // Start polling if no pending job
        setInterval(pollJob, POLL_INTERVAL);
    }

    function pollJob() {
        updateStatus('Polling...');
        GM_xmlhttpRequest({
            method: "GET",
            url: `${API_BASE}/job`,
            onload: function (response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.status === 'processing') {
                        updateStatus(`Job received: ${data.id}. Navigating to new chat...`);
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
                updateStatus(`Polling connection error: ${JSON.stringify(err)}`);
            }
        });
    }

    async function processJob(job) {
        try {
            updateStatus(`Processing Job ${job.id}...`);

            // 1. Input Prompt
            // Helper to wait for element
            const waitForElement = (selectors, timeout = 20000) => { // 20s timeout
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

            const inputSelectors = [
                'div[contenteditable="true"]',
                'rich-textarea > div',
                '#prompt-textarea',
                'div[data-placeholder="Enter a prompt here"]',
                'div[aria-label="Enter a prompt here"]'
            ];

            updateStatus("Waiting for input area...");
            const inputArea = await waitForElement(inputSelectors);
            if (!inputArea) throw new Error("Input area not found");

            inputArea.focus();
            document.execCommand('insertText', false, job.prompt);

            // Wait a bit for UI update
            await new Promise(r => setTimeout(r, 1000));

            // 2. Click Send
            const sendButton = document.querySelector('button[aria-label*="Send"], button[aria-label*="送信"]');
            if (!sendButton) throw new Error("Send button not found");
            sendButton.click();

            updateStatus("Prompt sent, waiting for generation...");

            // 3. Wait for Image
            // Strategy: Wait for a new <img> element to appear that is significantly large (not an icon)
            const waitForGeneratedImage = (timeout = 90000) => { // 90s timeout
                return new Promise((resolve, reject) => {
                    const startTime = Date.now();
                    const initialImgCount = document.querySelectorAll('img').length;

                    const check = () => {
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
            updateStatus("Image detected! Downloading...");
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
            updateStatus("Image downloaded. Uploading to API...");

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
                    updateStatus(`Job ${job.id} Completed! Result uploaded.`);
                    log(`Upload success: ${response.responseText}`);
                    // Resume polling after success
                    setInterval(pollJob, POLL_INTERVAL);
                },
                onerror: function (err) {
                    reportError(`Failed to upload image: ${JSON.stringify(err)}`);
                    // Resume polling even on error
                    setInterval(pollJob, POLL_INTERVAL);
                }
            });

        } catch (e) {
            reportError(`Job processing failed: ${e.message}`, e.stack);
            // Resume polling on error
            setInterval(pollJob, POLL_INTERVAL);
        }
    }

})();
