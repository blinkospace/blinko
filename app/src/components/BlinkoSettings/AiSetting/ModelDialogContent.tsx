import { observer } from 'mobx-react-lite';
import { Button, Input, Select, SelectItem, Autocomplete, AutocompleteItem, Tooltip, Chip } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { RootStore } from '@/store';
import { AiSettingStore, AiModel, ProviderModel } from '@/store/aiSettingStore';
import { DialogStore } from '@/store/module/Dialog';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { CAPABILITY_ICONS, CAPABILITY_LABELS, CAPABILITY_COLORS, DEFAULT_MODEL_TEMPLATES } from './constants';
import { ProviderIcon, ModelIcon } from '@/components/BlinkoSettings/AiSetting/AIIcon';
import { api } from '@/lib/trpc';
import { ModelCapabilities } from '@server/aiServer/types';

// Utility function to format test connection results
const formatTestResults = (result: any, t: (key: string) => string): string => {
  const details: string[] = [];

  if (result?.capabilities?.inference?.success) {
    const response = result.capabilities.inference.response || '';
    details.push(`Chat: ✅ ${response}`);
  }

  if (result?.capabilities?.embedding?.success) {
    const dimensions = result.capabilities.embedding.dimensions || 0;
    details.push(`Embedding: ✅ ${dimensions} dimensions`);
  }

  if (result?.capabilities?.audio?.success) {
    const message = result.capabilities.audio.message || '';
    details.push(`Audio: ✅ ${message}`);
  }

  return `${t('check-connect-success')} - ${details.join(', ')}`;
};

interface ModelDialogContentProps {
  model?: AiModel;
}

export default observer(function ModelDialogContent({ model }: ModelDialogContentProps) {
  const { t } = useTranslation()
  const aiSettingStore = RootStore.Get(AiSettingStore);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  const [editingModel, setEditingModel] = useState<Partial<AiModel>>(() => {
    if (model) {
      return { ...model };
    }
    return {
      id: 0,
      providerId: aiSettingStore.aiProviders.value?.[0]?.id || 0,
      title: '',
      modelKey: '',
      capabilities: {
        inference: true,
        tools: false,
        image: false,
        imageGeneration: false,
        video: false,
        audio: false,
        embedding: false,
        rerank: false,
        realTimeVoice: false
      },
      config: {
        embeddingDimensions: 0
      },
      sortOrder: 0
    };
  });

  const selectedProvider = aiSettingStore.aiProviders.value?.find(p => p.id === editingModel.providerId);

  const getProviderModels = (): ProviderModel[] => {
    if (!selectedProvider) return [];
    return aiSettingStore.getProviderModels(selectedProvider.id);
  };

  const fetchProviderModels = async () => {
    if (!selectedProvider) return;

    try {
      await aiSettingStore.fetchProviderModels.call(selectedProvider as any);
    } catch (error) {
      console.error('Failed to fetch provider models:', error);
    }
  };

  const handleModelSelect = (modelKey: string) => {
    const providerModels = getProviderModels();
    const providerModel = providerModels.find(m => m.id === modelKey);
    const defaultTemplate = DEFAULT_MODEL_TEMPLATES.find(t => modelKey.toLowerCase().includes(t.modelKey.toLowerCase()));

    if (providerModel) {
      // Use provider model data, but enhance with template capabilities if available
      const capabilities = defaultTemplate?.capabilities || aiSettingStore.inferModelCapabilities(modelKey);
      const config = defaultTemplate?.config || {};

      setEditingModel(prev => ({
        ...prev,
        modelKey: providerModel.id,
        title: providerModel.name,
        capabilities: capabilities as ModelCapabilities,
        config: {
          ...prev.config,
          ...config
        }
      }));
    } else {
      // Fallback for manual input
      const capabilities = defaultTemplate?.capabilities || aiSettingStore.inferModelCapabilities(modelKey);
      const title = defaultTemplate?.title || modelKey;
      const config = defaultTemplate?.config || {};

      setEditingModel(prev => ({
        ...prev,
        modelKey,
        title,
        capabilities: capabilities as ModelCapabilities,
        config: {
          ...prev.config,
          ...config
        }
      }));
    }
  };

  const getAllAvailableModels = () => {
    const providerModels = getProviderModels();
    return providerModels.map(m => ({ id: m.id, name: m.name, source: 'provider' as const }));
  };

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!editingModel.providerId) {
      newErrors.providerId = 'Please select a provider';
    }

    if (!editingModel.title?.trim()) {
      newErrors.title = 'Model name is required';
    }

    if (!editingModel.modelKey?.trim()) {
      newErrors.modelKey = 'Model key is required';
    }


    const hasCapabilities = editingModel.capabilities &&
      Object.values(editingModel.capabilities).some(cap => cap === true);
    if (!hasCapabilities) {
      newErrors.capabilities = 'Please select at least one capability';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const testModelConnection = async () => {
    if (!editingModel.modelKey || !selectedProvider || !editingModel.capabilities) return;

    try {
      RootStore.Get(ToastPlugin).promise(
        api.ai.testConnect.mutate({
          providerId: selectedProvider.id,
          modelKey: editingModel.modelKey,
          capabilities: editingModel.capabilities
        }),
        {
          loading: t('loading'),
          success: (result: any) => {
            console.log(result);
            return formatTestResults(result, t);
          },
          error: (error: any) => {
            return `${t('check-connect-error')}: ${error.message}`;
          },
        }
      );
    } catch (error) {
      console.error('Test connection failed:', error);
    }
  };

  const handleSaveModel = async () => {
    if (!editingModel) return;

    if (!validateForm()) {
      return;
    }

    if (editingModel.id) {
      await aiSettingStore.updateModel.call(editingModel as any);
    } else {
      await aiSettingStore.createModel.call(editingModel as any);
    }
    RootStore.Get(DialogStore).close();

  };

  return (
    <div className="space-y-6">
      <Select
        label="Provider"
        placeholder="Select provider"
        selectedKeys={editingModel.providerId ? [String(editingModel.providerId)] : []}
        onSelectionChange={(keys) => {
          const value = Array.from(keys)[0];
          setEditingModel(prev => ({ ...prev, providerId: Number(value) }));
          // Clear error message
          if (errors.providerId) {
            setErrors(prev => ({ ...prev, providerId: '' }));
          }
        }}
        classNames={{
          base: "bg-secondbackground",
          trigger: "bg-secondbackground"
        }}
        isInvalid={!!errors.providerId}
        errorMessage={errors.providerId}
      >
        {(aiSettingStore.aiProviders.value || []).map(provider => (
          <SelectItem
            key={provider.id}
            startContent={<ProviderIcon provider={provider.provider} className="w-4 h-4" />}
          >
            {provider.title}
          </SelectItem>
        ))}
      </Select>

      <Input
        label={t('model-name')}
        placeholder="Enter display name"
        value={editingModel.title || ''}
        onValueChange={(value) => {
          setEditingModel(prev => ({ ...prev, title: value }));
          // Clear error message
          if (errors.title) {
            setErrors(prev => ({ ...prev, title: '' }));
          }
        }}
        classNames={{
          base: "bg-secondbackground",
          inputWrapper: "bg-secondbackground"
        }}
        isInvalid={!!errors.title}
        errorMessage={errors.title}
      />

      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <p className="text-sm font-semibold text-default-600">{t('model-selection')}</p>
          <Button
            size="sm"
            variant="light"
            color="primary"
            startContent={
              aiSettingStore.fetchProviderModels.loading.value ? (
                <Icon icon="line-md:loading-twotone-loop" width="14" height="14" className="animate-spin" />
              ) : (
                <Icon icon="famicons:sync" width="14" height="14" />
              )
            }
            onPress={fetchProviderModels}
            isDisabled={!selectedProvider}
          >
            {t('refresh-model-list')}
          </Button>
        </div>
        <Autocomplete
          label="Model"
          placeholder="Select or enter model"
          inputValue={editingModel.modelKey || ''}
          onInputChange={(value) => {
            // Find matching template for the input value
            const defaultTemplate = DEFAULT_MODEL_TEMPLATES.find(t =>
              value.toLowerCase().includes(t.modelKey.toLowerCase())
            );

            const capabilities = defaultTemplate?.capabilities || aiSettingStore.inferModelCapabilities(value);
            const config = defaultTemplate?.config || {};

            setEditingModel(prev => ({
              ...prev,
              modelKey: value,
              capabilities: capabilities,
              config: config
            }));

            // Clear error message
            if (errors.modelKey) {
              setErrors(prev => ({ ...prev, modelKey: '' }));
            }
          }}
          onSelectionChange={(key) => {
            if (key) {
              handleModelSelect(String(key));
              // Clear error message
              if (errors.modelKey) {
                setErrors(prev => ({ ...prev, modelKey: '' }));
              }
            }
          }}
          allowsCustomValue
          classNames={{
            base: "bg-secondbackground",
            popoverContent: "bg-secondbackground",
            listboxWrapper: "bg-secondbackground"
          }}
          isInvalid={!!errors.modelKey}
          errorMessage={errors.modelKey}
        >
          {getAllAvailableModels().map(model => (
            <AutocompleteItem
              key={model.id}
              startContent={
                <ModelIcon modelName={model.id} className="w-4 h-4" />
              }
            >
              {model.name}
            </AutocompleteItem>
          ))}
        </Autocomplete>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-default-600">{t('model-capabilities')}</p>
          <p className="text-xs text-default-500 mt-1 flex items-center">
            <Icon icon="hugeicons:alert-circle" width="12" height="12" className="inline mr-1 text-warning" />
            <div>{t('model-cap-desc')}</div>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 p-4 bg-default-50 rounded-lg">
          {Object.entries(CAPABILITY_LABELS).map(([key, label]) => {
            const isSelected = editingModel.capabilities?.[key as keyof ModelCapabilities] || false;
            return (
              <Chip
                key={key}
                size="sm"
                startContent={CAPABILITY_ICONS[key as keyof ModelCapabilities]}
                variant={isSelected ? "solid" : "bordered"}
                color={isSelected ? CAPABILITY_COLORS[key as keyof ModelCapabilities] : "default"}
                className={`cursor-pointer transition-all hover:scale-105 ${isSelected ? 'text-white' : 'hover:border-primary'
                  }`}
                onClick={() => {
                  setEditingModel(prev => ({
                    ...prev,
                    capabilities: {
                      ...prev.capabilities,
                      [key]: !isSelected
                    }
                  }));
                  // Clear error message
                  if (errors.capabilities) {
                    setErrors(prev => ({ ...prev, capabilities: '' }));
                  }
                }}
              >
                {label}
              </Chip>
            );
          })}
        </div>
        {errors.capabilities && (
          <p className="text-sm text-danger">{errors.capabilities}</p>
        )}

        {/* Audio capability warning */}
        {editingModel.capabilities?.audio && (
          <div className="mt-2 p-3 bg-warning-50 border border-warning-200 rounded-lg">
            <p className="text-sm text-warning-700">
              <Icon icon="hugeicons:alert-circle" width="14" height="14" className="inline mr-2" />
              Currently only OpenAI-compatible audio models are supported.
            </p>
          </div>
        )}

        {/* Real-time voice capability info */}
        {editingModel.capabilities?.realTimeVoice && (
          <div className="mt-2 p-3 bg-primary-50 border border-primary-200 rounded-lg">
            <p className="text-sm text-primary-700">
              <Icon icon="hugeicons:mic-01" width="14" height="14" className="inline mr-2" />
              Real-time voice transcription requires OpenAI Realtime API with WebRTC support.
              Only OpenAI GPT-4o Realtime models are currently supported.
            </p>
          </div>
        )}
      </div>

      {/* Embedding Dimensions - Only show for embedding models */}
      {editingModel.capabilities?.embedding && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Icon icon="hugeicons:search-list-02" width="16" height="16" />
            <p className="text-sm font-semibold text-default-600">Embedding Dimensions</p>
            <Tooltip content="Specify the dimensions for this embedding model. Leave 0 for auto-detection.">
              <Icon icon="proicons:info" width="14" height="14" />
            </Tooltip>
          </div>
          <Input
            type="number"
            label="Dimensions"
            placeholder="0 (auto-detect)"
            value={String(editingModel.config?.embeddingDimensions || 0)}
            onChange={(e) => {
              const dimensions = parseInt(e.target.value) || 0;
              setEditingModel(prev => ({
                ...prev,
                config: {
                  ...prev.config,
                  embeddingDimensions: dimensions
                }
              }));
            }}
            description="Common values: 384, 512, 768, 1024, 1536, 3072. Set to 0 for auto-detection."
            classNames={{
              base: "bg-secondbackground",
              inputWrapper: "bg-secondbackground"
            }}
          />
        </div>
      )}

      <div className="flex justify-between gap-2 pt-6 border-t border-default-200">
        <Button
          color="primary"
          variant='light'
          startContent={<Icon icon="hugeicons:connect" width="16" height="16" />}
          onPress={testModelConnection}
          isDisabled={!editingModel.modelKey || !selectedProvider}
        >
          {t('test-connection')}
        </Button>
        <div className="flex gap-2">
          <Button variant="flat" onPress={() => RootStore.Get(DialogStore).close()}>
            Cancel
          </Button>
          <Button color="primary" onPress={handleSaveModel}>
            {editingModel.id ? t('update') : t('create')}
          </Button>
        </div>
      </div>
    </div>
  );
});