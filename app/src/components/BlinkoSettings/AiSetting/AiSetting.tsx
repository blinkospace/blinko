import { observer } from 'mobx-react-lite';
import { Button, Select, SelectItem, Input } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { CollapsibleCard } from '../../Common/CollapsibleCard';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { RootStore } from '@/store';
import { DialogStore } from '@/store/module/Dialog';
import { BlinkoStore } from '@/store/blinkoStore';
import { UserStore } from '@/store/user';
import ProviderCard from './ProviderCard';
import ProviderDialogContent from './ProviderDialogContent';
import { DefaultModelsSection } from './DefaultModelsSection';
import { GlobalPromptSection } from './GlobalPromptSection';
import { AiPostProcessingSection } from './AiPostProcessingSection';
import { AiToolsSection } from './AiToolsSection';
import { EmbeddingSettingsSection } from './EmbeddingSettingsSection';
import ModelDialogContent from './ModelDialogContent';
import { McpServersSection } from './McpServersSection';
import { AiSettingStore } from '@/store/aiSettingStore';
import { Copy } from '../../Common/Copy';
import { MarkdownRender } from '../../Common/MarkdownRender';
import { getBlinkoEndpoint } from '@/lib/blinkoEndpoint';


export default observer(function AiSetting() {
  const { t } = useTranslation();
  const aiStore = RootStore.Get(AiSettingStore);
  const blinko = RootStore.Get(BlinkoStore);
  const user = RootStore.Get(UserStore);

  useEffect(() => {
    blinko.config.call();
    aiStore.aiProviders.call();
  }, []);

  return (
    <div className='flex flex-col gap-4'>
      <CollapsibleCard icon="hugeicons:ai-magic" title="AI Providers & Models">
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <Button
              size='md'
              className='ml-auto'
              color="primary"
              startContent={<Icon icon="iconamoon:cloud-add-light" width="20" height="20" />}
              onPress={() => {
                RootStore.Get(DialogStore).setData({
                  isOpen: true,
                  size: '2xl',
                  title: 'Add Provider',
                  content: <ProviderDialogContent />,
                });
              }}
            >
              {t('add-provider')}
            </Button>
          </div>

          {aiStore.aiProviders.value?.map(provider => (
            <ProviderCard key={provider.id} provider={provider as any} />
          ))}
        </div>
      </CollapsibleCard>

      <DefaultModelsSection />

      <EmbeddingSettingsSection />


      <GlobalPromptSection />

      <AiPostProcessingSection />

      <AiToolsSection />

      <McpServersSection />

      <CollapsibleCard icon="hugeicons:api" title="MCP Integration">
        <div className="space-y-4">
          <div className="text-sm text-default-600 mb-4">
            {t('mcp-integration-desc', 'Model Context Protocol (MCP) integration allows AI assistants to connect to Blinko and use its tools.')}
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-default-700">Endpoint URL</label>
              <Input
                value={`${getBlinkoEndpoint() ?? window.location.origin}sse`}
                readOnly
                className="mt-1"
                endContent={<Copy size={20} content={`${getBlinkoEndpoint() ?? window.location.origin}sse`} />}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-default-700">Authorization Token</label>
              <Input
                value={user.userInfo.value?.token || ''}
                readOnly
                type="password"
                className="mt-1"
                endContent={<Copy size={20} content={user.userInfo.value?.token ?? ''} />}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-default-700 mb-2 block">MCP Client Configuration</label>
              <div className="relative">
                <Copy size={20} content={`{
  "mcpServers": {
    "blinko": {
      "url": "${getBlinkoEndpoint() ?? window.location.origin}sse",
      "headers": {
        "Authorization": "Bearer ${user.userInfo.value?.token || ''}"
      }
    }
  }
}`} className="absolute top-4 right-2 z-10" />
                <MarkdownRender content={`\`\`\`json
{
  "mcpServers": {
    "blinko": {
      "url": "${getBlinkoEndpoint() ?? window.location.origin}sse",
      "headers": {
        "Authorization": "Bearer ${user.userInfo.value?.token || ''}"
      }
    }
  }
}
\`\`\``} />
              </div>
            </div>
          </div>
        </div>
      </CollapsibleCard>
    </div>
  );
});