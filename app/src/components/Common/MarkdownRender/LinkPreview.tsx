import { useEffect, useState, useRef } from 'react';
import { Card, Image, Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { api } from '@/lib/trpc';
import { LinkInfo } from '@shared/lib/types';
import { RootStore } from '@/store';
import { StorageState } from '@/store/standard/StorageState';
import { observer } from 'mobx-react-lite';

interface LinkPreviewProps {
  href: string;
  text: any;
  isBlock?: boolean;
}

export const LinkPreview = observer(({ href, text, isBlock = false }: LinkPreviewProps) => {
  const store = RootStore.Local(() => ({
    previewData: new StorageState<LinkInfo | null>({ key: href, default: null })
  }))
  
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 300);
  };
  
  useEffect(() => {
    const fetchData = async () => {
      try {
        if (!store.previewData.value) {
          const info = await api.public.linkPreview.query({ url: href }, { context: { skipBatch: true } })
          store.previewData.setValue(info)
        }
      } catch (error) {
        console.error('Error fetching preview data:', error);
      }
    };
    // Only fetch if it's a block or popover is open (to save resources)
    if (isBlock || isOpen) {
      fetchData();
    }
  }, [href, isBlock, isOpen]);

  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(href, '_blank');
  };

  const PreviewCard = () => {
    if (!store.previewData?.value?.title) return null;
    
    return (
      <div 
        onClick={handleCardClick} 
        className='p-2 my-1 bg-secondbackground rounded-xl select-none cursor-pointer hover:bg-default-100 transition-colors max-w-md'
      >
        <div className='flex items-center gap-2 w-full'>
          <div className='font-bold truncate text-sm'>{store.previewData.value?.title}</div>
          {store.previewData.value?.favicon && 
            <Image 
              fallbackSrc="/fallback.png" 
              className='flex-1 rounded-full ml-auto min-w-[16px]' 
              src={store.previewData.value.favicon} 
              width={16} 
              height={16}
            />
          }
        </div>
        <div className='text-desc truncate text-xs mt-1'>{store.previewData.value?.description}</div>
      </div>
    );
  };

  if (isBlock) {
    return (
      <div className="link-preview-block w-full my-2">
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline block mb-1 truncate">
          {text}
        </a>
        <PreviewCard />
      </div>
    );
  }

  return (
    <Popover 
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      placement="bottom" 
      triggerScaleOnOpen={false} 
    >
      <PopoverTrigger>
        <a 
          href={href} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="text-primary hover:underline inline-block cursor-pointer"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {text}
        </a>
      </PopoverTrigger>
      <PopoverContent 
        className="p-0 bg-transparent border-none shadow-none"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {store.previewData?.value?.title ? (
          <div className="shadow-lg rounded-xl overflow-hidden bg-background border border-default-200">
            <PreviewCard />
          </div>
        ) : (
          <div className="p-2 text-xs text-default-500 bg-background border border-default-200 rounded-md shadow-sm">Loading preview...</div>
        )}
      </PopoverContent>
    </Popover>
  );
}); 