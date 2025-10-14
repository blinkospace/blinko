import { observer } from 'mobx-react-lite';
import { Button, Input, Select, SelectItem, Card, CardBody, Chip, Textarea } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { AuthenticationConfig } from '@/store/aiSettingStore';

interface AuthenticationConfigProps {
  authConfig?: AuthenticationConfig;
  onAuthConfigChange: (config: AuthenticationConfig) => void;
  provider?: string;
}

// Default authentication configurations for common providers
const DEFAULT_AUTH_CONFIGS: { [key: string]: AuthenticationConfig } = {
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
  zhipuai: {
    type: 'bearer',
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

export default observer(function AuthenticationConfig({
  authConfig,
  onAuthConfigChange,
  provider = 'custom'
}: AuthenticationConfigProps) {
  const { t } = useTranslation();
  const [localConfig, setLocalConfig] = useState<AuthenticationConfig>(() => {
    if (authConfig) {
      return authConfig;
    }

    // Use default config for the provider type
    return DEFAULT_AUTH_CONFIGS[provider] || DEFAULT_AUTH_CONFIGS.custom;
  });

  const [customHeaders, setCustomHeaders] = useState<{ [key: string]: string }>(
    authConfig?.customHeaders || {}
  );
  const [customHeaderKey, setCustomHeaderKey] = useState('');
  const [customHeaderValue, setCustomHeaderValue] = useState('');

  useEffect(() => {
    if (authConfig) {
      setLocalConfig(authConfig);
      setCustomHeaders(authConfig.customHeaders || {});
    } else {
      const defaultConfig = DEFAULT_AUTH_CONFIGS[provider] || DEFAULT_AUTH_CONFIGS.custom;
      setLocalConfig(defaultConfig);
      setCustomHeaders(defaultConfig.customHeaders || {});
    }
  }, [authConfig, provider]);

  const updateConfig = (updates: Partial<AuthenticationConfig>) => {
    const newConfig = { ...localConfig, ...updates };
    setLocalConfig(newConfig);
    onAuthConfigChange(newConfig);
  };

  const addCustomHeader = () => {
    if (customHeaderKey.trim() && customHeaderValue.trim()) {
      const newHeaders = { ...customHeaders, [customHeaderKey.trim()]: customHeaderValue.trim() };
      setCustomHeaders(newHeaders);
      updateConfig({ customHeaders: newHeaders });
      setCustomHeaderKey('');
      setCustomHeaderValue('');
    }
  };

  const removeCustomHeader = (key: string) => {
    const newHeaders = { ...customHeaders };
    delete newHeaders[key];
    setCustomHeaders(newHeaders);
    updateConfig({ customHeaders: newHeaders });
  };

  const renderBearerConfig = () => (
    <div className="space-y-4">
      <Input
        label={t('api-key')}
        placeholder={t('enter-your-api-key')}
        type="password"
        value={localConfig.apiKey || ''}
        onValueChange={(value) => updateConfig({ apiKey: value })}
      />

      <Input
        label={t('header-name')}
        placeholder="Authorization"
        value={localConfig.headerName || ''}
        onValueChange={(value) => updateConfig({ headerName: value })}
        description={t('bearer-token-header-description')}
      />
    </div>
  );

  const renderApiKeyConfig = () => (
    <div className="space-y-4">
      <Input
        label={t('api-key')}
        placeholder={t('enter-your-api-key')}
        type="password"
        value={localConfig.apiKey || ''}
        onValueChange={(value) => updateConfig({ apiKey: value })}
      />

      <Input
        label={t('header-name')}
        placeholder={t('header-name-placeholder')}
        value={localConfig.headerName || ''}
        onValueChange={(value) => updateConfig({ headerName: value })}
        description={t('api-key-header-description')}
      />
    </div>
  );

  const renderCustomConfig = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('custom-headers')}</label>
        <div className="space-y-2">
          {Object.entries(customHeaders).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <Chip size="sm" variant="flat" className="min-w-[100px]">
                {key}
              </Chip>
              <Input
                size="sm"
                value={value}
                onValueChange={(newValue) => {
                  const newHeaders = { ...customHeaders, [key]: newValue };
                  setCustomHeaders(newHeaders);
                  updateConfig({ customHeaders: newHeaders });
                }}
                className="flex-1"
              />
              <Button
                size="sm"
                isIconOnly
                variant="light"
                color="danger"
                onPress={() => removeCustomHeader(key)}
              >
                <Icon icon="hugeicons:delete-02" width="16" height="16" />
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <Input
              size="sm"
              placeholder={t('header-name')}
              value={customHeaderKey}
              onValueChange={setCustomHeaderKey}
              className="flex-1"
            />
            <Input
              size="sm"
              placeholder={t('header-value')}
              value={customHeaderValue}
              onValueChange={setCustomHeaderValue}
              className="flex-1"
            />
            <Button
              size="sm"
              isIconOnly
              color="primary"
              onPress={addCustomHeader}
              isDisabled={!customHeaderKey.trim() || !customHeaderValue.trim()}
            >
              <Icon icon="hugeicons:plus" width="16" height="16" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-default-500">
          {t('custom-headers-description')}
        </p>
      </div>

      <div className="border-t pt-4">
        <label className="text-sm font-medium mb-2 block">{t('example-configurations')}</label>
        <div className="space-y-2">
          <Button
            size="sm"
            variant="flat"
            className="justify-start"
            onPress={() => {
              const zhipuConfig = {
                type: 'bearer' as const,
                apiKey: localConfig.apiKey,
                headerName: 'Authorization',
                customHeaders: {
                  'Authorization': `Bearer ${localConfig.apiKey || 'your-token-here'}`
                }
              };
              updateConfig(zhipuConfig);
              setCustomHeaders(zhipuConfig.customHeaders);
            }}
          >
            <div className="text-left">
              <div className="font-medium text-xs">Zhipu AI (智谱AI)</div>
              <div className="text-xs text-default-500">Authorization: Bearer &lt;token&gt;</div>
            </div>
          </Button>

          <Button
            size="sm"
            variant="flat"
            className="justify-start"
            onPress={() => {
              const moonshotConfig = {
                type: 'api-key' as const,
                apiKey: localConfig.apiKey,
                headerName: 'Authorization',
                customHeaders: {
                  'Authorization': `Bearer ${localConfig.apiKey || 'your-key-here'}`
                }
              };
              updateConfig(moonshotConfig);
              setCustomHeaders(moonshotConfig.customHeaders);
            }}
          >
            <div className="text-left">
              <div className="font-medium text-xs">Moonshot AI (月之暗面)</div>
              <div className="text-xs text-default-500">Authorization: Bearer &lt;key&gt;</div>
            </div>
          </Button>
        </div>
      </div>
    </div>
  );

  const renderNoneConfig = () => (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-success-100 flex items-center justify-center">
              <Icon icon="hugeicons:shield-check" width="20" height="20" className="text-success" />
            </div>
            <div>
              <h4 className="font-medium text-sm">{t('no-authentication-required')}</h4>
              <p className="text-xs text-default-500">{t('no-auth-description')}</p>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">{t('authentication-type')}</label>
        <Select
          selectedKeys={[localConfig.type]}
          onSelectionChange={(keys) => {
            const authType = Array.from(keys)[0] as AuthenticationConfig['type'];
            const defaultConfig = { ...DEFAULT_AUTH_CONFIGS[authType] };

            // Preserve existing API key when switching types
            if (localConfig.apiKey) {
              defaultConfig.apiKey = localConfig.apiKey;
            }

            setLocalConfig(defaultConfig);
            setCustomHeaders(defaultConfig.customHeaders || {});
            onAuthConfigChange(defaultConfig);
          }}
        >
          <SelectItem key="bearer" value="bearer">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:key-01" width="16" height="16" />
              <div>
                <div className="font-medium">Bearer Token</div>
                <div className="text-xs text-default-500">Authorization: Bearer &lt;token&gt;</div>
              </div>
            </div>
          </SelectItem>
          <SelectItem key="api-key" value="api-key">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:shield-security" width="16" height="16" />
              <div>
                <div className="font-medium">API Key</div>
                <div className="text-xs text-default-500">Custom header with API key</div>
              </div>
            </div>
          </SelectItem>
          <SelectItem key="custom" value="custom">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:settings-03" width="16" height="16" />
              <div>
                <div className="font-medium">Custom Headers</div>
                <div className="text-xs text-default-500">Full control over headers</div>
              </div>
            </div>
          </SelectItem>
          <SelectItem key="none" value="none">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:shield-check" width="16" height="16" />
              <div>
                <div className="font-medium">No Authentication</div>
                <div className="text-xs text-default-500">Public endpoints</div>
              </div>
            </div>
          </SelectItem>
        </Select>
      </div>

      {localConfig.type === 'bearer' && renderBearerConfig()}
      {localConfig.type === 'api-key' && renderApiKeyConfig()}
      {localConfig.type === 'custom' && renderCustomConfig()}
      {localConfig.type === 'none' && renderNoneConfig()}
    </div>
  );
});