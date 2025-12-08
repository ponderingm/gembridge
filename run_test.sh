#!/bin/bash
export GEMINI_API_PORT=8006
export GEMINI_BROWSER_HTTP_PORT=3015
export GEMINI_BROWSER_HTTPS_PORT=3016
export COMPOSE_PROJECT_NAME=gembridge_test

echo "Starting Test Environment (API Only)..."
echo "API: http://localhost:$GEMINI_API_PORT"

docker compose up -d --build gemini-api
