import { Icon } from '@/components/Common/Iconify/icons';
import { observer } from "mobx-react-lite";
import { Button, Popover, PopoverTrigger, PopoverContent } from "@heroui/react";
import { ScrollArea } from "../Common/ScrollArea";
import { motion, AnimatePresence } from "framer-motion";
import { MarkdownRender } from "../Common/MarkdownRender";
import { AiStore, AssisantMessageMetadata } from "@/store/aiStore";
import { RootStore } from "@/store";
import { useEffect, useRef, useCallback, memo, useState } from "react";
import { BlinkoCard, BlinkoItem } from "../BlinkoCard";
import { IconButton } from "../Common/Editor/Toolbar/IconButton";
import copy from "copy-to-clipboard";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import i18n from "@/lib/i18n";
import { BlinkoStore } from "@/store/blinkoStore";
import { NoteType } from "@shared/lib/types";
import { StreamToolRenderer } from "./ToolComponents";
import { useMediaQuery } from "usehooks-ts";
import { Textarea } from "@heroui/react";
import { DialogStore } from "@/store/module/Dialog";
import { api } from '@/lib/trpc';
import { getBlinkoEndpoint } from '@/lib/blinkoEndpoint';

const EditMessageContent = ({ initialContent, onConfirm }: {
  initialContent: string;
  onConfirm: (content: string) => void;
}) => {
  const [editContent, setEditContent] = useState(initialContent);

  return (
    <div className="p-4">
      <div className="text-sm text-desc mb-4">
        {i18n.t('edit-message-warning')}
      </div>
      <Textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        placeholder={i18n.t('enter-your-message')}
        minRows={4}
        maxRows={12}
        autoFocus
      />
      <div className="flex gap-2 mt-4 justify-end">
        <Button
          color="danger"
          variant="light"
          onPress={() => RootStore.Get(DialogStore).close()}
        >
          {i18n.t('cancel')}
        </Button>
        <Button
          color="primary"
          onPress={() => {
            if (editContent.trim()) {
              onConfirm(editContent.trim());
              RootStore.Get(DialogStore).close();
            }
          }}
          isDisabled={!editContent.trim()}
        >
          {i18n.t('confirm')}
        </Button>
      </div>
    </div>
  );
};

const UserMessage = memo(({ content, time, id, onEdit, shareMode = false }: {
  content: string;
  time: string;
  id?: number;
  onEdit?: (id: number, content: string) => void;
  shareMode?: boolean;
}) => {
  const isMobile = useMediaQuery('(max-width: 768px)');

  return (
    <motion.div
      className={`group flex flex-col w-full gap-1 ${shareMode ? 'mb-2' : ''}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="ml-auto max-w-[100%] text-sm bg-background p-2 border border-border rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl rounded-br-sm relative">
        {content}
      </div>

      {!!id && !shareMode && (
        <div className={`${isMobile ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-200 ml-auto mb-2`}>
          <div className="flex gap-2 backdrop-blur-sm rounded-full p-1 items-center">
            <IconButton
              tooltip={i18n.t('edit')}
              icon="hugeicons:edit-02"
              onClick={() => onEdit?.(id, content)}
              size={18}
              containerSize={24}
            />

            <IconButton
              tooltip={i18n.t('copy')}
              icon="hugeicons:copy-01"
              onClick={() => {
                copy(content)
                RootStore.Get(ToastPlugin).success(i18n.t('operation-success'))
              }}
              size={18}
              containerSize={24}
            />
          </div>
        </div>
      )}
    </motion.div>
  );
});

const AiMessage = memo(({ content, withoutAnimation = false, withStreamAnimation = false, id, metadata, shareMode = false, isStreaming = false }:
  {
    content: string, withoutAnimation?: boolean, withStreamAnimation?: boolean, id?: number,
    metadata?: AssisantMessageMetadata,
    shareMode?: boolean,
    isStreaming?: boolean
  }) => {
  const isMobile = useMediaQuery('(max-width: 768px)');

  return (
    <>
      {content.length > 0 && (
        <motion.div
          className={`group ${shareMode ? 'mb-2' : ''}`}
          initial={withoutAnimation ? {} : { opacity: 0, y: 20 }}
          exit={withoutAnimation ? {} : { opacity: 0, y: -20 }}
          animate={withoutAnimation ? {} : { opacity: 1, y: 0 }}
          transition={withoutAnimation ? {} : { duration: 0.3, ease: "easeOut" }}
        >
          <>
            {
              !!metadata?.notes?.length && (
                <Popover placement="bottom-start">
                  <PopoverTrigger>
                    <Button
                      size="sm"
                      radius='lg'
                      variant="flat"
                      className="w-fit my-2"
                      startContent={<Icon icon="hugeicons:file-02" width="14" height="14" />}
                    >
                      <span className="text-xs">
                        {i18n.t('reference-notes', { count: metadata.notes.length })} ({metadata.notes.length})
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="overflow-y-auto">
                    <ScrollArea className="flex flex-col gap-2 p-2 h-[400px]" onBottom={() => { }}>
                      {
                        //@ts-ignore
                        metadata?.notes?.map((item: BlinkoItem, index: number) => (
                          <BlinkoCard key={item.id || index} className='w-[300px] md:w-[600px]' blinkoItem={item!} withoutHoverAnimation />
                        ))
                      }
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              )
            }
          </>

          <div className="max-w-[100%] px-2 py-1 rounded-xl">
            <MarkdownRender content={content} largeSpacing={true} />
          </div>
          {
            !shareMode && !isStreaming && (
              <div className={`${isMobile ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-200 mb-4`}>
                <div className="flex gap-2 backdrop-blur-sm rounded-full p-1 items-center">
                  <IconButton
                    tooltip={i18n.t('add-to-blinko')}
                    icon="basil:lightning-solid"
                    classNames={{
                      icon: 'text-yellow-500'
                    }}
                    onClick={() => {
                      RootStore.Get(BlinkoStore).upsertNote.call({
                        content: content,
                        type: NoteType.BLINKO,
                      })
                    }}
                    size={20}
                    containerSize={25}
                  />

                  <IconButton
                    tooltip={i18n.t('add-to-note')}
                    icon="solar:notes-minimalistic-bold-duotone"
                    classNames={{
                      icon: 'text-blue-500'
                    }}
                    onClick={() => {
                      RootStore.Get(BlinkoStore).upsertNote.call({
                        content: content,
                        type: NoteType.NOTE
                      })
                    }}
                    size={20}
                    containerSize={25}
                  />

                  <IconButton
                    tooltip={i18n.t('copy')}
                    icon="hugeicons:copy-01"
                    onClick={() => {
                      copy(content)
                      RootStore.Get(ToastPlugin).success(i18n.t('operation-success'))
                    }}
                    size={20}
                    containerSize={25}
                  />
                  {
                    !!id && <IconButton
                      tooltip={i18n.t('refresh')}
                      icon="solar:refresh-outline"
                      onClick={() => {
                        RootStore.Get(AiStore).regenerate(id)
                      }}
                      size={20}
                      containerSize={25}
                    />
                  }
                  <IconButton
                    tooltip={i18n.t('share-conversation')}
                    icon="hugeicons:share-05"
                    onClick={async () => {
                      const aiStore = RootStore.Get(AiStore);
                      if (aiStore.currentConversation.value) {
                        try {
                          // First enable sharing for this conversation
                          await api.conversation.toggleShare.mutate({
                            id: aiStore.currentConversation.value.id,
                            isShare: true
                          });

                          // Create a longer, more aesthetically pleasing share ID
                          const conversationId = aiStore.currentConversation.value.id?.toString();
                          const shareData = `blinko-ai-share-${conversationId}`;
                          const encodedId = btoa(shareData);
                          const shareUrl = getBlinkoEndpoint(`/ai-share/${encodedId}`)
                          copy(shareUrl);
                          RootStore.Get(ToastPlugin).success(i18n.t('share-link-copied'));
                        } catch (error) {
                          console.error('Failed to share conversation:', error);
                          RootStore.Get(ToastPlugin).error(i18n.t('operation-failed'));
                        }
                      }
                    }}
                    size={20}
                    containerSize={25}
                  />

                  {
                    !!metadata?.usage?.totalTokens && <div className="ml-auto text-desc text-xs font-bold select-none line-clamp-1">
                      {i18n.t('total-tokens')}: {metadata?.usage?.totalTokens} | {i18n.t('first-char-delay')}: {metadata?.fristCharDelay}ms
                    </div>
                  }

                </div>
              </div>)
          }
        </motion.div >
      )}
    </>
  );
});

// Streaming message component with throttled rendering to reduce MarkdownRender updates
const StreamingAiMessage = observer(({ shareMode = false }: { shareMode?: boolean }) => {
  const aiStore = RootStore.Get(AiStore);
  const content = aiStore.currentMessageResult.content;
  const metadata = aiStore.currentMessageResult;
  const id = aiStore.currentMessageResult.id;

  // Throttled content for markdown rendering
  const [throttledContent, setThrottledContent] = useState('');
  const lastUpdateRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    // Update every 80ms to balance smoothness and performance
    if (now - lastUpdateRef.current >= 80) {
      setThrottledContent(content);
      lastUpdateRef.current = now;
    } else {
      // Ensure final content gets rendered
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        setThrottledContent(content);
        lastUpdateRef.current = Date.now();
      });
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [content]);

  // Ensure complete content is displayed when streaming ends
  useEffect(() => {
    if (!aiStore.isAnswering && content) {
      setThrottledContent(content);
    }
  }, [aiStore.isAnswering, content]);

  if (!throttledContent) return null;

  return (
    <AiMessage
      content={throttledContent}
      withStreamAnimation
      metadata={metadata}
      id={id}
      shareMode={shareMode}
      isStreaming={aiStore.isAnswering}
    />
  );
});

export const BlinkoChatBox = observer(({ shareMode = false }: { shareMode?: boolean } = {}) => {
  const aiStore = RootStore.Get(AiStore)
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomAnchorRef = useRef<HTMLDivElement>(null)
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Refs for tracking scroll state
  const shouldAutoScrollRef = useRef(true)
  const lastContentLengthRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (containerRef.current && shouldAutoScrollRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [])

  // Use IntersectionObserver to detect if bottom anchor is visible
  useEffect(() => {
    const bottomAnchor = bottomAnchorRef.current
    const container = containerRef.current
    if (!bottomAnchor || !container) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting) {
          // Bottom anchor visible, resume auto-scroll
          shouldAutoScrollRef.current = true
        }
      },
      {
        root: container,
        threshold: 0.1,
      }
    )

    observer.observe(bottomAnchor)
    return () => observer.disconnect()
  }, [])

  // Handle scroll event - detect upward scroll to stop auto-scrolling
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return

    const currentScrollTop = containerRef.current.scrollTop

    // User scrolled up more than 10px, stop auto-scroll
    if (currentScrollTop < lastScrollTopRef.current - 10) {
      shouldAutoScrollRef.current = false
    }

    lastScrollTopRef.current = currentScrollTop
  }, [])

  // Watch message list changes - scroll on new messages
  useEffect(() => {
    const messagesCount = aiStore.currentConversation.value?.messages?.length || 0
    if (messagesCount > 0) {
      scrollToBottom()
    }
  }, [aiStore.currentConversation.value?.messages?.length, scrollToBottom])

  // Watch streaming content changes - throttle scroll with RAF
  useEffect(() => {
    const currentLength = aiStore.currentMessageResult.content.length

    if (currentLength > lastContentLengthRef.current && shouldAutoScrollRef.current) {
      // Cancel previous RAF to avoid duplicate scrolls
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
      }
      rafIdRef.current = requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight
        }
      })
    }

    lastContentLengthRef.current = currentLength

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [aiStore.currentMessageResult.content.length])

  // Reset state when switching conversations
  useEffect(() => {
    shouldAutoScrollRef.current = true
    lastContentLengthRef.current = 0
    lastScrollTopRef.current = 0
    setTimeout(scrollToBottom, 50)
  }, [aiStore.currentConversationId, scrollToBottom])

  const handleEditMessage = (id: number, content: string) => {
    if (shareMode) return; // Disable editing in share mode

    RootStore.Get(DialogStore).setData({
      isOpen: true,
      size: '2xl',
      title: i18n.t('edit-message'),
      content: (
        <EditMessageContent
          initialContent={content}
          onConfirm={(editedContent) => {
            aiStore.editUserMessage(id, editedContent);
          }}
        />
      )
    });
  }

  // Get the first message time for header display
  const firstMessageTime = aiStore.currentConversation.value?.messages?.[0]?.createdAt?.toLocaleString() || '';

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto overflow-x-hidden"
    >

      {/* Mobile top spacing */}
      {isMobile && <div className="h-16"></div>}

      <div className="flex flex-col p-0 md:p-2 relative min-h-full w-[95%] md:w-[78%] mx-auto">
        {/* Flex spacer */}
        <div className="flex-grow" />

        {/* Chat time header */}
        {firstMessageTime && (
          <div className="text-center text-desc mb-4 text-xs">
            {firstMessageTime}
          </div>
        )}

        <AnimatePresence>
          {
            (() => {
              const systemMessage = aiStore.currentConversation.value?.messages.find((item) => item.role == 'system');
              return systemMessage && (
                <div className="mx-auto text-desc text-xs text-center font-bold select-none line-clamp-1 p-3 border-2 border-ignore rounded-lg">
                  {systemMessage.content}
                </div>
              );
            })()
          }
          {
            aiStore.currentConversation.value?.messages.map((item) => (
              item.role == 'user' ? (
                <UserMessage
                  key={`user-${item.id}`}
                  content={item.content}
                  time={item.createdAt.toLocaleString()}
                  id={item.id}
                  onEdit={handleEditMessage}
                  shareMode={shareMode}
                />
              ) : item.role == 'assistant' ? (
                <AiMessage
                  key={`assistant-${item.id}`}
                  id={item.id}
                  metadata={item.metadata as AssisantMessageMetadata}
                  content={item.content}
                  shareMode={shareMode}
                />
              ) : null
            ))
          }

          {/* Loading: Show only when last message is from user and AI is answering but has no content yet */}
          {
            aiStore.isAnswering &&
            !aiStore.currentMessageResult.content &&
            aiStore.currentConversation.value?.messages?.at(-1)?.role === 'user' && (
              <Icon className="text-desc" icon="eos-icons:three-dots-loading" width="40" height="40" />
            )
          }


          {
            aiStore.currentMessageResult.toolCalls.length > 0 && (
              <div className="my-2">
                <StreamToolRenderer
                  toolCalls={aiStore.currentMessageResult.toolCalls}
                  toolResults={aiStore.currentMessageResult.toolResults}
                />
              </div>
            )
          }

          <StreamingAiMessage shareMode={shareMode} />
        </AnimatePresence>

        {/* Bottom anchor for scroll detection */}
        <div ref={bottomAnchorRef} className="h-4" />
      </div>
    </div>
  )
})