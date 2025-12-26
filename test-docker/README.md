# Docker Internal Network Test for Blinko AI Provider

This directory contains test files to verify that the AI provider model fetching works correctly through Docker internal networks.

## Problem Solved

Previously, the `fetchProviderModels` function made HTTP requests directly from the browser, which meant Docker internal hostnames (like `http://ollama:11434`) were not accessible.

This fix moves the model fetching logic to the backend server, allowing containers to communicate through Docker's internal network.

## Test Setup

### 1. Start the test environment

```bash
cd test-docker
docker-compose -f docker-compose.test.yml up -d
```

### 2. Wait for services to be ready

```bash
docker-compose -f docker-compose.test.yml ps
```

All services should show as "healthy".

### 3. Access Blinko

Open http://localhost:1111 in your browser.

### 4. Test the fix

1. Go to Settings > AI Settings
2. Add a new Provider:
   - Provider Type: `OpenAI` or `Custom`
   - Base URL: `http://mock-openai:8080/v1`
   - API Key: `test-key` (any value works for the mock)
3. Click "Fetch Models" button
4. **Expected Result**: You should see 3 models listed:
   - gpt-4o
   - gpt-4o-mini
   - gpt-3.5-turbo

### 5. Verify in logs

```bash
docker logs mock-openai
```

You should see requests like:
```
2024-XX-XX... - GET /v1/models
Returning model list...
```

This confirms the request came from the Blinko container (server-side), not from the browser.

## Cleanup

```bash
docker-compose -f docker-compose.test.yml down -v
```
