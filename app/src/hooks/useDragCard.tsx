import { useState, useRef, useEffect } from 'react';
import { DragEndEvent, DragStartEvent, MouseSensor, TouchSensor, useSensor, useSensors, closestCenter, useDroppable, useDraggable } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/trpc';
import { BlinkoCard } from '@/components/BlinkoCard';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';

interface UseDragCardProps {
  notes: any[] | undefined;
  onNotesUpdate?: (notes: any[]) => void;
  activeId: number | null;
  setActiveId: (id: number | null) => void;
  insertPosition: number | null;
  setInsertPosition: (position: number | null) => void;
  isDragForbidden: boolean;
  setIsDragForbidden: (forbidden: boolean) => void;
}

export const useDragCard = ({ notes, onNotesUpdate, activeId, setActiveId, insertPosition, setInsertPosition, isDragForbidden, setIsDragForbidden }: UseDragCardProps) => {
  const [localNotes, setLocalNotes] = useState<any[]>([]);
  const isDraggingRef = useRef(false);
  const blinko = RootStore.Get(BlinkoStore);

  // Update local notes when the list changes (but not during drag operations)
  useEffect(() => {
    if (notes && !isDraggingRef.current) {
      // Sort by isTop first (desc), then by sortOrder (asc) to maintain the correct order from the database
      const sortedNotes = [...notes].sort((a, b) => {
        // First, sort by isTop (pinned notes first)
        if (a.isTop !== b.isTop) {
          return b.isTop ? 1 : -1;
        }
        // Then sort by sortOrder
        return a.sortOrder - b.sortOrder;
      });
      setLocalNotes(sortedNotes);
      onNotesUpdate?.(sortedNotes);
    }
    else if (!notes) {
      setLocalNotes([]);
    }
  }, [notes]);

  // Disable sensors when fullscreen editor is open
  const shouldEnableDrag = blinko.fullscreenEditorNoteId === null;
  
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: shouldEnableDrag ? {
        delay: 250,
        tolerance: 5,
      } : {
        // Impossible to activate
        delay: 999999,
        distance: 999999,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: shouldEnableDrag ? {
        delay: 250,
        tolerance: 5,
      } : {
        // Impossible to activate
        delay: 999999,
        distance: 999999,
      },
    })
  );

  const handleDragStart = (event: any) => {
    // Check if fullscreen editor is open, if so, prevent drag
    const blinko = RootStore.Get(BlinkoStore);
    if (blinko.fullscreenEditorNoteId !== null) {
      return; // Don't start drag if fullscreen editor is open
    }
    
    setActiveId(event.active.id as number);
    isDraggingRef.current = true;
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    isDraggingRef.current = false;

    if (over) {
      const dropTargetId = over.id.toString();
      const dragItemId = active.id;

      // Extract the note ID from the droppable ID
      const targetNoteId = parseInt(dropTargetId.replace('drop-', ''));

      if (dragItemId !== targetNoteId) {
        const oldIndex = localNotes.findIndex((note) => note.id === dragItemId);
        const newIndex = localNotes.findIndex((note) => note.id === targetNoteId);

        if (oldIndex !== -1 && newIndex !== -1) {
          const movedNote = localNotes[oldIndex];
          const targetNote = localNotes[newIndex];

          // Prevent dragging between pinned and unpinned areas
          if (movedNote.isTop !== targetNote.isTop) {
            setActiveId(null);
            setInsertPosition(null);
            return;
          }

          const newNotes = [...localNotes];
          newNotes.splice(oldIndex, 1);
          newNotes.splice(newIndex, 0, movedNote);

          // Update sortOrder only for notes in the same isTop group
          const updatedNotes = newNotes.map((note, index) => ({
            ...note,
            sortOrder: index,
          }));

          // Call the original hook's update logic
          setLocalNotes(updatedNotes);

          // Update server
          const updates = updatedNotes.map((note) => ({
            id: note.id,
            sortOrder: note.sortOrder,
          }));

          api.notes.updateNotesOrder.mutate({ updates });
        }
      }
    }

    setActiveId(null);
    setInsertPosition(null);
    setIsDragForbidden(false);
  };

  const handleDragOver = (event: any) => {
    const { active, over } = event;
    if (over && active) {
      const targetNoteId = parseInt(over.id.toString().replace('drop-', ''));
      const dragItemId = active.id;
      
      setInsertPosition(targetNoteId);
      
      // Check if dragging between different isTop states
      const draggedNote = localNotes.find((note) => note.id === dragItemId);
      const targetNote = localNotes.find((note) => note.id === targetNoteId);
      
      if (draggedNote && targetNote && draggedNote.isTop !== targetNote.isTop) {
        setIsDragForbidden(true);
      } else {
        setIsDragForbidden(false);
      }
    }
  };

  return {
    localNotes,
    sensors,
    setLocalNotes,
    isDraggingRef,
    handleDragStart,
    handleDragEnd,
    handleDragOver
  };
};

interface DraggableBlinkoCardProps {
  blinkoItem: any;
  showInsertLine?: boolean;
  insertPosition?: 'top' | 'bottom';
  isDragForbidden?: boolean;
}

export const DraggableBlinkoCard = ({ blinkoItem, showInsertLine, insertPosition, isDragForbidden }: DraggableBlinkoCardProps) => {
  const { t } = useTranslation()
  
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `drop-${blinkoItem.id}`,
  });

  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    transform,
    isDragging,
  } = useDraggable({
    id: blinkoItem.id,
  });

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
  };

  return (
    <div className="relative">
      {showInsertLine && insertPosition === 'top' && (
        <div className={`absolute -top-2 left-0 right-0 h-1 z-50 rounded-full ${isDragForbidden ? 'bg-red-500' : 'bg-blue-500'}`} />
      )}

      {/* Droppable area - always visible, shows placeholder when dragging */}
      <div
        ref={setDroppableRef}
        className={`relative
          ${isDragging ? 'bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg' : ''}
          ${isOver && isDragForbidden ? 'border-2 border-dashed !border-red-500 rounded-lg' : ''}
        `}
      >
        {/* Forbidden icon overlay when hovering over wrong area */}
        {isOver && isDragForbidden && !isDragging && (
          <div className="absolute inset-0 flex items-center justify-center z-50 bg-red-500/10 rounded-lg">
            <div className="bg-red-500 text-white rounded-full p-3">
              <Icon icon="ph:prohibit-bold" width="32" height="32" />
            </div>
          </div>
        )}
        {isDragging ? (
          <div className="flex items-center justify-center p-8 min-h-[100px]">
            <div className="text-gray-400 text-center">
              <div className="text-sm">{t('dragging')}</div>
            </div>
          </div>
        ) : (
          // Draggable area - long press to drag using dnd-kit's activationConstraint
          // When item is expanded (fullscreen editor open), don't apply drag listeners
          <div
            ref={setDraggableRef}
            style={dragStyle}
            {...(blinkoItem.isExpand ? {} : attributes)}
            {...(blinkoItem.isExpand ? {} : listeners)}
            className="cursor-default!"
          >
            <BlinkoCard blinkoItem={blinkoItem} />
          </div>
        )}
      </div>

      {showInsertLine && insertPosition === 'bottom' && (
        <div className={`absolute -bottom-2 left-0 right-0 h-1 z-50 rounded-full ${isDragForbidden ? 'bg-red-500' : 'bg-blue-500'}`} />
      )}
    </div>
  );
};