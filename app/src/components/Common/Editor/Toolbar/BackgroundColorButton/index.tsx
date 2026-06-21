import { IconButton } from '../IconButton';
import { useTranslation } from 'react-i18next';
import { EditorStore } from '../../editorStore';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Icon } from '@/components/Common/Iconify/icons';
import { useState, useCallback } from 'react';
import { BACKGROUND_COLORS, type BackgroundColor } from '@/lib/backgroundColors';
import { cn } from '@/lib/utils';

interface Props {
  store: EditorStore;
}

interface ColorSwatchProps {
  color: typeof BACKGROUND_COLORS[number];
  isActive: boolean;
  onSelect: (value: BackgroundColor) => void;
}

function ColorSwatch({ color, isActive, onSelect }: ColorSwatchProps) {
  const { t } = useTranslation();

  const handleClick = useCallback(() => {
    onSelect(color.value);
  }, [onSelect, color.value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(color.value);
    }
  }, [onSelect, color.value]);

  return (
    <Tooltip content={t(color.name)} delay={300}>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-8 h-8 rounded-full cursor-pointer border-2 transition-all hover:scale-110 flex items-center justify-center',
          isActive ? 'border-primary' : 'border-transparent'
        )}
        style={{
          backgroundColor: color.value || 'var(--heroui-colors-default-100)',
        }}
      >
        {color.value === null && (
          <Icon icon="mdi:close" width={16} height={16} />
        )}
      </div>
    </Tooltip>
  );
}

export const BackgroundColorButton = observer(({ store }: Props) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback((value: BackgroundColor) => {
    store.backgroundColor = value;
  }, [store]);

  return (
    <Popover placement="bottom" showArrow isOpen={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger>
        <div>
          <IconButton
            tooltip={t('background-color')}
            icon="mdi:palette-outline"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent className="p-2 max-w-[280px]">
        <div className="flex flex-row flex-wrap gap-2 justify-center">
          {BACKGROUND_COLORS.map((color) => (
            <ColorSwatch
              key={color.name}
              color={color}
              isActive={store.backgroundColor === color.value}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
