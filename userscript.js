// ==UserScript==
// @name         Gemini Bridge
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automate Gemini image generation via API
// @author       GemBridge
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'http://gemini-api:8000/api'; // Internal Docker network address
    const POLL_INTERVAL = 5000;

    console.log('Gemini Bridge: Started');

    function log(msg) {
        console.log(`[Gemini Bridge] ${msg}`);
    }

    function reportError(message, stack) {
        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE}/error`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ message: message, stack_trace: stack }),
            onload: function (response) {
                log("Error reported to server.");
            }
        });
    }

    function pollJob() {
        GM_xmlhttpRequest({
            method: "GET",
            url: `${API_BASE}/job`,
            onload: function (response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.status === 'processing') {
                        log(`Job received: ${data.id}`);
                        processJob(data);
                    } else {
                        // log('No job, polling...');
                    }
                } catch (e) {
                    log(`Polling error: ${e.message}`);
                }
            },
            onerror: function (err) {
                log(`Polling connection error: ${err}`);
            }
        });
    }

    async function processJob(job) {
        try {
            // 1. Input Prompt
            const inputArea = document.querySelector('div[contenteditable="true"]');
            if (!inputArea) throw new Error("Input area not found");

            inputArea.focus();
            document.execCommand('insertText', false, job.prompt);

            // Wait a bit for UI update
            await new Promise(r => setTimeout(r, 1000));

            // 2. Click Send
            const sendButton = document.querySelector('button[aria-label*="Send"]'); // Selector might need adjustment
            if (!sendButton) throw new Error("Send button not found");
            sendButton.click();

            log("Prompt sent, waiting for generation...");

            // 3. Wait for Image
            // This is tricky. We need to observe the DOM for new images.
            // For simplicity, we'll wait for a fixed time or check periodically.
            // Better approach: MutationObserver or polling for specific image containers.

            // Wait loop
            let attempts = 0;
            const maxAttempts = 60; // 60 seconds
            const checkInterval = 1000;

            const waitForImage = setInterval(() => {
                attempts++;
                // Look for generated images. This selector is hypothetical and needs adjustment based on Gemini's actual DOM.
                // Usually generated images are in a specific container or have specific attributes.
                // For now, let's look for the last added image in the chat history.
                const images = document.querySelectorAll('img');
                // Filter for likely generated images (e.g., large size, specific classes)
                // This part requires manual tuning by the user inspecting the DOM.

                // Placeholder logic: assume the last image added is the result
                // In a real scenario, we might need more robust detection.

                if (attempts > maxAttempts) {
                    clearInterval(waitForImage);
                    reportError(`Timeout waiting for image for job ${job.id}`);
                    return;
                }

                // Check if generation is complete (e.g., stop button disappears, or specific "done" indicator)
                // For this v1, let's assume if we see a new image appearing at the bottom.

                // TODO: Implement robust image detection logic here.
                // For now, we will just log that we are waiting.
                // The user needs to verify the DOM structure.

            }, checkInterval);

        } catch (e) {
            reportError(`Job processing failed: ${e.message}`, e.stack);
        }
    }

    // Start polling
    setInterval(pollJob, POLL_INTERVAL);

})();
