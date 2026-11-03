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
export const DeleteIcon = observer(({ className, file, files, size = 20 }: { className: string, file: FileType, files: FileType[], size?: number }) => {
  const store = RootStore.Local(() => ({
    deleteFile: new PromiseState({
      function: async (file) => {
        const path = file.uploadPromise?.value;
        if (path) {
          await axiosInstance.post(getBlinkoEndpoint('/api/file/delete'), {
            attachment_path: path,
          });
        }
        const index = files.findIndex(i => i.name == file.name)
        files.splice(index, 1)
        RootStore.Get(DialogStandaloneStore).close()
        RootStore.Get(ToastPlugin).success(t('delete-success'))
        RootStore.Get(BlinkoStore).removeCreateAttachments(file)
      }
    })
  }))

  const { t } = useTranslation()
  return <>
    <TipsPopover isLoading={store.deleteFile.loading.value} content={t('this-operation-will-be-delete-resource-are-you-sure')}
      onConfirm={async e => {
        store.deleteFile.call(file)
      }}>
      <div className={`opacity-70 hover:opacity-100 bg-black cursor-pointer rounded-sm transition-al ${className}`}>
        <Icon className='!text-white' icon="basil:cross-solid" width={size} height={size} />
      </div>
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

export const DownloadIcon = observer(({ className, file, size = 20 }: { className?: string, file: FileType, size?: number }) => {
  return <div className={`hidden p-1 group-hover:block !transition-all absolute z-10 right-[5px] top-[5px] !text-background opacity-70 hover:opacity-100 !bg-foreground cursor-pointer rounded-sm !transition-all ${className}`}>
    <Icon onClick={() => {
      downloadFromLink(file.uploadPromise?.value || file.preview);
    }} icon="tabler:download" width="15" height="15" />
  </div>
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
