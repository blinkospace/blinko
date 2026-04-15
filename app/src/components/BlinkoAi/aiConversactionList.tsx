import { RootStore } from "@/store/root"
import { AiStore } from "@/store/aiStore"
import { observer } from "mobx-react-lite"
import { useEffect, useState } from "react"
import { LoadingAndEmpty } from "../Common/LoadingAndEmpty"
import { DialogStore } from "@/store/module/Dialog"
import { IconButton } from "../Common/Editor/Toolbar/IconButton"
import { ScrollArea } from "../Common/ScrollArea"
import { api } from "@/lib/trpc"
import { PromiseCall } from "@/store/standard/PromiseState"
import { useTranslation } from "react-i18next"
import { useMediaQuery } from "usehooks-ts"

export const AiConversactionList = observer(() => {
  const aiStore = RootStore.Get(AiStore)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const { t } = useTranslation()
  const isMobile = useMediaQuery('(max-width: 768px)')
  
  useEffect(() => {
    aiStore.conversactionList.resetAndCall({})
  }, [])

  const handleUpdate = async (item) => {
    await PromiseCall(api.conversation.update.mutate({
      id: item.id,
      title: newTitle
    }))
    aiStore.conversactionList.resetAndCall({})
    setEditingId(null)
  };
  
  const handleDelete = async (item) => {
    await PromiseCall(api.conversation.delete.mutate({
      id: item.id
    }))
    if (aiStore.currentConversationId === item.id) {
      aiStore.newChat()
    }
    aiStore.conversactionList.resetAndCall({})
  }
  return <div className="px-2 pb-6">
    <LoadingAndEmpty
      isLoading={aiStore.conversactionList.loading.value}
      isEmpty={aiStore.conversactionList.value?.length === 0}
    />
    <ScrollArea
      onBottom={() => {
        aiStore.conversactionList.callNextPage({})
      }}
      className="flex flex-col gap-2 cursor-pointer -mt-2 max-h-[400px]">
      {aiStore.conversactionList.value?.map(item => (
        <div
          className="group flex items-center justify-between p-2 rounded-md hover:bg-hover relative"
          key={item.id}
        >
          {editingId === item.id ? (
            <input
              autoFocus
              className="flex-1 bg-transparent outline-none"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUpdate(item);
                if (e.key === 'Escape') setEditingId(null);
              }}
              onBlur={() => handleUpdate(item)}
            />
          ) : (
            <div
              className="flex-1 truncate max-w-[calc(100%-80px)] cursor-pointer"
              onClick={() => {
                if (editingId !== null) return;
                aiStore.currentConversationId = item.id;
                aiStore.currentConversation.call();
                aiStore.isChatting = true;
                RootStore.Get(DialogStore).close();
              }}
            >
              {item.title || t('no-title')}
            </div>
          )}

          <div className={`${isMobile ? 'flex' : 'hidden group-hover:flex'} items-center gap-1 absolute right-2 top-1/2 -translate-y-1/2 px-2 rounded`}>
            <IconButton
              onClick={(e) => {
                e.stopPropagation();
                setEditingId(item.id);
                setNewTitle(item.title);
              }}
              tooltip={t('rename')}
              icon="hugeicons:edit-02"
              size={20}
              containerSize={30}
            />
            <IconButton
              classNames={{
                icon: 'text-danger/60 hover:text-danger'
              }}
              onClick={(e) => {
                e.stopPropagation()
                handleDelete(item)
              }}
              tooltip={t('delete')}
              icon="hugeicons:delete-02"
            />
          </div>
        </div>
      ))}
    </ScrollArea>
  </div>
})