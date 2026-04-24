import { observer } from "mobx-react-lite";
import { BlinkoStore } from '@/store/blinkoStore';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Button, DatePicker } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, ContextMenuItem } from '@/components/Common/ContextMenu';
import { Icon } from '@/components/Common/Iconify/icons';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import { RootStore } from "@/store";
import { DialogStore } from "@/store/module/Dialog";
import { BlinkoEditor } from "../BlinkoEditor";
import { useEffect, useState } from "react";
import { NoteType } from "@shared/lib/types";
import { AiStore } from "@/store/aiStore";
import { parseAbsoluteToLocal } from "@internationalized/date";
import i18n from "@/lib/i18n";
import { BlinkoShareDialog } from "../BlinkoShareDialog";
import { BaseStore } from "@/store/baseStore";
import { PluginApiStore } from "@/store/plugin/pluginApiStore";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import { Note } from "@shared/lib/types";
import { BlinkoCard } from "../BlinkoCard";
import { useLocation } from "react-router-dom";
import { ShowCommentDialog } from "../BlinkoCard/commentButton";
import { useMediaQuery } from "usehooks-ts";
import { FocusEditorFixMobile } from "@/components/Common/Editor/editorUtils";


export const ShowEditTimeModel = (showExpired: boolean = false) => {
  const blinko = RootStore.Get(BlinkoStore)
  RootStore.Get(DialogStore).setData({
    size: 'sm' as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: false,
    showOnlyContentCloseButton: true,
    content: () => {
      const [createdAt, setCreatedAt] = useState(blinko.curSelectedNote?.createdAt ?
        parseAbsoluteToLocal(blinko.curSelectedNote.createdAt.toISOString()) : null);

      const [updatedAt, setUpdatedAt] = useState(blinko.curSelectedNote?.updatedAt ?
        parseAbsoluteToLocal(blinko.curSelectedNote.updatedAt.toISOString()) : null);

      const [expireAt, setExpireAt] = useState(blinko.curSelectedNote?.metadata?.expireAt ?
        parseAbsoluteToLocal(new Date(blinko.curSelectedNote.metadata.expireAt).toISOString()) : null);

      const handleSave = () => {
        if (showExpired) {
          // Handle expired date save
          const existingMetadata = blinko.curSelectedNote?.metadata || {};
          
          blinko.upsertNote.call({
            id: blinko.curSelectedNote?.id,
            metadata: {
              ...existingMetadata,
              expireAt: expireAt ? expireAt.toDate().toISOString() : null
            }
          });
        } else {
          // Handle created/updated date save
          if (!createdAt || !updatedAt) return;

          blinko.upsertNote.call({
            id: blinko.curSelectedNote?.id,
            createdAt: createdAt.toDate(),
            updatedAt: updatedAt.toDate()
          });
        }

        RootStore.Get(DialogStore).close();
      }

      return <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 p-4">
          {showExpired ? (
            // Show expired date picker for TODO
            <>
              <DatePicker
                label={i18n.t('expiry-time')}
                value={expireAt}
                onChange={setExpireAt}
                labelPlacement="outside"
                showMonthAndYearPickers
                granularity="second"
                hideTimeZone
              />
              
              {/* Quick time selection buttons */}
              <div className="flex flex-col gap-2">
                <div className="text-sm text-gray-600 font-medium">{i18n.t('quick-select') || 'Quick Select'}:</div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                      setExpireAt(parseAbsoluteToLocal(tomorrow.toISOString()));
                    }}
                  >
                    {i18n.t('1-day') || '1 Day'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                      setExpireAt(parseAbsoluteToLocal(nextWeek.toISOString()));
                    }}
                  >
                    {i18n.t('1-week') || '1 Week'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
                      setExpireAt(parseAbsoluteToLocal(nextMonth.toISOString()));
                    }}
                  >
                    {i18n.t('1-month') || '1 Month'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    color="warning"
                    onPress={() => {
                      setExpireAt(null);
                    }}
                  >
                    {i18n.t('cancel')}
                  </Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  color="primary"
                  className="flex-1"
                  onPress={handleSave}
                >
                  {i18n.t('save')}
                </Button>
              </div>
            </>
          ) : (
            // Show created/updated date pickers
            <>
              <DatePicker
                label={i18n.t('created-at')}
                value={createdAt}
                onChange={setCreatedAt}
                labelPlacement="outside"
                granularity="second"
                hideTimeZone
              />
              <DatePicker
                label={i18n.t('updated-at')}
                value={updatedAt}
                onChange={setUpdatedAt}
                labelPlacement="outside"
                granularity="second"
                hideTimeZone
              />
              <Button
                color="primary"
                className="mt-2"
                onPress={handleSave}
              >
                {i18n.t('save')}
              </Button>
            </>
          )}
        </div>
      </div>
    }
  })
}

export const ShowEditBlinkoModel = (size: string = '2xl', mode: 'create' | 'edit' = 'edit', initialData?: { file?: File, text?: string }) => {
  const blinko = RootStore.Get(BlinkoStore)
  RootStore.Get(DialogStore).setData({
    size: size as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: false,
    showOnlyContentCloseButton: true,
    content: <BlinkoEditor isInDialog mode={mode} initialData={initialData} key={`editor-key-${mode}`} onSended={() => {
      RootStore.Get(DialogStore).close()
      blinko.isCreateMode = false
    }} />
  })
}

const handleEdit = (isDetailPage: boolean) => {
  ShowEditBlinkoModel(isDetailPage ? '5xl' : '5xl')
  FocusEditorFixMobile()
}

const handleMultiSelect = () => {
  const blinko = RootStore.Get(BlinkoStore)
  blinko.isMultiSelectMode = true
  blinko.onMultiSelectNote(blinko.curSelectedNote?.id!)
}

const handleSelectAll = () => {
  const blinko = RootStore.Get(BlinkoStore)
  blinko.isMultiSelectMode = true

  const currentPath = new URLSearchParams(window.location.search).get('path');
  let items: Array<{ id?: number | null }> | undefined;

  if (currentPath === 'notes') {
    items = blinko.noteOnlyList.value;
  } else if (currentPath === 'todo') {
    items = blinko.todoList.value;
  } else if (currentPath === 'archived') {
    items = blinko.archivedList.value;
  } else if (currentPath === 'trash') {
    items = blinko.trashList.value;
  } else if (currentPath === 'all') {
    items = blinko.noteList.value;
  } else {
    items = blinko.blinkoList.value;
  }

  const ids = (items || [])
    .map(n => n.id)
    .filter((id): id is number => typeof id === 'number');

  // Assign directly to avoid toggle side-effects
  blinko.curMultiSelectIds = Array.from(new Set(ids));
}

const handleTop = () => {
  const blinko = RootStore.Get(BlinkoStore)
  blinko.upsertNote.call({
    id: blinko.curSelectedNote?.id,
    isTop: !blinko.curSelectedNote?.isTop
  })
}

const handlePublic = () => {
  const blinko = RootStore.Get(BlinkoStore)
  RootStore.Get(DialogStore).setData({
    size: 'md' as any,
    isOpen: true,
    title: i18n.t('share'),
    isDismissable: false,
    content: <BlinkoShareDialog defaultSettings={{
      shareUrl: blinko.curSelectedNote?.shareEncryptedUrl ? window.location.origin + '/share/' + blinko.curSelectedNote?.shareEncryptedUrl : undefined,
      expiryDate: blinko.curSelectedNote?.shareExpiryDate ?? undefined,
      password: blinko.curSelectedNote?.sharePassword ?? '',
      isShare: blinko.curSelectedNote?.isShare
    }} />
  })

  // blinko.upsertNote.call({
  //   id: blinko.curSelectedNote?.id,
  //   isShare: !blinko.curSelectedNote?.isShare
  // })
}

const handleArchived = () => {
  const blinko = RootStore.Get(BlinkoStore)
  if (blinko.curSelectedNote?.isRecycle) {
    return blinko.upsertNote.call({
      id: blinko.curSelectedNote?.id,
      isRecycle: false,
      isArchived: false
    })
  }

  if (blinko.curSelectedNote?.isArchived) {
    return blinko.upsertNote.call({
      id: blinko.curSelectedNote?.id,
      isArchived: false,
    })
  }

  if (!blinko.curSelectedNote?.isArchived) {
    return blinko.upsertNote.call({
      id: blinko.curSelectedNote?.id,
      isArchived: true
    })
  }
}

const handleAITag = () => {
  const blinko = RootStore.Get(BlinkoStore)
  const aiStore = RootStore.Get(AiStore)
  aiStore.autoTag.call(blinko.curSelectedNote?.id!, blinko.curSelectedNote?.content!)
}

const handleTrash = () => {
  const blinko = RootStore.Get(BlinkoStore)
  PromiseCall(api.notes.trashMany.mutate({ ids: [blinko.curSelectedNote?.id!] })).then(() => {
    blinko.updateTicker++
  })
}

const handleDelete = async () => {
  const blinko = RootStore.Get(BlinkoStore)
  PromiseCall(api.notes.deleteMany.mutate({ ids: [blinko.curSelectedNote?.id!] })).then(() => {
    api.ai.embeddingDelete.mutate({ id: blinko.curSelectedNote?.id! })
    blinko.updateTicker++
  })
}

const handleRelatedNotes = async () => {
  const blinko = RootStore.Get(BlinkoStore);
  const dialog = RootStore.Get(DialogStore);
  const toast = RootStore.Get(ToastPlugin);

  try {
    const noteId = blinko.curSelectedNote?.id;
    if (!noteId) return;
    toast.loading(i18n.t('loading'));
    const relatedNotes = await api.notes.relatedNotes.query({ id: noteId });
    toast.dismiss();
    if (relatedNotes.length === 0) {
      toast.error(i18n.t('no-related-notes-found'));
      return;
    }

    dialog.setData({
      size: 'lg' as any,
      isOpen: true,
      title: i18n.t('related-notes'),
      isDismissable: true,
      content: () => {
        return (
          <div className="flex flex-col gap-2 max-h-[70vh] overflow-y-auto">
            {relatedNotes.map((note: Note) => (
              <BlinkoCard key={note.id} blinkoItem={note} withoutHoverAnimation/>
            ))}
          </div>
        );
      }
    });
  } catch (error) {
    toast.dismiss();
    toast.error(i18n.t('operation-failed'));
    console.error("Failed to fetch related notes:", error);
  }
};

const handleComment = () => {
  const blinko = RootStore.Get(BlinkoStore)
  if (blinko.curSelectedNote?.id) {
    ShowCommentDialog(blinko.curSelectedNote.id)
  }
}

export const EditItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="tabler:edit" width="20" height="20" />
    <div>{t('edit')}</div>
  </div>
})

export const MutiSelectItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2" >
    <Icon icon="mingcute:multiselect-line" width="20" height="20" />
    <div>{t('multiple-select')}</div>
  </div>
})

export const SelectAllItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="lucide:square-check" width="20" height="20" />
    <div>{t('select-all')}</div>
  </div>
})

export const ConvertItemFunction = () => {
  const blinko = RootStore.Get(BlinkoStore)
  blinko.upsertNote.call({
    id: blinko.curSelectedNote?.id,
    type: blinko.curSelectedNote?.type == NoteType.NOTE ? NoteType.BLINKO : NoteType.NOTE
  })
}

export const ConvertItem = observer(() => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore)
  return <div className="flex items-start gap-2">
    <Icon icon="ri:exchange-2-line" width="20" height="20" />
    <div>{t('convert-to')} {blinko.curSelectedNote?.type == NoteType.NOTE ?
      <span className='text-yellow-500'>{t('blinko')}</span> : <span className='text-blue-500'>{t('note')}</span>}</div>
  </div>
})

export const TopItem = observer(() => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore)
  return <div className="flex items-start gap-2">
    <Icon icon="lets-icons:pin" width="20" height="20" />
    <div>{blinko.curSelectedNote?.isTop ? t('cancel-top') : t('top')}</div>
  </div>
})

export const PublicItem = observer(() => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore)
  return <div className="flex items-start gap-2">
    <Icon icon="ic:outline-share" width="20" height="20" />
    <div>{t('share')}</div>
  </div>
})

export const ArchivedItem = observer(() => {
  const { t } = useTranslation();
  const blinko = RootStore.Get(BlinkoStore)
  return <div className="flex items-start gap-2">
    <Icon icon="eva:archive-outline" width="20" height="20" />
    {blinko.curSelectedNote?.isArchived || blinko.curSelectedNote?.isRecycle ? t('recovery') : t('archive')}
  </div>
})

export const AITagItem = observer(() => {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
      <Icon icon="majesticons:tag-line" width="20" height="20" />
      <div>{t('ai-tag')}</div>
    </div>
  );
});

export const RelatedNotesItem = observer(() => {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
      <Icon icon="mdi:note-search-outline" width="20" height="20" />
      <div>{t('related-notes')}</div>
    </div>
  );
});

export const CommentItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="akar-icons:comment" width="20" height="20" />
    <div>{t('comment')}</div>
  </div>
})

export const TrashItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2 text-red-500">
    <Icon icon="mingcute:delete-2-line" width="20" height="20" />
    <div>{t('trash')}</div>
  </div>
})

export const DeleteItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2 text-red-500">
    <Icon icon="mingcute:delete-2-line" width="20" height="20" />
    <div>{t('delete')}</div>
  </div>
})

export const EditTimeItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="mdi:clock-edit-outline" width="20" height="20" />
    <div>{t('edit-time')}</div>
  </div>
})

export const BlinkoRightClickMenu = observer(() => {
  const [isDetailPage, setIsDetailPage] = useState(false)
  const location = useLocation()
  
  const blinko = RootStore.Get(BlinkoStore)
  const pluginApi = RootStore.Get(PluginApiStore)
  const isPc = useMediaQuery('(min-width: 768px)')

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  return <ContextMenu className='font-bold' id="blink-item-context-menu" hideOnLeave={false} animation="zoom">
    <ContextMenuItem onClick={() => handleEdit(isDetailPage)}>
      <EditItem />
    </ContextMenuItem>

    {!isDetailPage ? (
      <>
        <ContextMenuItem onClick={() => handleMultiSelect()}>
          <MutiSelectItem />
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleSelectAll()}>
          <SelectAllItem />
        </ContextMenuItem>
      </>
    ) : <></>}

    <ContextMenuItem onClick={() => ShowEditTimeModel()}>
      <EditTimeItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={ConvertItemFunction}>
      <ConvertItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={handleTop}>
      <TopItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={handleArchived}>
      <ArchivedItem />
    </ContextMenuItem>

    {!blinko.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handlePublic}>
      <PublicItem />
    </ContextMenuItem>
    ) : <></>}

    {!isPc ? (
      <ContextMenuItem onClick={handleComment}>
        <CommentItem />
      </ContextMenuItem>
    ) : <></>}

    {blinko.config.value?.mainModelId ? (
      <ContextMenuItem onClick={handleAITag}>
        <AITagItem />
      </ContextMenuItem>
    ) : <></>}

    {blinko.config.value?.mainModelId ? (
      <ContextMenuItem onClick={handleRelatedNotes}>
        <RelatedNotesItem />
      </ContextMenuItem>
    ) : <></>}

    {pluginApi.customRightClickMenus.map((menu) => (
      <ContextMenuItem key={menu.name} onClick={() => menu.onClick(blinko.curSelectedNote!)} disabled={menu.disabled}>
        <div className="flex items-start gap-2">
          {menu.icon && <Icon icon={menu.icon} width="20" height="20" />}
          <div>{menu.label}</div>
        </div>
      </ContextMenuItem>
    ))}

    {!blinko.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handleTrash}>
        <TrashItem />
      </ContextMenuItem>
    ) : <></>}

    {blinko.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handleDelete}>
        <DeleteItem />
      </ContextMenuItem>
    ) : <></>}
  </ContextMenu>
})

export const LeftCickMenu = observer(({ onTrigger, className }: { onTrigger: () => void, className: string }) => {
  const [isDetailPage, setIsDetailPage] = useState(false)
  const blinko = RootStore.Get(BlinkoStore)
  const pluginApi = RootStore.Get(PluginApiStore)
  const location = useLocation()
  const isPc = useMediaQuery('(min-width: 768px)')

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  const disabledKeys = isDetailPage ? ['MutiSelectItem'] : []

  return <Dropdown onOpenChange={e => onTrigger()}>
    <DropdownTrigger >
      <div onClick={onTrigger} className={`${className} text-desc hover:text-primary cursor-pointer hover:scale-1.3 !transition-all`}>
        <Icon icon="fluent:more-vertical-16-regular" width="16" height="16" />
      </div>
    </DropdownTrigger>
    <DropdownMenu aria-label="Static Actions" disabledKeys={disabledKeys}>
      <DropdownItem key="EditItem" onPress={() => handleEdit(isDetailPage)}><EditItem /></DropdownItem>
      {!isDetailPage ? (
        <>
          <DropdownItem key="MutiSelectItem" onPress={() => handleMultiSelect()}>
            <MutiSelectItem />
          </DropdownItem>
          <DropdownItem key="SelectAllItem" onPress={() => handleSelectAll()}>
            <SelectAllItem />
          </DropdownItem>
        </>
      ) : null}
      <DropdownItem key="EditTimeItem" onPress={() => ShowEditTimeModel()}> <EditTimeItem /></DropdownItem>
      <DropdownItem key="ConvertItem" onPress={ConvertItemFunction}> <ConvertItem /></DropdownItem>
      <DropdownItem key="TopItem" onPress={handleTop}> <TopItem />  </DropdownItem>
      <DropdownItem key="ArchivedItem" onPress={handleArchived}>
        <ArchivedItem />
      </DropdownItem>

      {!blinko.curSelectedNote?.isRecycle ? (
        <DropdownItem key="ShareItem" onPress={handlePublic}> 
          <PublicItem />  
        </DropdownItem>
      ) : <></>}

      {!isPc ? (
        <DropdownItem key="CommentItem" onPress={handleComment}>
          <CommentItem />
        </DropdownItem>
      ) : <></>}

      {blinko.config.value?.mainModelId ? (
        <DropdownItem key="AITagItem" onPress={handleAITag}>
          <AITagItem />
        </DropdownItem>
      ) : <></>}

      {blinko.config.value?.mainModelId ? (
        <DropdownItem key="RelatedNotesItem" onPress={handleRelatedNotes}>
          <RelatedNotesItem />
        </DropdownItem>
      ) : <></>}

      {
        pluginApi.customRightClickMenus.length > 0 ?
          <>
            {
              pluginApi.customRightClickMenus.map((menu) => (
                <DropdownItem key={menu.name} onPress={() => menu.onClick(blinko.curSelectedNote!)}>
                  <div className="flex items-start gap-2">
                    {menu.icon && <Icon icon={menu.icon} width="20" height="20" />}
                    <div>{menu.label}</div>
                  </div>
                </DropdownItem>
              ))
            }
          </> :
          <></>
      }

      {!blinko.curSelectedNote?.isRecycle ? (
        <DropdownItem key="TrashItem" onPress={handleTrash}>
          <TrashItem />
        </DropdownItem>
      ) : <></>}

      {blinko.curSelectedNote?.isRecycle ? (
        <DropdownItem key="DeleteItem" className="text-danger" onPress={handleDelete}>
          <DeleteItem />
        </DropdownItem>
      ) : <></>}

    </DropdownMenu>
  </Dropdown>
})