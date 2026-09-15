import { Icon } from '@/components/Common/Iconify/icons';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { TipsPopover } from '@/components/Common/TipsDialog';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { useTranslation } from 'react-i18next';
import { PromiseState } from '@/store/standard/PromiseState';
import { BlinkoStore } from '@/store/blinkoStore';
import { helper } from '@/lib/helper';
import { FileType } from '../Editor/type';
import { DialogStandaloneStore } from '@/store/module/DialogStandalone';
import { Tooltip } from '@heroui/react';
import { eventBus } from '@/lib/event';
import { getBlinkoEndpoint } from '@/lib/blinkoEndpoint';
import axiosInstance from '@/lib/axios';
import { downloadFromLink } from '@/lib/tauriHelper';
import type { MouseEvent } from 'react';
export const DeleteIcon = observer(({ className, file, files, size = 20, voice = false }: { className: string, file: FileType, files: FileType[], size?: number, voice?: boolean }) => {
  const store = RootStore.Local(() => ({
    deleteFile: new PromiseState({
      function: async (file) => {
        const path = file.uploadPromise?.value;
        if (path) {
          try {
            await axiosInstance.post(getBlinkoEndpoint('/api/file/delete'), { attachment_path: path });
          } catch (error) {
            // A stale draft must still be removable if its upload is already gone.
            if (!voice || (error as any)?.response?.status !== 404) throw error;
          }
        }
        const index = files.indexOf(file)
        if (index >= 0) files.splice(index, 1)
        if (!voice) RootStore.Get(DialogStandaloneStore).close()
        RootStore.Get(ToastPlugin).success(t('delete-success'))
        RootStore.Get(BlinkoStore).removeCreateAttachments(file)
        return true;
      }
    })
  }))

  const { t } = useTranslation()
  return <>
    <TipsPopover keepParentOpen={voice} isLoading={store.deleteFile.loading.value} content={t('this-operation-will-be-delete-resource-are-you-sure')}
      onConfirm={async e => {
        return (await store.deleteFile.call(file)) === true;
      }}>
      <button type="button" aria-label={t('delete')} title={t('delete')} disabled={store.deleteFile.loading.value || file.uploadPromise?.loading?.value}
        onClick={event => event.stopPropagation()}
        className={`cursor-pointer rounded-sm transition-al focus-visible:ring-2 focus-visible:ring-primary ${voice ? 'voice-attachment-remove !bg-transparent p-2' : 'bg-black opacity-70 hover:opacity-100'} ${className}`}>
        {voice ? (
          <span className="flex bg-black rounded-sm pointer-events-none">
            <Icon className='!text-white' icon="basil:cross-solid" width={size} height={size} />
          </span>
        ) : (
          <Icon className='!text-white' icon="basil:cross-solid" width={size} height={size} />
        )}
      </button>
    </TipsPopover >
  </>
})

export const InsertConextButton = observer(({ className, file, files, size = 20 }: { className: string, file: FileType, files: FileType[], size?: number }) => {
  const { t } = useTranslation()
  return <>
    <Tooltip content={t('insert-context')}>
      <div onClick={(e) => {
        e.stopPropagation()
        eventBus.emit('editor:insert', `![${file.name}](${file.preview})`)
      }} className={`opacity-70 hover:opacity-100 bg-black cursor-pointer rounded-sm transition-al ${className}`}>
        <Icon className='!text-white' icon="material-symbols:variable-insert-outline-rounded" width={size} height={size} />
      </div>
    </Tooltip>
  </>
})

export const DownloadIcon = observer(({ className, file, inline = false }: { className?: string, file: FileType, size?: number, inline?: boolean }) => {
  const { t } = useTranslation();
  const download = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    downloadFromLink(getBlinkoEndpoint(file.uploadPromise.value));
  };

  return <Tooltip content={t('download')}>
    <button
      type="button"
      aria-label={t('download')}
      onClick={download}
      className={`${inline ? 'shrink-0' : 'hidden group-hover:block group-focus-within:block absolute z-10 right-[5px] top-[5px]'} p-1 !text-background opacity-70 hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary !bg-foreground cursor-pointer rounded-sm !transition-all ${className || ''}`}
    >
      <Icon aria-hidden="true" icon="tabler:download" width="15" height="15" />
    </button>
  </Tooltip>
})

export const CopyIcon = observer(({ className, file, size = 20 }: { className?: string, file: FileType, size?: number }) => {
  const { t } = useTranslation()

  const copyImageToClipboard = async () => {
    try {
      const src = file.uploadPromise?.value || file.preview;
      if (!src) return;

      // Get the image as a blob
      const response = await axiosInstance.get(getBlinkoEndpoint(src), {
        responseType: 'blob'
      });

      // Convert to canvas and then to PNG format for better clipboard support
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      return new Promise((resolve, reject) => {
        img.onload = async () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx?.drawImage(img, 0, 0);

          canvas.toBlob(async (blob) => {
            if (!blob) {
              reject(new Error('Failed to convert image to blob'));
              return;
            }

            try {
              // Try to write PNG blob to clipboard
              await navigator.clipboard.write([
                new ClipboardItem({
                  'image/png': blob
                })
              ]);

              RootStore.Get(ToastPlugin).success(t('operation-success'));
              resolve(true);
            } catch (clipboardError) {
              console.error('Clipboard write failed, trying fallback:', clipboardError);

              // Fallback: copy image URL as text
              try {
                await navigator.clipboard.writeText(getBlinkoEndpoint(src));
                RootStore.Get(ToastPlugin).success(t('operation-success'));
                resolve(true);
              } catch (textError) {
                console.error('Text fallback also failed:', textError);
                RootStore.Get(ToastPlugin).error(t('operation-failed'));
                reject(textError);
              }
            }
          }, 'image/png');
        };

        img.onerror = () => {
          reject(new Error('Failed to load image'));
        };

        img.src = URL.createObjectURL(response.data);
      });
    } catch (error) {
      console.error('Failed to copy image to clipboard:', error);
      RootStore.Get(ToastPlugin).error(t('operation-failed'));
    }
  };

  return <div className={`hidden p-1 group-hover:block !transition-all absolute z-10 right-[30px] top-[5px] !text-background opacity-70 hover:opacity-100 !bg-foreground cursor-pointer rounded-sm !transition-all ${className}`}>
    <Icon onClick={copyImageToClipboard} icon="si:copy-duotone" width="15" height="15" />
  </div>
})
