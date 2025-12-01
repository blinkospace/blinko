import { Icon } from '@/components/Common/Iconify/icons';
import { Button, Tooltip } from '@heroui/react';
import { Copy } from "../Common/Copy";
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
        {isExpanded && (
          <Button
            isIconOnly
            variant='flat'
            size='sm'
            className='mr-2'
            onPress={(e) => {
              window.history.back();
            }}
          >
            <Icon icon="tabler:arrow-left" width={iconSize} height={iconSize} />
          </Button>
        )}

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

        <Copy
          size={16}
          className={`ml-auto ${isIOSDevice
            ? 'opacity-100'
            : 'opacity-0 group-hover/card:opacity-100 group-hover/card:translate-x-0 translate-x-1'
            }`}
          content={blinkoItem.content + `\n${blinkoItem.attachments?.map(i => window.location.origin + i.path).join('\n')}`}
        />

        <CommentButton blinkoItem={blinkoItem} />

        {isShareMode && (
          <Tooltip content="RSS" delay={1000}>
            <div className="flex items-center gap-2">
              <Icon onClick={e => {
                window.open(window.location.origin + `/api/rss/${blinkoItem.accountId}/atom?row=20`)
              }} icon="mingcute:rss-2-fill" className='opacity-0 group-hover/card:opacity-100 group-hover/card:translate-x-0 ml-2 cursor-pointer hover:text-primary' width="16" height="16" />
            </div>
          </Tooltip>
        )}

        {!isShareMode && (
          <ShareButton blinkoItem={blinkoItem} isIOSDevice={isIOSDevice} />
        )}

        {/* History button for viewing note versions */}
        {!isShareMode && !!blinkoItem._count?.histories && blinkoItem._count?.histories > 0 && (
          <HistoryButton
            noteId={blinkoItem.id!}
            className={'opacity-0 group-hover/card:opacity-100 group-hover/card:translate-x-0 ml-2 cursor-pointer hover:text-primary text-desc mt-[1px]'}
          />
        )}

        {blinkoItem.isTop && (
          <Icon
            className={isIOSDevice ? 'ml-[10px] text-[#EFC646]' : "ml-auto group-hover/card:ml-2 text-[#EFC646]"}
            icon="solar:bookmark-bold"
            width={iconSize}
            height={iconSize}
          />
        )}

        {!isShareMode && (
          <LeftCickMenu
            className={isIOSDevice ? 'ml-[10px]' : (blinkoItem.isTop ? "ml-[10px]" : 'ml-auto group-hover/card:ml-2')}
            onTrigger={() => { blinko.curSelectedNote = _.cloneDeep(blinkoItem) }}
          />
        )}
      </div>
    </div>
  );
});

const ShareButton = observer(({ blinkoItem, isIOSDevice }: { blinkoItem: Note, isIOSDevice: boolean }) => {
  const { t } = useTranslation()
  const blinko = RootStore.Get(BlinkoStore);
  return (
    <Tooltip content={t('share')} delay={1000}>
      <div className="flex items-center gap-2">
        <Icon
          icon="tabler:share-2"
          width="16"
          height="16"
          className={`cursor-pointer text-desc ml-2 ${isIOSDevice
            ? 'opacity-100'
            : 'opacity-0 group-hover/card:opacity-100 group-hover/card:translate-x-0 translate-x-1'
            }`}
          onClick={async (e) => {
            e.stopPropagation()
            blinko.curSelectedNote = _.cloneDeep(blinkoItem)
            RootStore.Get(DialogStore).setData({
              isOpen: true,
              size: 'md',
              title: t('share'),
              content: <BlinkoShareDialog defaultSettings={{
                shareUrl: blinkoItem.shareEncryptedUrl ? window.location.origin + '/share/' + blinkoItem.shareEncryptedUrl : undefined,
                expiryDate: blinkoItem.shareExpiryDate ?? undefined,
                password: blinkoItem.sharePassword ?? '',
                isShare: blinkoItem.isShare
              }} />
            })
          }}
        />
      </div>
    </Tooltip>
  );
})
