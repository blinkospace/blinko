import { observer } from "mobx-react-lite";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Tooltip } from "@heroui/react";
import { Icon } from "@/components/Common/Iconify/icons";
import { BlinkoEditor } from "@/components/BlinkoEditor";
import { BlinkoStore } from "@/store/blinkoStore";
import { RootStore } from "@/store";
import { eventBus } from "@/lib/event";
import { useMediaQuery } from "usehooks-ts";
import { _ } from "@/lib/lodash";
import { BlinkoItem } from "./index";
import { MarkdownRender } from "@/components/Common/MarkdownRender";
import { FilesAttachmentRender } from "../Common/AttachmentRender";
import { ReferencesContent } from "./referencesContent";
import { useTranslation } from "react-i18next";

interface FullscreenEditorProps {
  blinkoItem: BlinkoItem;
  isOpen: boolean;
  onClose: () => void;
}

export const FullscreenEditor = observer(({ blinkoItem, isOpen, onClose }: FullscreenEditorProps) => {
  const isPc = useMediaQuery('(min-width: 768px)');
  const blinko = RootStore.Get(BlinkoStore);
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<string>('wysiwyg');
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview');
  const editorContainerRef = useRef<HTMLDivElement>(null);
  
  // Clean up fullscreen editor state when closing
  const handleClose = () => {
    blinko.fullscreenEditorNoteId = null;
    setEditorMode('preview');
    onClose();
  };

  // Switch to edit mode
  const handleSwitchToEdit = () => {
    setEditorMode('edit');
  };

  // Switch back to preview mode
  const handleSwitchToPreview = () => {
    setEditorMode('preview');
  };
  

  // Set default view mode to wysiwyg when opening editor in edit mode
  useEffect(() => {
    if (isOpen && editorMode === 'edit') {
      const originalMode = localStorage.getItem('blinko-editor-view-mode');
      localStorage.setItem('blinko-editor-view-mode', 'wysiwyg');
      setViewMode('wysiwyg');
      
      // Listen for view mode changes
      const handleViewModeChange = (mode: string) => {
        setViewMode(mode);
      };
      eventBus.on('editor:setViewMode', handleViewModeChange);
      
      return () => {
        if (originalMode) {
          localStorage.setItem('blinko-editor-view-mode', originalMode);
        } else {
          localStorage.removeItem('blinko-editor-view-mode');
        }
        eventBus.off('editor:setViewMode', handleViewModeChange);
      };
    }
  }, [isOpen, editorMode]);

  // Set curSelectedNote when opening editor
  useEffect(() => {
    if (isOpen) {
      // Load fresh note data from server
      if (blinkoItem.id) {
        blinko.noteDetail.call({ id: blinkoItem.id }).then(() => {
          if (blinko.noteDetail.value) {
            blinko.curSelectedNote = _.cloneDeep(blinko.noteDetail.value);
          }
        });
      } else {
        // Fallback to prop data if no id
        blinko.curSelectedNote = _.cloneDeep(blinkoItem);
        blinko.noteDetail.value = _.cloneDeep(blinkoItem);
      }
    }
  }, [isOpen, blinkoItem.id]);

  // Handle ESC key to close editor
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Check if PhotoView (image preview) is open
        // PhotoView creates a portal with class 'PhotoView-Portal' when open
        const photoViewPortal = document.querySelector('.PhotoView-Portal');
        if (photoViewPortal) {
          // Check if PhotoView overlay is visible
          const photoViewOverlay = photoViewPortal.querySelector('[class*="PhotoView__"]') as HTMLElement;
          if (photoViewOverlay) {
            const style = window.getComputedStyle(photoViewOverlay);
            // If PhotoView is visible, let it handle ESC to close image preview
            if (style.display !== 'none' && style.opacity !== '0') {
              return; // Let PhotoView handle ESC
            }
          }
        }
        
        // In edit mode, ESC goes back to preview mode first
        if (editorMode === 'edit') {
          setEditorMode('preview');
          return;
        }
        // In preview mode, ESC closes the fullscreen view
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape, true); // Use capture phase to check before PhotoView
    // Hide mobile navigation bars
    const mobileHeader = document.querySelector('.blinko-mobile-header') as HTMLElement;
    const bottomBar = document.querySelector('.blinko-bottom-bar') as HTMLElement;
    if (mobileHeader) mobileHeader.style.display = 'none';
    if (bottomBar) bottomBar.style.display = 'none';

    return () => {
      document.removeEventListener('keydown', handleEscape, true);
      // Restore navigation bars
      if (mobileHeader) mobileHeader.style.display = '';
      if (bottomBar) bottomBar.style.display = '';
    };
  }, [isOpen, onClose, editorMode]);

  const handleOutsideClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Close if clicking outside the editor container
    if (editorContainerRef.current && !editorContainerRef.current.contains(e.target as Node)) {
      handleClose();
    }
  };

  const handleEditorSended = async () => {
    // Refresh the note data after saving
    if (blinkoItem.id) {
      // Trigger list refresh
      blinko.updateTicker++;
      
      // Re-fetch the note detail to get latest data
      await blinko.noteDetail.call({ id: blinkoItem.id });
      if (blinko.noteDetail.value) {
        blinko.curSelectedNote = _.cloneDeep(blinko.noteDetail.value);
      }
    }
    
    handleClose();
  };

  // Determine max width based on view mode
  const maxWidth = viewMode === 'sv' ? '1200px' : '1000px';
  const isLongText = (blinkoItem?.content?.length ?? 0) > 1000;

  if (!isOpen) return null;

  const editorContent = (
    <div 
      className="fixed inset-0 z-[9999] bg-background overflow-hidden"
      onClick={handleOutsideClick}
      onPointerDownCapture={(e) => {
        // Only stop propagation if event is not from editor container (to prevent drag on background)
        // Allow events from editor container to work normally
        if (editorContainerRef.current && !editorContainerRef.current.contains(e.target as Node)) {
          e.stopPropagation();
        }
      }}
      onTouchStartCapture={(e) => {
        // Only stop propagation if event is not from editor container (to prevent drag on background)
        // Allow events from editor container to work normally
        if (editorContainerRef.current && !editorContainerRef.current.contains(e.target as Node)) {
          e.stopPropagation();
        }
      }}
      style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        bottom: 0
      }}
    >
      <div className="h-full flex">
        <div 
          ref={editorContainerRef}
          className={`w-full mx-auto  h-full flex ${isPc ? 'flex-col px-4' : 'flex-col p-2'}`} 
          style={{ maxWidth }}
          onClick={(e) => {
            // Stop propagation to prevent closing when clicking inside editor
            e.stopPropagation();
          }}
        >
          {/* Top header with back button and toolbar (PC only) */}
          {isPc && (
            <div className="flex items-center justify-between py-4 flex-shrink-0 border-b border-border">
              <Button
                isIconOnly
                variant="light"
                size="sm"
                onPress={handleClose}
                className="text-foreground hover:bg-default-100"
              >
                <Icon icon="tabler:arrow-left" width={20} height={20} />
              </Button>
              <div className="flex-1 flex justify-end ml-2 gap-2">
                {editorMode === 'preview' ? (
                  <Tooltip content={t('edit')}>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      onPress={handleSwitchToEdit}
                      className="text-foreground hover:bg-default-100"
                    >
                      <Icon icon="tabler:edit" width={20} height={20} />
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip content={t('preview')}>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      onPress={handleSwitchToPreview}
                      className="text-foreground hover:bg-default-100"
                    >
                      <Icon icon="tabler:eye" width={20} height={20} />
                    </Button>
                  </Tooltip>
                )}
                {editorMode === 'edit' && (
                  <div id={`editor-top-toolbar-${blinkoItem.id}`} className="flex justify-end"></div>
                )}
              </div>
            </div>
          )}
          
          {editorMode === 'preview' ? (
            /* Preview mode - render with MarkdownRender */
            <div
              className="flex-1 overflow-y-auto min-h-0 py-4"
              style={{ height: isPc ? 'calc(100vh - 100px)' : 'calc(100vh - 80px)' }}
              onDoubleClick={handleSwitchToEdit}
            >
              <MarkdownRender
                content={blinko.noteDetail.value?.content ?? blinkoItem.content}
                onChange={(newContent) => {
                  blinkoItem.content = newContent;
                  blinko.upsertNote.call({ id: blinkoItem.id, content: newContent, refresh: false });
                }}
                largeSpacing={true}
              />
              <ReferencesContent blinkoItem={blinko.noteDetail.value ?? blinkoItem} className="my-4" />
              <div className={blinkoItem.attachments?.length != 0 ? 'my-2' : ''}>
                <FilesAttachmentRender files={blinko.noteDetail.value?.attachments ?? blinkoItem.attachments ?? []} preview />
              </div>
            </div>
          ) : (
            /* Edit mode - render with BlinkoEditor */
            <div 
              className={`flex-1 overflow-hidden flex flex-col min-h-0 ${isLongText ? 'editor-long-text' : ''}`} 
              style={{ height: isPc ? 'calc(100vh - 100px)' : 'calc(100vh - 80px)', paddingBottom: isPc ? '20px' : '0' }}
            >
              <BlinkoEditor
                key={`editor-${blinkoItem.id}`}
                mode="edit"
                onSended={handleEditorSended}
                withoutOutline={true}
                showTopToolbar={true}
              />
            </div>
          )}

          {/* Bottom toolbar with back button (Mobile only) */}
          {!isPc && (
            <div className="flex items-center justify-between py-3 px-2 flex-shrink-0 border-t border-border bg-background" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
              <Button
                isIconOnly
                variant="light"
                size="sm"
                onPress={handleClose}
                className="text-foreground hover:bg-default-100"
              >
                <Icon icon="tabler:arrow-left" width={20} height={20} />
              </Button>
              <div className="flex-1 flex justify-end ml-2 gap-2">
                {editorMode === 'preview' ? (
                  <Tooltip content={t('edit')}>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      onPress={handleSwitchToEdit}
                      className="text-foreground hover:bg-default-100"
                    >
                      <Icon icon="tabler:edit" width={20} height={20} />
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip content={t('preview')}>
                    <Button
                      isIconOnly
                      variant="light"
                      size="sm"
                      onPress={handleSwitchToPreview}
                      className="text-foreground hover:bg-default-100"
                    >
                      <Icon icon="tabler:eye" width={20} height={20} />
                    </Button>
                  </Tooltip>
                )}
                {editorMode === 'edit' && (
                  <div id={`editor-top-toolbar-${blinkoItem.id}`} className="flex justify-end"></div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Use Portal to render outside of any parent container constraints
  return createPortal(editorContent, document.body);
});
