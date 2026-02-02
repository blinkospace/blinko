import React, { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { observer } from 'mobx-react-lite';
import { eventBus } from '@/lib/event';
import { GlobalSearch } from './GlobalSearch';

interface BarSearchInputProps {
  isPc: boolean;
}

export const BarSearchInput = observer(({ isPc }: BarSearchInputProps) => {
  const { t } = useTranslation();
  const blinkoStore = RootStore.Get(BlinkoStore);
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [localSearchText, setLocalSearchText] = useState('');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        eventBus.emit('open-global-search');
      }
    };

    eventBus.on('open-global-search', () => {
      setIsGlobalSearchOpen(true);
    });

    // Sync with blinkoStore.searchText
    setLocalSearchText(blinkoStore.searchText || '');

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [blinkoStore.searchText]);

  // Check if there are any active filters
  const hasActiveFilters = () => {
    const config = blinkoStore.noteListFilterConfig;
    return !!(
      localSearchText ||
      config.tagId !== null ||
      config.withoutTag ||
      config.withFile ||
      config.withLink ||
      config.isShare !== null ||
      config.hasTodo ||
      config.startDate !== null ||
      config.endDate !== null ||
      config.type !== 0
    );
  };

  const handleGlobalSearch = () => {
    // Emit an event that will be caught by the CommonLayout to open the global search
    eventBus.emit('open-global-search');
  };

  const handleClearSearch = (e: React.MouseEvent) => {
    console.log(e);
    e.stopPropagation();
    setLocalSearchText('');
    blinkoStore.searchText = '';
    // Focus back on the search input after clearing
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    blinkoStore.forceQuery++
  };

  return (
    <>
      <GlobalSearch isOpen={isGlobalSearchOpen} onOpenChange={setIsGlobalSearchOpen} />
      {!isPc && !showSearchInput ? (
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.2 }}>
          <Button isIconOnly className="ml-auto mt-[2px]" size="sm" variant="light" onPress={() => handleGlobalSearch()}>
            <Icon className="text-default-600" icon="lets-icons:search" width="24" height="24" />
          </Button>
        </motion.div>
      ) : (
        <div className="hidden md:flex items-center relative">
          <Button size="sm" variant="light" onPress={() => setIsGlobalSearchOpen(true)} className={`${!hasActiveFilters() ? 'w-[170px]' : 'w-auto min-w-[120px] max-w-[250px]'} justify-center flex gap-1 px-3 border-2 border-desc`}>
            <Icon className="text-default-500 mr-1" icon="lets-icons:search" width="16" height="16" />
            <span className={`${localSearchText.length > 0 ? 'text-primary-foreground bg-primary rounded-md px-2' : 'text-default-500'} truncate mr-auto`}>{localSearchText.length > 0 ? localSearchText : t('search')}</span>
            {localSearchText && <Icon icon="ph:x-bold" width="14" height="14" className="ml-1 p-0 hover:text-danger transition-colors" onClick={handleClearSearch} />}

            {!localSearchText && (
              <div className="flex items-center gap-1 ml-2">
                <kbd className="px-1.5 py-0.5 bg-default-100 rounded text-default-600 text-xs">Ctrl</kbd>
                <span className="text-default-600">+</span>
                <kbd className="px-1.5 py-0.5 bg-default-100 rounded text-default-600 text-xs">K</kbd>
              </div>
            )}
          </Button>
        </div>
      )}
    </>
  );
});
