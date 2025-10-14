/**
 * Authentication configuration types for AI providers
 * Supports multiple authentication methods including Bearer tokens, API keys, custom headers, and no authentication
 */

export type AuthenticationType = 'bearer' | 'api-key' | 'custom' | 'none';

export interface AuthenticationConfig {
  /** Type of authentication to use */
  type: AuthenticationType;

  /** API key value (used for bearer and api-key types) */
  apiKey?: string;

  /** Custom header name for api-key type (e.g., 'X-API-Key', 'api-key', 'Authorization') */
  headerName?: string;

  /** Custom headers object for custom authentication type */
  customHeaders?: { [key: string]: string };

  /** Additional configuration options */
  options?: {
    /** Whether to include content-type header */
    includeContentType?: boolean;
    /** Custom user agent */
    userAgent?: string;
    /** Additional query parameters */
    queryParams?: { [key: string]: string };
  };
}

export interface EnhancedProviderConfig {
  /** Enhanced authentication configuration */
  auth?: AuthenticationConfig;

  /** Timeout configuration in milliseconds */
  timeout?: number;

  /** Retry configuration */
  retry?: {
    attempts: number;
    delay: number;
  };

  /** Provider-specific configuration */
  providerConfig?: any;
}

/**
 * Default authentication configurations for common providers
 */
export const DEFAULT_AUTH_CONFIGS: { [key: string]: AuthenticationConfig } = {
  openai: {
    type: 'bearer',
    headerName: 'Authorization'
  },
  anthropic: {
    type: 'api-key',
    headerName: 'x-api-key'
  },
  azure: {
    type: 'api-key',
    headerName: 'api-key'
  },
  google: {
    type: 'api-key',
    headerName: 'x-goog-api-key'
  },
  voyageai: {
    type: 'api-key',
    headerName: 'Authorization'
  },
  ollama: {
    type: 'none'
  },
  custom: {
    type: 'bearer',
    headerName: 'Authorization'
  }
};

/**
 * Validates authentication configuration
 */
export function validateAuthConfig(config: AuthenticationConfig): boolean {
  if (!config || !config.type) {
    return false;
  }

  switch (config.type) {
    case 'bearer':
    case 'api-key':
      return !!config.apiKey;
    case 'custom':
      return config.customHeaders && Object.keys(config.customHeaders).length > 0;
    case 'none':
      return true;
    default:
      return false;
  }
}

/**
 * Builds headers object from authentication configuration
 */
export function buildAuthHeaders(config: AuthenticationConfig): { [key: string]: string } {
  const headers: { [key: string]: string } = {};

  if (!config || config.type === 'none') {
    return headers;
  }

  switch (config.type) {
    case 'bearer':
      if (config.apiKey) {
        const headerName = config.headerName || 'Authorization';
        headers[headerName] = `Bearer ${config.apiKey}`;
      }
      break;

    case 'api-key':
      if (config.apiKey && config.headerName) {
        headers[config.headerName] = config.apiKey;
      }
      break;

    case 'custom':
      if (config.customHeaders) {
        Object.assign(headers, config.customHeaders);
      }
      break;
  }

  // Add content-type if specified
  if (config.options?.includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  // Add user agent if specified
  if (config.options?.userAgent) {
    headers['User-Agent'] = config.options.userAgent;
  }

  return headers;
}