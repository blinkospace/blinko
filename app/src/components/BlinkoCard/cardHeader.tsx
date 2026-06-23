import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { NoteCopyDropdown } from "../Common/NoteCopyDropdown";
import { LeftCickMenu, ShowEditTimeModel } from "../BlinkoRightClickMenu";
import { BlinkoStore } from '@/store/blinkoStore';
import { Note, NoteType } from '@shared/lib/types';
import { RootStore } from '@/store';
import dayjs from '@/lib/dayjs';
import { useTranslation } from 'react-i18next';
import { _ } from '@/lib/lodash';
import { useIsIOS } from '@/lib/hooks';
import { DialogStore } from '@/store/module/Dialog';
import { BlinkoShareDialog } from '../BlinkoShareDialog';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { AvatarAccount, CommentButton, UserAvatar } from './commentButton';
import { HistoryButton } from '../BlinkoNoteHistory/HistoryButton';
import { api } from '@/lib/trpc';
import { PromiseCall } from '@/store/standard/PromiseState';

interface CardHeaderProps {
  blinkoItem: Note;
  blinko: BlinkoStore;
  isShareMode: boolean;
  isExpanded?: boolean;
  account?: AvatarAccount;
}

export const CardHeader = observer(({ blinkoItem, blinko, isShareMode, isExpanded, account }: CardHeaderProps) => {
  const { t } = useTranslation();
  const iconSize = isExpanded ? '20' : '16';
  const isIOSDevice = useIsIOS();

  const attachmentAbsoluteUrls = useMemo(
    () => blinkoItem.attachments?.map((i) => window.location.origin + i.path) ?? [],
    [blinkoItem.attachments]
  );

  const toolbarHoverClasses = isIOSDevice
    ? 'opacity-100'
    : 'translate-x-1 opacity-0 group-hover/card:translate-x-0 group-hover/card:opacity-100';

  const handleTodoToggle = async (e) => {
    e.stopPropagation();

    try {
      if (blinkoItem.isArchived) {
        await blinko.upsertNote.call({
          id: blinkoItem.id,
          isArchived: false
        });
        blinko.updateTicker++
      } else {
        await blinko.upsertNote.call({
          id: blinkoItem.id,
          isArchived: true
        });
        blinko.updateTicker++
      }
    } catch (error) {
      console.error('Error toggling TODO status:', error);
    }
  };

  return (
    <div className={`flex items-center select-none ${isExpanded ? 'mb-4' : 'mb-1'}`}>
      <div className={`flex items-center w-full gap-1 ${isExpanded ? 'text-base' : 'text-xs'}`}>
        {blinkoItem.isShare && !isShareMode && (
          <Tooltip content={t('shared')} delay={1000}>
            <div className="flex items-center gap-2">
              <Icon
                className="cursor-pointer "
                icon="prime:eye"
                width={iconSize}
                height={iconSize}
              />
            </div>
          </Tooltip>
        )}

        {blinkoItem.isInternalShared && (
          <Tooltip content={t('internal-shared')} delay={1000}>
            <div className="flex items-center gap-2">
              <Icon
                className="cursor-pointer "
                icon="prime:users"
                width={iconSize}
                height={iconSize}
              />
            </div>
          </Tooltip>
        )}

        {isShareMode && account && (
          <UserAvatar account={account} blinkoItem={blinkoItem} />
        )}

        {blinkoItem.type === NoteType.TODO && (
          <Tooltip content={blinkoItem.isArchived ? t('restore') : t('complete')} delay={1000}>
            <div
              className="flex items-center cursor-pointer"
              onClick={handleTodoToggle}
            >
              <Icon
                icon={blinkoItem.isArchived ? "solar:refresh-circle-bold" : "mdi:circle-outline"}
                className={`${blinkoItem.isArchived ? 'text-blue-500' : 'text-green-500'} hover:opacity-80`}
                width="16"
                height="16"
              />
            </div>
          </Tooltip>
        )}

        <Tooltip content={t('edit-time')} delay={1000}>
          <div
            className={`${isExpanded ? 'text-sm' : 'text-xs'} text-desc cursor-pointer transition-colors`}
            onClick={(e) => {
              e.stopPropagation();
              blinko.curSelectedNote = _.cloneDeep(blinkoItem);
              ShowEditTimeModel();
            }}
          >
            {blinko.config.value?.timeFormat == 'relative'
              ? dayjs(blinko.config.value?.isOrderByCreateTime ? blinkoItem.createdAt : blinkoItem.updatedAt).fromNow()
              : dayjs(blinko.config.value?.isOrderByCreateTime ? blinkoItem.createdAt : blinkoItem.updatedAt).format(blinko.config.value?.timeFormat ?? 'YYYY-MM-DD HH:mm:ss')
            }
          </div>
        </Tooltip>

        <div
          className={`ml-auto flex min-w-0 flex-shrink-0 items-center gap-2 ${toolbarHoverClasses}`}
        >
          <NoteCopyDropdown
            size={16}
            className="flex-shrink-0"
            noteMarkdown={blinkoItem.content ?? ''}
            attachmentAbsoluteUrls={attachmentAbsoluteUrls}
          />

          <CommentButton blinkoItem={blinkoItem} toolbarGrouped />

          {isShareMode && (
            <Tooltip content="RSS" delay={1000}>
              <div className="flex items-center">
                <Icon
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(window.location.origin + `/api/rss/${blinkoItem.accountId}/atom?row=20`);
                  }}
                  icon="mingcute:rss-2-fill"
                  className="cursor-pointer text-desc hover:text-primary"
                  width="16"
                  height="16"
                />
              </div>
            </Tooltip>
          )}

          {!isShareMode && <ShareButton blinkoItem={blinkoItem} isIOSDevice={isIOSDevice} toolbarGrouped />}

          {!isShareMode && !!blinkoItem._count?.histories && blinkoItem._count?.histories > 0 && (
            <HistoryButton
              noteId={blinkoItem.id!}
              className="mt-[1px] cursor-pointer text-desc hover:text-primary"
            />
          )}

          {!isShareMode && (
            <Tooltip content={t('trash')} delay={1000}>
              <Icon
                icon="mingcute:delete-2-line"
                width={iconSize}
                height={iconSize}
                className={`cursor-pointer text-desc hover:text-red-500 ${blinkoItem.isRecycle ? 'text-red-500' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  PromiseCall(api.notes.trashMany.mutate({ ids: [blinkoItem.id!] })).then(() => {
                    blinko.updateTicker++;
                  });
                }}
              />
            </Tooltip>
          )}

          {blinkoItem.isTop && (
            <Icon className="text-[#EFC646]" icon="solar:bookmark-bold" width={iconSize} height={iconSize} />
          )}

          {!isShareMode && (
            <LeftCickMenu
              className="flex-shrink-0 text-desc hover:scale-1.3 hover:text-primary"
              onTrigger={() => {
                blinko.curSelectedNote = _.cloneDeep(blinkoItem);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
});

const ShareButton = observer(
  ({
    blinkoItem,
    isIOSDevice,
    toolbarGrouped = false,
  }: {
    blinkoItem: Note;
    isIOSDevice: boolean;
    toolbarGrouped?: boolean;
  }) => {
    const { t } = useTranslation();
    const blinko = RootStore.Get(BlinkoStore);
    const visibilityClasses = toolbarGrouped
      ? ''
      : isIOSDevice
        ? 'opacity-100'
        : 'translate-x-1 opacity-0 group-hover/card:translate-x-0 group-hover/card:opacity-100';

    return (
      <Tooltip content={t('share')} delay={1000}>
        <div className="flex items-center gap-2">
          <Icon
            icon="tabler:share-2"
            width="16"
            height="16"
            className={`cursor-pointer text-desc ${toolbarGrouped ? '' : 'ml-2'} ${visibilityClasses}`}
            onClick={async (e) => {
              e.stopPropagation();
              blinko.curSelectedNote = _.cloneDeep(blinkoItem);
              RootStore.Get(DialogStore).setData({
                isOpen: true,
                size: 'md',
                title: t('share'),
                content: (
                  <BlinkoShareDialog
                    defaultSettings={{
                      shareUrl: blinkoItem.shareEncryptedUrl
                        ? window.location.origin + '/share/' + blinkoItem.shareEncryptedUrl
                        : undefined,
                      expiryDate: blinkoItem.shareExpiryDate ?? undefined,
                      password: blinkoItem.sharePassword ?? '',
                      isShare: blinkoItem.isShare,
                    }}
                  />
                ),
              });
            }}
          />
        </div>
      </Tooltip>
    );
  }
);
