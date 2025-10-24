# Enhanced Authentication System for AI Providers

This document describes the enhanced authentication system implemented in Blinko to support flexible authentication methods for custom AI providers, including embedding models.

## Overview

The enhanced authentication system allows users to configure custom AI providers with various authentication methods, addressing the limitations of the previous system that only supported basic API key authentication.

## Supported Authentication Types

### 1. Bearer Token Authentication
- **Type**: `bearer`
- **Format**: `Authorization: Bearer <token>`
- **Use Case**: Standard OAuth2/JWT tokens
- **Example**: OpenAI, Anthropic Claude, Zhipu AI

### 2. API Key Authentication
- **Type**: `api-key`
- **Format**: Custom header with API key
- **Use Case**: Providers using non-standard header names
- **Examples**:
  - `X-API-Key: <key>`
  - `api-key: <key>`
  - `Authorization: <key>`

### 3. Custom Headers
- **Type**: `custom`
- **Format**: Full control over HTTP headers
- **Use Case**: Complex authentication requirements
- **Examples**:
  - Multiple headers
  - Custom authentication schemes
  - Special headers for specific providers

### 4. No Authentication
- **Type**: `none`
- **Use Case**: Local or public APIs
- **Example**: Ollama, local development servers

## Configuration Examples

### Zhipu AI (智谱AI) Example
```bash
# Using Bearer Token authentication
curl --request POST \
  --url https://open.bigmodel.cn/api/paas/v4/embeddings \
  --header 'Authorization: Bearer <your-token>' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "embedding-3",
    "input": "你好，今天天气怎么样.",
    "dimensions": 2
  }'
```

**Configuration in Blinko:**
- **Authentication Type**: Bearer Token
- **API Key**: Your Zhipu AI token
- **Header Name**: Authorization (default)
- **Base URL**: `https://open.bigmodel.cn/api/paas/v4`

### Moonshot AI (月之暗面) Example
```bash
# Using Bearer Token authentication
curl --request POST \
  --url https://api.moonshot.cn/v1/embeddings \
  --header 'Authorization: Bearer <your-key>' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "moonshot-embedding",
    "input": "Hello, world!"
  }'
```

**Configuration in Blinko:**
- **Authentication Type**: Bearer Token
- **API Key**: Your Moonshot AI key
- **Header Name**: Authorization (default)
- **Base URL**: `https://api.moonshot.cn/v1`

### Custom Provider with Multiple Headers
Some providers might require multiple headers for authentication:

```bash
curl --request POST \
  --url https://api.example.com/v1/embeddings \
  --header 'X-API-Key: <your-api-key>' \
  --header 'X-Client-ID: <your-client-id>' \
  --header 'Content-Type: application/json' \
  --data '{...}'
```

**Configuration in Blinko:**
- **Authentication Type**: Custom Headers
- **Custom Headers**:
  - `X-API-Key`: Your API key
  - `X-Client-ID`: Your client ID

## Implementation Details

### Backend Changes

1. **Authentication Types** (`/server/aiServer/authTypes.ts`):
   - Defines `AuthenticationConfig` interface
   - Provides helper functions for building headers
   - Includes validation logic

2. **Enhanced Providers**:
   - `EmbeddingProvider`: Supports custom authentication for embedding models
   - `LLMProvider`: Supports custom authentication for language models

3. **API Updates**:
   - Test connection functionality uses enhanced authentication
   - Provider configuration stores auth config in JSON field

### Frontend Changes

1. **Authentication Configuration Component** (`/app/src/components/BlinkoSettings/AiSetting/AuthenticationConfig.tsx`):
   - UI for selecting authentication type
   - Dynamic form fields based on selected type
   - Example configurations for common providers

2. **Enhanced Provider Dialog** (`/app/src/components/BlinkoSettings/AiSetting/ProviderDialogContent.tsx`):
   - Integrated authentication configuration
   - Backward compatibility with legacy API key field

3. **Store Updates** (`/app/src/store/aiSettingStore.tsx`):
   - Enhanced `fetchProviderModels` function
   - Support for flexible authentication when fetching model lists

## Usage Instructions

### Adding a Custom Provider with Enhanced Authentication

1. **Navigate to AI Settings**:
   - Go to Settings → AI Settings
   - Click "Add Provider"

2. **Select Custom Configuration**:
   - Choose "Custom Configuration" option
   - Enter basic provider information (name, base URL)

3. **Configure Authentication**:
   - Scroll to "Enhanced Authentication" section
   - Select appropriate authentication type
   - Fill in required fields:
     - **Bearer Token**: API key and optional header name
     - **API Key**: API key and header name
     - **Custom Headers**: Add multiple headers as needed
     - **No Auth**: No additional configuration needed

4. **Test Connection**:
   - Add a model with the correct capabilities
   - Use "Test Connection" to verify configuration
   - Fetch model list if available

5. **Save Configuration**:
   - Click "Create" to save the provider
   - The provider will be available for use in AI features

### Backward Compatibility

The enhanced authentication system maintains backward compatibility with existing providers:

- Existing providers continue to work with legacy API key configuration
- The system falls back to legacy authentication when enhanced config is not available
- Migration to enhanced authentication is optional but recommended

## Technical Architecture

### Authentication Flow

1. **Configuration Storage**:
   - Authentication config stored in `config.authConfig` field
   - JSON format allows flexible schema evolution

2. **Header Generation**:
   - `buildAuthHeaders()` function creates headers from config
   - Supports all authentication types with proper formatting

3. **Request Interception**:
   - Custom fetch functions inject authentication headers
   - Maintains compatibility with AI SDK requirements

4. **Error Handling**:
   - Graceful fallback to legacy authentication
   - Clear error messages for misconfiguration

### Security Considerations

- API keys and tokens are stored securely in database
- No sensitive information logged in console output
- Custom headers allow for any authentication scheme
- Input validation prevents header injection

## Troubleshooting

### Common Issues and Solutions

1. **Authentication Failed**:
   - Verify API key/token is correct
   - Check header name matches provider requirements
   - Ensure base URL is correct (no trailing slashes)

2. **Model List Fetch Failed**:
   - Check if provider supports `/models` endpoint
   - Verify authentication headers are correct
   - Try manual test with curl command

3. **Test Connection Failed**:
   - Ensure model capabilities match actual provider capabilities
   - Check network connectivity to provider endpoint
   - Review provider documentation for correct format

### Debug Mode

Enable debug logging to see actual HTTP requests:

```typescript
// In provider configuration
{
  "auth": {
    "type": "custom",
    "customHeaders": {
      "Authorization": "Bearer <token>",
      "X-Debug": "true"
    },
    "options": {
      "includeContentType": true
    }
  }
}
```

## Future Enhancements

Planned improvements to the authentication system:

1. **OAuth2 Support**: Full OAuth2 flow implementation
2. **Certificate Authentication**: Support for client certificates
3. **Rate Limiting**: Built-in rate limiting for custom providers
4. **Retry Logic**: Automatic retry with exponential backoff
5. **Authentication Testing**: Dedicated authentication testing endpoint

## Contributing

When adding support for new providers:

1. Add default authentication configuration to `DEFAULT_AUTH_CONFIGS`
2. Update provider templates in frontend constants
3. Add example configurations to documentation
4. Test with actual provider endpoints
5. Update translation files for new UI elements

## Support

For issues related to the enhanced authentication system:

1. Check this documentation first
2. Review provider's API documentation
3. Test configuration with curl commands
4. Enable debug logging for detailed error information
5. Report issues with provider details and configuration