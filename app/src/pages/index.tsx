import { BlinkoStore } from '@/store/blinkoStore';
import { observer } from 'mobx-react-lite';
import Masonry from 'react-masonry-css';
import { useTranslation } from 'react-i18next';
import { RootStore } from '@/store';
import { BlinkoEditor } from '@/components/BlinkoEditor';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { BlinkoCard } from '@/components/BlinkoCard';
import { useMediaQuery } from 'usehooks-ts';
import { BlinkoAddButton } from '@/components/BlinkoAddButton';
import { LoadingAndEmpty } from '@/components/Common/LoadingAndEmpty';
import { useSearchParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import dayjs from '@/lib/dayjs';
import { NoteType } from '@shared/lib/types';
import { Icon } from '@/components/Common/Iconify/icons';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { useDragCard, DraggableBlinkoCard } from '@/hooks/useDragCard';

interface TodoGroup {
  displayDate: string;
  todos: any[];
}

const Home = observer(() => {
  const { t } = useTranslation();
  const isPc = useMediaQuery('(min-width: 768px)')
  const blinko = RootStore.Get(BlinkoStore)
  blinko.use()
  blinko.useQuery();
  const [searchParams] = useSearchParams();
  const isTodoView = searchParams.get('path') === 'todo';
  const isNotesView = searchParams.get('path') === 'notes';
  const isArchivedView = searchParams.get('path') === 'archived';
  const isTrashView = searchParams.get('path') === 'trash';
  const isAllView = searchParams.get('path') === 'all';
  const [activeId, setActiveId] = useState<number | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const [isDragForbidden, setIsDragForbidden] = useState<boolean>(false);

  const currentListState = useMemo(() => {
    if (isNotesView) {
      return blinko.noteOnlyList;
    } else if (isTodoView) {
      return blinko.todoList;
    } else if (isArchivedView) {
      return blinko.archivedList;
    } else if (isTrashView) {
      return blinko.trashList;
    } else if (isAllView) {
      return blinko.noteList;
    } else {
      return blinko.blinkoList;
    }
  }, [isNotesView, isTodoView, isArchivedView, isTrashView, isAllView, blinko]);

  // Use drag card hook only for non-todo views
  const { localNotes, sensors, setLocalNotes, handleDragStart, handleDragEnd, handleDragOver } = useDragCard({
    notes: isTodoView ? undefined : currentListState.value,
    activeId,
    setActiveId,
    insertPosition,
    setInsertPosition,
    isDragForbidden,
    setIsDragForbidden
  });

  const store = RootStore.Local(() => ({
    editorHeight: 30,
    get showEditor() {
      return !blinko.noteListFilterConfig.isArchived && !blinko.noteListFilterConfig.isRecycle
    },
    get showLoadAll() {
      return currentListState.isLoadAll
    }
  }))

  const todosByDate = useMemo(() => {
    if (!isTodoView || !currentListState.value) return {} as Record<string, TodoGroup>;
    const todoItems = currentListState.value;
    const groupedTodos: Record<string, TodoGroup> = {};
    todoItems.forEach(todo => {
      const date = dayjs(todo.createdAt).format('YYYY-MM-DD');
      const isToday = dayjs().isSame(dayjs(todo.createdAt), 'day');
      const isYesterday = dayjs().subtract(1, 'day').isSame(dayjs(todo.createdAt), 'day');
      let displayDate;
      if (isToday) {
        displayDate = t('today');
      } else if (isYesterday) {
        displayDate = t('yesterday');
      } else {
        displayDate = dayjs(todo.createdAt).format('MM/DD (ddd)');
      }
      if (!groupedTodos[date]) {
        groupedTodos[date] = {
          displayDate,
          todos: []
        };
      }
      groupedTodos[date].todos.push(todo);
    });
    return Object.entries(groupedTodos)
      .sort(([dateA], [dateB]) => new Date(dateB).getTime() - new Date(dateA).getTime())
      .reduce((acc, [date, data]) => {
        acc[date] = data;
        return acc;
      }, {} as Record<string, TodoGroup>);
  }, [currentListState.value, isTodoView, t]);

  return (
    <div
      style={{
        maxWidth: blinko.config.value?.maxHomePageWidth ? `${blinko.config.value?.maxHomePageWidth}px` : '100%'
      }}
      className={`p-2 md:p-0 relative h-full flex flex-col-reverse md:flex-col mx-auto w-full`}>

      {store.showEditor && isPc && !blinko.config.value?.hidePcEditor && <div className='px-2 md:px-6' >
        <BlinkoEditor mode='create' key='create-key' onHeightChange={height => {
          if (!isPc) return
          store.editorHeight = height
        }} />
      </div>}
      {(!isPc || blinko.config.value?.hidePcEditor) && <BlinkoAddButton />}

      <LoadingAndEmpty
        isLoading={currentListState.isLoading}
        isEmpty={currentListState.isEmpty}
      />

      {
        !currentListState.isEmpty &&
        <ScrollArea
          fixMobileTopBar
          onRefresh={async () => {
            await currentListState.resetAndCall({})
          }}
          onBottom={() => {
            blinko.onBottom();
          }}
          style={{ height: store.showEditor ? `calc(100% - ${(isPc ? (!store.showEditor ? store.editorHeight : 10) : 0)}px)` : '100%' }}
          className={`px-2 mt-0 md:${blinko.config.value?.hidePcEditor ? 'mt-0' : 'mt-4'} md:px-6 w-full h-full !transition-all scroll-area`}>

          {isTodoView ? (
            <div className="timeline-view relative">
              {Object.entries(todosByDate).map(([date, { displayDate, todos }]) => (
                <div key={date} className="mb-6 relative">
                  <div className="flex items-center mb-2 relative z-10">
                    <div className="w-4 h-4 rounded-sm bg-primary absolute left-[4.5px] transform translate-x-[-50%]"></div>
                    <h3 className="text-base font-bold ml-5">{displayDate}</h3>
                  </div>
                  <div className="md:pl-4">
                    {todos.map(todo => (
                      <div key={todo.id} className="mb-3">
                        <BlinkoCard blinkoItem={todo} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {Object.keys(todosByDate).length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Icon icon="mdi:clipboard-text-outline" width="48" height="48" className="mx-auto mb-2 opacity-50" />
                  <p>{t('no-data-here-well-then-time-to-write-a-note')}</p>
                </div>
              )}
            </div>
          ) : (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              >
                <Masonry
                  breakpointCols={{
                    default: blinko.config?.value?.largeDeviceCardColumns ? Number(blinko.config?.value?.largeDeviceCardColumns) : 2,
                    1280: blinko.config?.value?.mediumDeviceCardColumns ? Number(blinko.config?.value?.mediumDeviceCardColumns) : 2,
                    768: blinko.config?.value?.smallDeviceCardColumns ? Number(blinko.config?.value?.smallDeviceCardColumns) : 1
                  }}
                  className="card-masonry-grid"
                  columnClassName="card-masonry-grid_column">
                  {
                    localNotes?.map((i, index) => {
                      const showInsertLine = insertPosition === i.id && activeId !== i.id;
                      return (
                        <DraggableBlinkoCard
                          key={i.id}
                          blinkoItem={i}
                          showInsertLine={showInsertLine}
                          insertPosition="top"
                          isDragForbidden={isDragForbidden && showInsertLine}
                        />
                      );
                    })
                  }
                </Masonry>
                <DragOverlay>
                  {activeId ? (
                    <div className="rotate-3 scale-105 opacity-90 max-w-sm shadow-xl">
                      <BlinkoCard
                        blinkoItem={localNotes.find(n => n.id === activeId)}
                      />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </>
          )}

          {store.showLoadAll && <div className='select-none w-full text-center text-sm font-bold text-ignore my-4'>{t('all-notes-have-been-loaded', { items: currentListState.value?.length })}</div>}
        </ScrollArea>
      }
    </div>
  );
});

export default Home;
