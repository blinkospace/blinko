import i18n from '@/lib/i18n'
import { api } from '@/lib/trpc'
import { type ProgressResult } from '@shared/lib/types'
import { RootStore } from '@/store'
import { BlinkoStore } from '@/store/blinkoStore'
import { ToastPlugin } from '@/store/module/Toast/Toast'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@/components/Common/Iconify/icons'
import { Progress } from "@heroui/react"
import { DialogStandaloneStore } from '@/store/module/DialogStandalone'

export const ImportProgress = observer(({ force }: { force: boolean }) => {
  const { t } = useTranslation()
  const blinko = RootStore.Get(BlinkoStore)
  const store = RootStore.Local(() => ({
    progress: 0,
    total: 0,
    message: [] as ProgressResult[],
    status: '',
    isPolling: false,
    pollingInterval: null as NodeJS.Timeout | null,

    get value() {
      const v = Math.round((store.progress / store.total) * 100)
      return isNaN(v) ? 0 : v
    },
    get isSuccess() {
      return store.status === 'success'
    },
    get isError() {
      return store.status === 'error'
    },

    startPolling() {
      if (store.isPolling) return;

      store.isPolling = true;
      store.fetchProgress();

      store.pollingInterval = setInterval(() => {
        store.fetchProgress();
      }, 2000);
    },

    stopPolling() {
      if (store.pollingInterval) {
        clearInterval(store.pollingInterval);
        store.pollingInterval = null;
      }
      store.isPolling = false;
    },

    async fetchProgress() {
      try {
        const result = await api.ai.rebuildEmbeddingProgress.query();
        if (result) {
          store.progress = result.current || 0;
          store.total = result.total || 0;

          if (!result.isRunning && store.progress > 0) {
            store.status = 'success';
            store.stopPolling();
          } else if (result.isRunning) {
            store.status = 'running';
          }

          if (result.results && result.results.length > 0) {
            const newMessages = result.results.map((item: any) => ({
              type: item.type as any,
              content: item.content,
              error: item.error
            }));

            if (store.message.length === 0) {
              store.message = newMessages.reverse();
            } else {
              const existingContents = new Set(store.message.map(m => `${m.type}:${m.content}`));
              const newUniqueMessages = newMessages.filter(
                m => !existingContents.has(`${m.type}:${m.content}`)
              );

              if (newUniqueMessages.length > 0) {
                store.message = [...newUniqueMessages.reverse(), ...store.message];
              }
            }
          }

          blinko.updateTicker++;
        }
      } catch (err) {
        console.error("Error fetching rebuild progress:", err);
        RootStore.Get(ToastPlugin).error(err?.message || "Failed to fetch progress");
      }
    },

    async handleStart() {
      try {
        await api.ai.rebuildEmbeddingStart.mutate({ force });

        store.startPolling();

        store.message.unshift({
          type: 'info',
          content: t('rebuild-started'),
        });

        blinko.updateTicker++;
      } catch (err) {
        RootStore.Get(ToastPlugin).error(err?.message || "Failed to start rebuild task");
      }
    },

    async stopTask() {
      try {
        await api.ai.rebuildEmbeddingStop.mutate();

        const result = await api.ai.rebuildEmbeddingProgress.query();
        if (result) {
          store.progress = result.current || 0;
          store.total = result.total || 0;
          store.status = 'success';
        }

        store.message.unshift({
          type: 'info',
          content: t('rebuild-stopped-by-user'),
        });

        blinko.updateTicker++;
        store.stopPolling();
        RootStore.Get(DialogStandaloneStore).close()
      } catch (err) {
        RootStore.Get(ToastPlugin).error(err?.message || "Failed to stop rebuild task");
      }
    }
  }))

  useEffect(() => {
    store.handleStart();

    return () => {
      store.stopPolling();
    }
  }, []);

  const getStatusIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <Icon icon="mingcute:check-circle-fill" className="text-green-500" width={16} height={16} />;
      case 'error':
        return <Icon icon="mingcute:close-circle-fill" className="text-red-500" width={16} height={16} />;
      case 'skip':
        return <Icon icon="mingcute:refresh-3-line" className="text-yellow-500" width={16} height={16} />;
      case 'info':
        return <Icon icon="mingcute:information-fill" className="text-blue-500" width={16} height={16} />;
      default:
        return <Icon icon="mingcute:dot-fill" className="text-gray-400" width={16} height={16} />;
    }
  };

  return <div className="space-y-4">
    <div className="space-y-4">
      <div className="space-y-3">
        <Progress
          classNames={{
            base: "w-full",
            track: "border border-default",
            indicator: "bg-linear-to-r from-pink-500 to-yellow-500",
            label: "tracking-wider font-medium text-default-600",
            value: "text-foreground/60",
          }}
          label={<span>
            <span className="font-medium">{store.progress}</span> / <span className="font-medium">{store.total}</span> items
          </span>}
          radius="none"
          showValueLabel={true}
          size="sm"
          value={store.value}
        />

        <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
          <span></span>
          <span>
            {store.status === 'running' ? t('processing') :
              store.isSuccess ? t('completed') :
                store.isError ? t('error') : ''}
          </span>
        </div>
      </div>

      <div className="flex justify-end items-center">{/* 移除了 justify-between，只保留右对齐 */}

        {store.status === 'running' && (
          <button
            onClick={store.stopTask}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 dark:bg-red-950/50 dark:hover:bg-red-950/70 text-red-600 dark:text-red-400 rounded-md transition-all duration-200 text-sm font-medium"
            title={t('stop-task')}
          >
            <Icon icon="mingcute:stop-circle-fill" width={16} height={16} />
            {t('stop-task')}
          </button>
        )}

        {store.isSuccess && (
          <div className="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-950/50 text-green-600 dark:text-green-400 rounded-full text-sm font-medium">
            <Icon icon="mingcute:check-circle-fill" width={16} height={16} />
            {t('completed')}
          </div>
        )}

        {store.isError && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 rounded-full text-sm font-medium">
            <Icon icon="mingcute:close-circle-fill" width={16} height={16} />
            {t('error')}
          </div>
        )}
      </div>
    </div>

    <div className='flex flex-col max-h-[400px] overflow-y-auto mt-4 space-y-2 pr-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600 scrollbar-track-transparent'>
      {store.message.map((item, index) => (
        <div key={index} className={`flex gap-3 p-4 rounded-lg items-start transition-all duration-200 ${item.type === 'error' ? 'bg-red-50 dark:bg-red-950/20' :
            item.type === 'success' ? 'bg-green-50 dark:bg-green-950/20' :
              item.type === 'info' ? 'bg-blue-50 dark:bg-blue-950/20' :
                'bg-gray-50 dark:bg-gray-800/50'
          }`}>
          <div className="flex-shrink-0 mt-0.5">
            {getStatusIcon(item.type)}
          </div>
          <div className='flex flex-col flex-1 min-w-0'>
            <div className={`text-sm font-medium ${item.type === 'error' ? 'text-red-700 dark:text-red-300' :
                item.type === 'success' ? 'text-green-700 dark:text-green-300' :
                  item.type === 'info' ? 'text-blue-700 dark:text-blue-300' :
                    'text-gray-700 dark:text-gray-300'
              }`}>
              {item?.content}
            </div>
            {item.error as unknown as string && (
              <div className="mt-2 p-3 bg-red-100 dark:bg-red-900/30 rounded-lg text-xs text-red-600 dark:text-red-400">
                <div className="font-medium mb-1">{t('error-details')}:</div>
                <div className="break-words">{String(item.error as unknown as string)}</div>
              </div>
            )}
          </div>
        </div>
      ))}

      {store.message.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-gray-400">
          <Icon icon="line-md:loading-twotone-loop" width={32} height={32} className="mb-2" />
          <div>{t('loading')}...</div>
        </div>
      )}
    </div>
  </div>
})

export const ShowRebuildEmbeddingProgressDialog = async (force = false) => {
  RootStore.Get(DialogStandaloneStore).setData({
    title: i18n.t('rebuilding-embedding-progress'),
    content: <ImportProgress force={force} />,
    isOpen: true,
    size: 'lg',
  })
}