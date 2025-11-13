import { useState, useRef, useEffect } from 'react';
import { DragEndEvent, DragStartEvent, MouseSensor, TouchSensor, useSensor, useSensors, closestCenter, useDroppable, useDraggable } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/trpc';
import { BlinkoCard } from '@/components/BlinkoCard';
import { useTranslation } from 'react-i18next';

interface UseDragCardProps {
  notes: any[] | undefined;
  onNotesUpdate?: (notes: any[]) => void;
  activeId: number | null;
  setActiveId: (id: number | null) => void;
  insertPosition: number | null;
  setInsertPosition: (position: number | null) => void;
}

export const useDragCard = ({ notes, onNotesUpdate, activeId, setActiveId, insertPosition, setInsertPosition }: UseDragCardProps) => {
  const [localNotes, setLocalNotes] = useState<any[]>([]);
  const isDraggingRef = useRef(false);

  // Update local notes when the list changes (but not during drag operations)
  useEffect(() => {
    if (notes && !isDraggingRef.current) {
      // Sort by sortOrder to maintain the correct order from the database
      const sortedNotes = [...notes].sort((a, b) => a.sortOrder - b.sortOrder);
      setLocalNotes(sortedNotes);
      onNotesUpdate?.(sortedNotes);
    }
    else if (!notes) {
      setLocalNotes([]);
    }
  }, [notes]);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    })
  );

  const handleDragStart = (event: any) => {
    setActiveId(event.active.id as number);
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;

    if (over) {
      const dropTargetId = over.id.toString();
      const dragItemId = active.id;

      // Extract the note ID from the droppable ID
      const targetNoteId = parseInt(dropTargetId.replace('drop-', ''));

      if (dragItemId !== targetNoteId) {
        const oldIndex = localNotes.findIndex((note) => note.id === dragItemId);
        const newIndex = localNotes.findIndex((note) => note.id === targetNoteId);

        if (oldIndex !== -1 && newIndex !== -1) {
          const newNotes = [...localNotes];
          const [movedNote] = newNotes.splice(oldIndex, 1);
          newNotes.splice(newIndex, 0, movedNote);

          // Update sortOrder
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
  };

  const handleDragOver = (event: any) => {
    const { over } = event;
    if (over) {
      const targetNoteId = parseInt(over.id.toString().replace('drop-', ''));
      setInsertPosition(targetNoteId);
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
}

export const DraggableBlinkoCard = ({ blinkoItem, showInsertLine, insertPosition }: DraggableBlinkoCardProps) => {
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `drop-${blinkoItem.id}`,
  });
  const { t } = useTranslation()

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
        <div className="absolute -top-2 left-0 right-0 h-1 bg-blue-500 z-50 rounded-full" />
      )}

      {/* Droppable area - always visible, shows placeholder when dragging */}
      <div
        ref={setDroppableRef}
        className={`
          ${isDragging ? 'bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg' : ''}
        `}
      >
        {isDragging ? (
          <div className="flex items-center justify-center p-8 min-h-[100px]">
            <div className="text-gray-400 text-center">
              <div className="text-sm">{t('dragging')}</div>
            </div>
          </div>
        ) : (
          // Draggable area - long press to drag using dnd-kit's activationConstraint
          <div
            ref={setDraggableRef}
            style={dragStyle}
            {...attributes}
            {...listeners}
            className="cursor-default!"
          >
            <BlinkoCard blinkoItem={blinkoItem} />
          </div>
        )}
      </div>

      {showInsertLine && insertPosition === 'bottom' && (
        <div className="absolute -bottom-2 left-0 right-0 h-1 bg-blue-500 z-50 rounded-full" />
      )}
    </div>
  );
};