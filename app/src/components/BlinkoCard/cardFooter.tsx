import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { Note, NoteType } from '@shared/lib/types';
import { ConvertItemFunction, ShowEditTimeModel } from '../BlinkoRightClickMenu';
import { BlinkoStore } from '@/store/blinkoStore';
import { useTranslation } from 'react-i18next';
import { _ } from '@/lib/lodash';
import { CommentCount } from './commentButton';
import { BlinkoItem } from '.';
import { RootStore } from '@/store';
import dayjs from '@/lib/dayjs';

interface CardFooterProps {
  blinkoItem: BlinkoItem;
  blinko: BlinkoStore;
  isShareMode?: boolean;
}

export const CardFooter = ({ blinkoItem, blinko, isShareMode }: CardFooterProps) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center">
      <ConvertTypeButton blinkoItem={blinkoItem} />
      <RightContent blinkoItem={blinkoItem} t={t} />
    </div>
  );
};

export const ConvertTypeButton = ({
  blinkoItem,
  tooltip,
  toolTipClassNames,
  tooltipPlacement,
}: {
  blinkoItem: BlinkoItem & any;
  tooltip?: React.ReactNode;
  toolTipClassNames?: any;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
}) => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore);

  const handleClick = (e) => {
    e.stopPropagation();
    blinko.curSelectedNote = _.cloneDeep(blinkoItem);
    
    if (blinkoItem.type === NoteType.TODO) {
      ShowEditTimeModel(true);
    } else {
      ConvertItemFunction();
    }
  };

  const getTodoStatus = () => {
    if (!blinkoItem.metadata?.expireAt) {
      return { color: 'text-green-500', status: 'no-deadline' };
    }
    
    const expireDate = dayjs(blinkoItem.metadata.expireAt);
    const now = dayjs();
    
    if (expireDate.isBefore(now)) {
      return { color: 'text-red-500', status: 'expired' };
    } else if (expireDate.diff(now, 'day') <= 3) {
      return { color: 'text-yellow-500', status: 'warning' };
    } else {
      return { color: 'text-green-500', status: 'normal' };
    }
  };

  if (blinkoItem.type === NoteType.BLINKO) {
    return (
      <Tooltip placement={tooltipPlacement} classNames={toolTipClassNames} content={tooltip ?? t('convert-to') + ' Note'} delay={1000}>
        <div className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
          <Icon className="text-yellow-500" icon="basil:lightning-solid" width="12" height="12" />
          <div className="text-desc text-xs font-bold ml-1 select-none">
            {t('blinko')}
            {blinkoItem.isBlog ? ` · ${t('article')}` : ''}
            {blinkoItem.isArchived ? ` · ${t('archived')}` : ''}
            {blinkoItem.isOffline ? ` · ${t('offline')}` : ''}
          </div>
        </div>
      </Tooltip>
    );
  }

  if (blinkoItem.type === NoteType.TODO) {
    const todoStatus = getTodoStatus();
    const getTooltipContent = () => {
      if (!blinkoItem.metadata?.expireAt) {
        return t('set-deadline');
      }
      const expireDate = dayjs(blinkoItem.metadata.expireAt);
      if (todoStatus.status === 'expired') {
        return `${t('expired')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
      }
      return `${t('expiry-time')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
    };

    const getTimeDisplay = () => {
      if (!blinkoItem.metadata?.expireAt) {
        return null;
      }
      
      const expireDate = dayjs(blinkoItem.metadata.expireAt);
      const now = dayjs();
      
      if (todoStatus.status === 'expired') {
        const diffInMinutes = now.diff(expireDate, 'minute');
        const diffInHours = now.diff(expireDate, 'hour');
        const diffInDays = now.diff(expireDate, 'day');
        
        if (diffInDays > 0) {
          return t('expired-days', { count: diffInDays });
        } else if (diffInHours > 0) {
          return t('expired-hours', { count: diffInHours });
        } else if (diffInMinutes > 0) {
          return t('expired-minutes', { count: diffInMinutes });
        } else {
          return t('just-expired');
        }
      } else {
        const diffInMinutes = expireDate.diff(now, 'minute');
        const diffInHours = expireDate.diff(now, 'hour');
        const diffInDays = expireDate.diff(now, 'day');
        
        if (diffInDays > 0) {
          return t('days-left', { count: diffInDays });
        } else if (diffInHours > 0) {
          return t('hours-left', { count: diffInHours });
        } else if (diffInMinutes > 0) {
          return t('minutes-left', { count: diffInMinutes });
        } else {
          return t('about-to-expire');
        }
      }
    };

    return (
      <Tooltip placement={tooltipPlacement} classNames={toolTipClassNames} content={tooltip ?? getTooltipContent()} delay={1000}>
        <div className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
          <Icon className={todoStatus.color} icon="solar:folder-check-bold" width="12" height="12" />
          <div className="text-desc text-xs font-bold ml-1 select-none">
            {t('todo')}
            {blinkoItem.metadata?.expireAt && (
              <span className={todoStatus.color}>
                {' · '}{getTimeDisplay()}
              </span>
            )}
            {blinkoItem.isBlog ? ` · ${t('article')}` : ''}
            {blinkoItem.isArchived ? ` · ${t('archived')}` : ''}
            {blinkoItem.isOffline ? ` · ${t('offline')}` : ''}
          </div>
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={t('convert-to') + ' Blinko'} delay={1500}>
      <div className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
        <Icon className="text-blue-500" icon="solar:notes-minimalistic-bold-duotone" width="12" height="12" />
        <div className="text-desc text-xs font-bold ml-1 select-none">
          {t('note')}
          {blinkoItem.isBlog ? ` · ${t('article')}` : ''}
          {blinkoItem.isArchived ? ` · ${t('archived')}` : ''}
          {blinkoItem.isOffline ? ` · ${t('offline')}` : ''}
        </div>
      </div>
    </Tooltip>
  );
};

const RightContent = ({ blinkoItem, t }: { blinkoItem: Note; t: any }) => {
  return (
    <div className="ml-auto flex items-center gap-2">
      {<CommentCount blinkoItem={blinkoItem} />}
      {blinkoItem?.metadata?.isIndexed && (
        <Tooltip content={'Indexed'} delay={1500}>
          <Icon className="!text-ignore opacity-50" icon="hugeicons:ai-beautify" width="16" height="16" />
        </Tooltip>
      )}
    </div>
  );
};
