import { observer } from 'mobx-react-lite';
import { Button, Select, SelectItem } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { CollapsibleCard } from '../../Common/CollapsibleCard';
import { ModelIcon, ProviderIcon } from '@/components/BlinkoSettings/AiSetting/AIIcon';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import { AiSettingStore } from '@/store/aiSettingStore';

export const DefaultModelsSection = observer(() => {
  const { t } = useTranslation();
  const aiSettingStore = RootStore.Get(AiSettingStore);
  const blinko = RootStore.Get(BlinkoStore);

  useEffect(() => {
    blinko.config.call();
    aiSettingStore.aiProviders.call();
    aiSettingStore.allModels.call();
  }, []);

  // Also refresh when returning to this component (in case models were created)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        aiSettingStore.allModels.call();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return (
    <CollapsibleCard icon="hugeicons:settings-02" title="Default Models Configuration">
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Main Chat Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:cpu" width="16" height="16" />
              <label className="text-sm font-medium">Main Chat Model</label>
            </div>
            <Select
              classNames={{
                trigger: "h-12",
              }}
              placeholder={'select'}
              selectedKeys={blinko.config.value?.mainModelId ? [String(blinko.config.value.mainModelId)] : []}
              renderValue={(items) => {
                return items.map((item) => {
                  const model = aiSettingStore.inferenceModels.find(m => m.id === Number(item.key));
                  if (!model) return null;
                  return (
                    <div key={item.key} className="flex items-center gap-2">
                      <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                      <div className="flex flex-col">
                        <span className="text-sm">{model.title}</span>
                        <div className="flex items-center gap-1">
                          <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                          <span className="text-xs text-default-500">{model.provider?.title}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              }}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value) {
                  PromiseCall(api.config.update.mutate({
                    key: 'mainModelId',
                    value: Number(value)
                  }), { autoAlert: false }).then(() => {
                    blinko.config.call()
                  });
                }
              }}
            >
              {aiSettingStore.inferenceModels.map(model => (
                <SelectItem key={String(model.id)} textValue={model.title}>
                  <div className="flex gap-2 items-center">
                    <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                    <div className="flex flex-col">
                      <span className="text-sm">{model.title}</span>
                      <div className="flex items-center gap-1">
                        <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                        <span className="text-xs text-default-400">{model.provider?.title}</span>
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Embedding Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:database-01" width="16" height="16" />
              <label className="text-sm font-medium">Embedding Model</label>
            </div>
            <Select
              classNames={{
                trigger: "h-12",
              }}
              placeholder="Select embedding model"
              selectedKeys={blinko.config.value?.embeddingModelId ? [String(blinko.config.value.embeddingModelId)] : []}
              renderValue={(items) => {
                return items.map((item) => {
                  const model = aiSettingStore.embeddingModels.find(m => m.id === Number(item.key));
                  if (!model) return null;
                  return (
                    <div key={item.key} className="flex items-center gap-2">
                      <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                      <div className="flex flex-col">
                        <span className="text-sm">{model.title}</span>
                        <div className="flex items-center gap-1">
                          <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                          <span className="text-xs text-default-500">{model.provider?.title}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              }}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value) {
                  PromiseCall(api.config.update.mutate({
                    key: 'embeddingModelId',
                    value: Number(value)
                  }), { autoAlert: false }).then(() => {
                    blinko.config.call();
                  });
                }
              }}
            >
              {aiSettingStore.embeddingModels.map(model => (
                <SelectItem key={String(model.id)} textValue={model.title}>
                  <div className="flex gap-2 items-center">
                    <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                    <div className="flex flex-col">
                      <span className="text-sm">{model.title}</span>
                      <div className="flex items-center gap-1">
                        <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                        <span className="text-xs text-default-400">{model.provider?.title}</span>
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Voice Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:mic-01" width="16" height="16" />
              <label className="text-sm font-medium">Voice Model</label>
            </div>
            <Select
              classNames={{
                trigger: "h-12",
              }}
              placeholder="Select voice model"
              selectedKeys={blinko.config.value?.voiceModelId ? [String(blinko.config.value.voiceModelId)] : []}
              renderValue={(items) => {
                return items.map((item) => {
                  const model = aiSettingStore.voiceModels.find(m => m.id === Number(item.key));
                  if (!model) return null;
                  return (
                    <div key={item.key} className="flex items-center gap-2">
                      <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                      <div className="flex flex-col">
                        <span className="text-sm">{model.title}</span>
                        <div className="flex items-center gap-1">
                          <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                          <span className="text-xs text-default-500">{model.provider?.title}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              }}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value) {
                  PromiseCall(api.config.update.mutate({
                    key: 'voiceModelId',
                    value: Number(value)
                  }), { autoAlert: false }).then(() => {
                    blinko.config.call();
                  });
                }
              }}
            >
              {aiSettingStore.voiceModels.map(model => (
                <SelectItem key={String(model.id)} textValue={model.title}>
                  <div className="flex gap-2 items-center">
                    <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                    <div className="flex flex-col">
                      <span className="text-sm">{model.title}</span>
                      <div className="flex items-center gap-1">
                        <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                        <span className="text-xs text-default-400">{model.provider?.title}</span>
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Vision Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:view" width="16" height="16" />
              <label className="text-sm font-medium">Vision Model</label>
            </div>
            <Select
              classNames={{
                trigger: "h-12",
              }}
              placeholder="Select vision model"
              selectedKeys={blinko.config.value?.imageModelId ? [String(blinko.config.value.imageModelId)] : []}
              renderValue={(items) => {
                return items.map((item) => {
                  const model = aiSettingStore.imageModels.find(m => m.id === Number(item.key));
                  if (!model) return null;
                  return (
                    <div key={item.key} className="flex items-center gap-2">
                      <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                      <div className="flex flex-col">
                        <span className="text-sm">{model.title}</span>
                        <div className="flex items-center gap-1">
                          <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                          <span className="text-xs text-default-500">{model.provider?.title}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              }}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value) {
                  PromiseCall(api.config.update.mutate({
                    key: 'imageModelId',
                    value: Number(value)
                  }), { autoAlert: false }).then(() => {
                    blinko.config.call();
                  });
                }
              }}
            >
              {aiSettingStore.imageModels.map(model => (
                <SelectItem key={String(model.id)} textValue={model.title}>
                  <div className="flex gap-2 items-center">
                    <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                    <div className="flex flex-col">
                      <span className="text-sm">{model.title}</span>
                      <div className="flex items-center gap-1">
                        <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                        <span className="text-xs text-default-400">{model.provider?.title}</span>
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Real-Time Voice Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon icon="hugeicons:mic-01" width="16" height="16" />
              <label className="text-sm font-medium">Real-Time Voice Model</label>
            </div>
            <Select
              classNames={{
                trigger: "h-12",
              }}
              placeholder="Select real-time voice model"
              selectedKeys={blinko.config.value?.realTimeVoiceModelId ? [String(blinko.config.value.realTimeVoiceModelId)] : []}
              renderValue={(items) => {
                return items.map((item) => {
                  const model = aiSettingStore.realTimeVoiceModels.find(m => m.id === Number(item.key));
                  if (!model) return null;
                  return (
                    <div key={item.key} className="flex items-center gap-2">
                      <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                      <div className="flex flex-col">
                        <span className="text-sm">{model.title}</span>
                        <div className="flex items-center gap-1">
                          <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                          <span className="text-xs text-default-500">{model.provider?.title}</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              }}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0];
                if (value) {
                  PromiseCall(api.config.update.mutate({
                    key: 'realTimeVoiceModelId',
                    value: Number(value)
                  }), { autoAlert: false }).then(() => {
                    blinko.config.call();
                  });
                }
              }}
            >
              {aiSettingStore.realTimeVoiceModels.map(model => (
                <SelectItem key={String(model.id)} textValue={model.title}>
                  <div className="flex gap-2 items-center">
                    <ModelIcon modelName={model.modelKey} className="shrink-0 w-6 h-6" />
                    <div className="flex flex-col">
                      <span className="text-sm">{model.title}</span>
                      <div className="flex items-center gap-1">
                        <ProviderIcon provider={model.provider?.provider || ''} className="shrink-0 w-3 h-3" />
                        <span className="text-xs text-default-400">{model.provider?.title}</span>
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>
      </div>
    </CollapsibleCard>
  );
});