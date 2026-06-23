import { Icon } from '@/components/Common/Iconify/icons';
import { copyNoteMarkdownToClipboard, copyNoteRichToClipboard } from '@/lib/noteClipboard';
import { RootStore } from '@/store';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import { useTranslation } from 'react-i18next';

export interface NoteCopyDropdownProps {
  noteMarkdown: string;
  attachmentAbsoluteUrls: string[];
  size?: number;
  className?: string;
}

export function NoteCopyDropdown({
  noteMarkdown,
  attachmentAbsoluteUrls,
  size = 16,
  className,
}: NoteCopyDropdownProps) {
  const { t } = useTranslation();
  const chevronSize = Math.max(12, size - 4);

  const runCopy = async (fn: () => Promise<void>) => {
    try {
      await fn();
      RootStore.Get(ToastPlugin).success(t('copy-success'));
    } catch {
      RootStore.Get(ToastPlugin).error(t('operation-failed'));
    }
  };

  return (
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Dropdown
        placement="bottom-end"
        className='!z-50'
      >
        <DropdownTrigger>
          <Button
            type="button"
            variant="light"
            size="sm"
            radius="sm"
            className="min-w-0 h-7 w-auto min-h-7 gap-0 px-1 py-0 text-desc bg-transparent data-[hover=true]:bg-default-100"
            aria-label={t('copy-as-standard')}
          >
            <span className="inline-flex items-center gap-0">
              <Icon icon="si:copy-duotone" width={size} height={size} />
              <Icon icon="mdi:chevron-down" width={chevronSize} height={chevronSize} />
            </span>
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label={t('copy-as-standard')}
          onAction={(key) => {
            if (key === 'standard') {
              void runCopy(() => copyNoteRichToClipboard(noteMarkdown, attachmentAbsoluteUrls));
            } else if (key === 'markdown') {
              void runCopy(() => copyNoteMarkdownToClipboard(noteMarkdown, attachmentAbsoluteUrls));
            }
          }}
        >
          <DropdownItem key="standard">
            <div className="flex items-start gap-2">
              <Icon icon="si:copy-duotone" width="20" height="20" />
              <div>{t('copy-as-standard')}</div>
            </div>
          </DropdownItem>
          <DropdownItem key="markdown">
            <div className="flex items-start gap-2">
              <Icon icon="mdi:language-markdown-outline" width="20" height="20" />
              <div>{t('copy-as-markdown')}</div>
            </div>
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </div>
  );
}
