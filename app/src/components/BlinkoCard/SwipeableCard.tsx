import { useState, useRef, useCallback } from 'react';
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from 'react-i18next';

interface SwipeableCardProps {
  children: React.ReactNode;
  onPin?: () => void;
  onDelete?: () => void;
  isPinned?: boolean;
  disabled?: boolean;
}

const SWIPE_THRESHOLD = 80;
const ACTION_WIDTH = 160;
const SWIPE_DIRECTION_THRESHOLD = 1.5; // Horizontal movement must be 1.5x vertical movement

export const SwipeableCard = ({ 
  children, 
  onPin, 
  onDelete, 
  isPinned = false,
  disabled = false 
}: SwipeableCardProps) => {
  const { t } = useTranslation();
  const [translateX, setTranslateX] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const isHorizontalSwipeRef = useRef<boolean | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return;
    startXRef.current = e.touches[0].clientX;
    startYRef.current = e.touches[0].clientY;
    currentXRef.current = translateX;
    isHorizontalSwipeRef.current = null;
    setIsDragging(true);
  }, [translateX, disabled]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging || disabled) return;
    
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = Math.abs(startXRef.current - currentX);
    const deltaY = Math.abs(startYRef.current - currentY);
    
    // Determine swipe direction if not already determined
    if (isHorizontalSwipeRef.current === null) {
      // Only allow horizontal swipe if horizontal movement is significantly greater than vertical
      if (deltaX > 10 && deltaX > deltaY * SWIPE_DIRECTION_THRESHOLD) {
        isHorizontalSwipeRef.current = true;
      } else if (deltaY > 10 && deltaY > deltaX * SWIPE_DIRECTION_THRESHOLD) {
        isHorizontalSwipeRef.current = false;
        // If it's a vertical swipe, stop dragging
        setIsDragging(false);
        return;
      }
    }
    
    // Only process horizontal movement if it's confirmed as horizontal swipe
    if (isHorizontalSwipeRef.current === false) {
      return;
    }
    
    const diff = startXRef.current - currentX;
    let newTranslateX = currentXRef.current - diff;
    
    // Limit the swipe range
    if (newTranslateX > 0) newTranslateX = 0;
    if (newTranslateX < -ACTION_WIDTH) newTranslateX = -ACTION_WIDTH;
    
    setTranslateX(newTranslateX);
  }, [isDragging, disabled]);

  const handleTouchEnd = useCallback(() => {
    if (!isDragging || disabled) return;
    setIsDragging(false);
    
    // Only snap if it was a horizontal swipe
    if (isHorizontalSwipeRef.current === false) {
      // Reset position if it was a vertical swipe
      setTranslateX(0);
      setIsOpen(false);
      return;
    }
    
    // Snap to open or closed position
    if (translateX < -SWIPE_THRESHOLD) {
      setTranslateX(-ACTION_WIDTH);
      setIsOpen(true);
    } else {
      setTranslateX(0);
      setIsOpen(false);
    }
  }, [translateX, isDragging, disabled]);

  const handleClose = useCallback(() => {
    setTranslateX(0);
    setIsOpen(false);
  }, []);

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPin?.();
    handleClose();
  }, [onPin, handleClose]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.();
    handleClose();
  }, [onDelete, handleClose]);

  if (disabled) {
    return <>{children}</>;
  }

  // Only show action buttons when swiping
  const showActions = translateX < 0 || isDragging;

  return (
    <div className="relative overflow-hidden rounded-large">
      {/* Action buttons container - only visible when swiping */}
      <div 
        className="absolute right-0 top-0 bottom-0 flex h-full overflow-hidden rounded-r-large"
        style={{ 
          width: ACTION_WIDTH,
          opacity: showActions ? 1 : 0,
          pointerEvents: showActions ? 'auto' : 'none',
        }}
      >
        {/* Pin button */}
        <div
          className="flex-1 flex items-center justify-center cursor-pointer transition-opacity active:opacity-80"
          style={{ backgroundColor: '#F5A623' }}
          onClick={handlePinClick}
        >
          <div className="flex flex-col items-center gap-1 text-white">
            <Icon icon="lets-icons:pin" width="24" height="24" />
            <span className="text-xs font-medium">
              {isPinned ? t('cancel-top') : t('top')}
            </span>
          </div>
        </div>
        
        {/* Delete button */}
        <div
          className="flex-1 flex items-center justify-center cursor-pointer transition-opacity active:opacity-80 rounded-r-large"
          style={{ backgroundColor: '#FF3B30' }}
          onClick={handleDeleteClick}
        >
          <div className="flex flex-col items-center gap-1 text-white">
            <Icon icon="mingcute:delete-2-line" width="24" height="24" />
            <span className="text-xs font-medium">{t('delete')}</span>
          </div>
        </div>
      </div>

      {/* Swipeable card content */}
      <div
        ref={cardRef}
        className="relative z-10"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isDragging ? 'none' : 'transform 0.3s ease-out',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
    </div>
  );
};

