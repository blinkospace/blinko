import React, { useRef, useEffect } from 'react';
import { Modal, ModalContent, ModalBody, Input, Button, Divider } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from 'react-i18next';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { AiStore } from '@/store/aiStore';
import { observer } from 'mobx-react-lite';
import { _ } from '@/lib/lodash';
import { cn } from '@/lib/utils';
import { Note, ResourceType, Tag } from '@shared/lib/types';
import { ScrollArea } from '../Common/ScrollArea';
import { ResourceItemPreview } from '@/components/BlinkoResource/ResourceItem';
import { allSettings } from '@/pages/settings';
import { BlinkoCard } from '../BlinkoCard';
import { ConvertTypeButton } from '../BlinkoCard/cardFooter';
import { LoadingAndEmpty } from '../Common/LoadingAndEmpty';
import { helper } from '@/lib/helper';
import { useLocation, useSearchParams, useNavigate } from 'react-router-dom';
import { getBlinkoEndpoint } from '@/lib/blinkoEndpoint';
import { downloadFromLink } from '@/lib/tauriHelper';

interface GlobalSearchProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

// Text highlighting component
const HighlightText = ({ text, searchTerm }: { text: string; searchTerm: string }) => {
  if (!searchTerm || !text) return <span>{text}</span>;

  // Clean search term (remove @ and # prefixes)
  const cleanSearchTerm = searchTerm.replace(/^[@#]/, '').trim();
  if (!cleanSearchTerm) return <span>{text}</span>;

  // Escape special regex characters
  const escapedSearchTerm = cleanSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Create regex for case-insensitive matching
  const regex = new RegExp(`(${escapedSearchTerm})`, 'gi');

  // Split text into parts
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, index) => {
        // Check if this part matches the search term (case insensitive)
        const isMatch = regex.test(part);
        regex.lastIndex = 0; // Reset regex for next test

        return isMatch ? (
          <mark
            key={index}
            className="bg-yellow-200 dark:bg-yellow-800 text-black dark:text-white px-1 rounded-sm"
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </span>
  );
};

export const GlobalSearch = observer(({ isOpen, onOpenChange }: GlobalSearchProps) => {
  const { t } = useTranslation();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const blinkoStore = RootStore.Get(BlinkoStore);
  const aiStore = RootStore.Get(AiStore);
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate()
  // Move all state management to RootStore.Local
  const store = RootStore.Local(() => ({
    searchQuery: '',
    isAiQuestion: false,
    isSearching: false,
    searchResults: {
      notes: [] as Note[],
      resources: [] as ResourceType[],
      settings: [] as any[],
      tags: [] as Tag[],
    },

    // Methods
    setSearchQuery(value: string) {
      this.searchQuery = value;

      // Auto-detect @AI syntax
      if (value.startsWith('@') && !this.isAiQuestion) {
        this.isAiQuestion = true;
      } else if (!value.startsWith('@')) {
        this.isAiQuestion = false;
      }

      // Trigger search with loading state
      if (value) {
        this.isSearching = true;
        debouncedSearch.current(value);
      } else if (!value) {
        this.searchResults = { notes: [], resources: [], settings: [], tags: [] };
        // Reset blinkoStore search text and reset list calls
        blinkoStore.searchText = '';
        blinkoStore.globalSearchTerm = '';
        blinkoStore.noteList.resetAndCall({ page: 1, size: 20 });
        blinkoStore.resourceList.resetAndCall({
          page: 1,
          size: 20,
          searchText: '',
          folder: undefined,
        });
        blinkoStore.updateTicker++
      }
    },

    toggleAiQuestion() {
      this.isAiQuestion = !this.isAiQuestion;
      this.searchQuery = this.isAiQuestion ? '@' + this.searchQuery.replace('#', '') : this.searchQuery.replace('@', '');
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    },

    // Computed properties
    get hasResults() {
      return (
        this.searchResults.notes.length > 0 ||
        this.searchResults.resources.length > 0 ||
        this.searchResults.settings.length > 0 ||
        this.searchResults.tags.length > 0
      );
    },
  }));

  // Reset search query when the modal opens
  useEffect(() => {
    if (isOpen) {
      store.searchQuery = blinkoStore.searchText || '';
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }
  }, [isOpen]);

  useEffect(() => {
    blinkoStore.noteListFilterConfig.isUseAiQuery = store.isAiQuestion;
  }, [store.isAiQuestion]);

  // Create debounced search function - properly update search results after typing stops
  const debouncedSearch = useRef(
    _.debounce(async (query) => {
      if (!query) {
        store.searchResults = { notes: [], resources: [], settings: [], tags: [] };
        store.isSearching = false;
        return;
      }
      // 1. Store the search query in the store
      blinkoStore.searchText = query;
      blinkoStore.globalSearchTerm = query;

      try {
        // Ensure AI retrieval flag is in sync for this call
        // Detect "@" prefix proactively to avoid timing issues with the effect
        const isAiQuery = query.trim().startsWith('@') || store.isAiQuestion;
        blinkoStore.noteListFilterConfig.isUseAiQuery = isAiQuery;

        // 2. Search for notes using the API
        // Set search text in the store and call the API through the store
        blinkoStore.searchText = query;
        // type: -1 means search all types (Memo, Note, Todo)
        // isArchived: null means search both archived and non-archived
        const notes = await blinkoStore.noteList.resetAndCall({ page: 1, size: 20, type: -1, isArchived: null });
        // await blinkoStore.blinkoList.resetAndCall({ page: 1, size: 20 });
        // 3. Search for resources using the API
        const resources = await blinkoStore.resourceList.resetAndCall({
          page: 1,
          size: 20,
          // Strip leading @/# so regular resource search still works with prefixes
          searchText: query.replace(/^[@#]/, ''),
          folder: undefined,
        });

        // 4. Search settings using the imported allSettings array
        // Filter settings that match the search query
        const matchingSettings = allSettings
          .filter((setting) => setting.title.toLowerCase().includes(query.toLowerCase()) || setting.keywords?.some((kw) => kw.toLowerCase().includes(query.toLowerCase())))
          .filter((setting) => setting.key !== 'all')
          .slice(0, 5);

        // 5. Update search results (filter out .folder placeholder files)
        store.searchResults = {
          notes: notes || [],
          resources: (resources || []).filter(r => r.name !== '.folder'),
          settings: matchingSettings,
          tags: [],
        };

        blinkoStore.forceQuery++
      } catch (error) {
        console.error('Search error:', error);
      } finally {
        store.isSearching = false;
      }
    }, 300),
  );

  // Key handling
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (store.isAiQuestion) {
        handleAiQuestion();
      } else {
        onOpenChange(false);
      }
    } else if (e.key === 'Escape') {
      onOpenChange(false);
    }
  };

  // Navigation methods
  const navigateToNote = (note: Note) => {
    navigate(`/detail?id=${note.id}`);
    onOpenChange(false);
  };

  const navigateToResource = (resource: ResourceType) => {
    //download
    downloadFromLink(getBlinkoEndpoint(resource.path));
    onOpenChange(false);
  };

  const navigateToSetting = (settingKey: string) => {
    navigate(`/settings?section=${settingKey}`);
    onOpenChange(false);
  };

  const handleAiQuestion = () => {
    if (!store.searchQuery) return;

    // Prepare the AI prompt
    const aiPrompt = store.searchQuery.startsWith('@') ? store.searchQuery.substring(1).trim() : store.searchQuery;

    // Start a new AI chat with the question
    aiStore.newChatWithSuggestion(aiPrompt);
    navigate('/ai');
    onOpenChange(false);
  };

  // Add a new navigation method for tags
  const navigateToTag = (tagName: string) => {
    navigate(`/?path=all&searchText=%23${encodeURIComponent(tagName)}`);
    onOpenChange(false);
  };

  // Render search result items
  const renderNoteItem = (note: Note) => (
    <div key={note.id} className="flex gap-2 items-center p-2 hover:bg-default-100 rounded-md transition-colors">
      <div
        className="text-xs truncate w-full md:w-[80%] cursor-pointer"
        onClick={() => navigateToNote(note)}
      >
        <HighlightText text={note?.content?.substring(0, 60) || t('no-content')} searchTerm={store.searchQuery} />
      </div>
      <div className="ml-auto hidden md:block" onClick={(e) => e.stopPropagation()}>
        <ConvertTypeButton
          blinkoItem={note}
          tooltipPlacement="right"
          toolTipClassNames={{
            base: 'bg-content1 border border-default-200 shadow-lg',
            content: 'p-0',
          }}
          tooltip={
            <div className="max-w-[400px] p-0 rounded-2xl bg-transparent">
              <BlinkoCard blinkoItem={note} withoutHoverAnimation withoutBoxShadow className='!border-none' />
            </div>
          }
        />
      </div>
    </div>
  );

  const renderResourceItem = (resource: ResourceType) => (
    <div key={resource.id} className="hover:bg-default-100 rounded-md cursor-pointer transition-colors" onClick={() => navigateToResource(resource)}>
      <ResourceItemPreview item={resource} onClick={() => navigateToResource(resource)} showExtraInfo={true} showAssociationIcon={true} className="hover:bg-transparent" />
    </div>
  );

  const renderSettingItem = (setting: any) => (
    <div key={setting.key} className="flex gap-2 items-center p-2 hover:bg-default-100 rounded-md cursor-pointer transition-colors" onClick={() => navigateToSetting(setting.key)}>
      <div className="p-2 rounded-md bg-warning-50">
        <Icon icon={setting.icon} className="text-warning" />
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="font-medium text-sm truncate">{t(setting.title)}</div>
        <div className="text-xs text-default-500 truncate">{t('settings')}</div>
      </div>
    </div>
  );

  // Render tag item
  const renderTagItem = (tag: Tag) => (
    <div key={tag.id} className="flex gap-2 items-center p-2 hover:bg-default-100 rounded-md cursor-pointer transition-colors" onClick={() => navigateToTag(tag.name)}>
      <div className="text-xs flex items-center gap-2">
        <span className="text-primary">#{tag.name}</span>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="top"
      motionProps={{
        variants: {
          enter: {
            y: 0,
            opacity: 1,
            transition: { type: 'spring', bounce: 0.5, duration: 0.6, },
          },
          exit: {
            y: -20,
            opacity: 0,
            transition: { type: 'spring', bounce: 0.5, duration: 0.3, },
          },
        }
      }}
      classNames={{
        base: 'max-w-2xl mx-auto mt-10',
      }}
    >
      <ModalContent>
        <ModalBody className="py-4">
          <div className="flex flex-col gap-3">
            {/* Search Input */}
            <Input
              ref={searchInputRef}
              aria-label="global-search"
              className={cn("mt-4", {
                'input-highlight': store.isAiQuestion,
              })}
              placeholder={t('search-or-ask-ai')}
              value={store.searchQuery}
              onChange={(e) => {
                const value = e.target.value;
                store.setSearchQuery(value);
              }}
              autoFocus
              onKeyDown={handleKeyDown}
              startContent={
                <Icon
                  className=""
                  icon={
                    store.isAiQuestion
                      ? 'hugeicons:ai-beautify'
                      : 'lets-icons:search'
                  }
                  width="24"
                  height="24"
                />
              }
              endContent={
                <div className="flex items-center gap-1">
                  {store.searchQuery && (
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      onPress={() => store.setSearchQuery('')}
                      className="hover:text-danger transition-colors"
                    >
                      <Icon icon="ph:x-bold" width="16" height="16" />
                    </Button>
                  )}
                  <Button
                    isIconOnly
                    variant="light"
                    size="sm"
                    onPress={() => store.toggleAiQuestion()}
                    className={cn('hover:text-primary transition-colors', store.isAiQuestion && 'text-primary')}
                  >
                    <Icon icon={store.isAiQuestion ? 'lets-icons:search' : 'hugeicons:ai-beautify'} width="20" height="20" />
                  </Button>
                </div>
              }
            />

            {/* Search Results */}
            {store.searchQuery && (
              <div className="mt-2">
                <LoadingAndEmpty isLoading={store.isSearching} isEmpty={!store.hasResults} />
                <ScrollArea className="max-h-[600px] md:max-h-[400px]" onBottom={() => { }}>
                  <div className="flex flex-col gap-3 px-1">
                    {/* Notes section - only show if not in tag search mode */}
                    {store.searchResults.notes.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <Icon icon="hugeicons:sticky-note-02" className="h-4 w-4 mr-2 text-primary" />
                            <h3 className="text-sm font-medium text-default-700">{t('note')}</h3>
                          </div>
                        </div>
                        <div className="flex flex-col">{store.searchResults.notes.map(renderNoteItem)}</div>
                      </div>
                    )}

                    {/* Resources section - only show if not in tag search mode */}
                    {store.searchResults.resources.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <Divider className="my-2" />
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <Icon icon="mingcute:folder-line" className="h-4 w-4 mr-2 text-success" />
                            <h3 className="text-sm font-medium text-default-700">{t('resources')}</h3>
                          </div>
                        </div>
                        <div className="flex flex-col">{store.searchResults.resources.map(renderResourceItem)}</div>
                      </div>
                    )}

                    {/* Settings section - only show if not in tag search mode */}
                    {store.searchResults.settings.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <Divider className="my-2" />
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <Icon icon="tabler:settings" className="mr-2 text-warning" />
                            <h3 className="text-sm font-medium text-default-700">{t('settings')}</h3>
                          </div>
                        </div>
                        <div className="flex flex-col">{store.searchResults.settings.map(renderSettingItem)}</div>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}

            <div className="text-xs text-default-500 flex justify-between items-center">
              <div>
                {store.isAiQuestion ? (
                  t('to-ask-ai')
                ) : (
                  <>
                    {t('press-enter-to-select-first-result')} • <span className="text-primary">@</span> {t('to-ask-ai')} • <span className="text-primary">#</span> {t('to-search-tags')}
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                <kbd className="px-2 py-1 bg-default-100 rounded text-default-600 text-xs">Ctrl</kbd>
                <span>+</span>
                <kbd className="px-2 py-1 bg-default-100 rounded text-default-600 text-xs">K</kbd>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
});
