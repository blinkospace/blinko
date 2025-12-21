import { eventBus } from "@/lib/event";
import { useIsIOS } from "@/lib/hooks";
import { motion } from "motion/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "usehooks-ts";

interface ExpandableContainerProps {
  isExpanded: boolean;
  children: React.ReactNode;
  withoutBoxShadow?: boolean;
  onClose?: () => void;
}

const ANIMATION_CONFIG = {
  type: "spring",
  damping: 25,
  stiffness: 400,
  mass: 0.5,
} as const;



export const ExpandableContainer = ({ isExpanded, children, onClose, withoutBoxShadow = false }: ExpandableContainerProps) => {
  const BASE_STYLES = {
    boxShadow: withoutBoxShadow ? 'none' : '0 0 15px -5px #5858581a',
  } as const;

  const isIOS = useIsIOS()
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        onClose?.();
      }
    };

    // Hide/show mobile navigation bars when expanded/collapsed
    const mobileHeader = document.querySelector('.blinko-mobile-header') as HTMLElement;
    const bottomBar = document.querySelector('.blinko-bottom-bar') as HTMLElement;

    if (isExpanded) {
      if (mobileHeader) mobileHeader.style.display = 'none';
      if (bottomBar) bottomBar.style.display = 'none';
    } else {
      if (mobileHeader) mobileHeader.style.display = '';
      if (bottomBar) bottomBar.style.display = '';
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore navigation bars when component unmounts
      if (mobileHeader) mobileHeader.style.display = '';
      if (bottomBar) bottomBar.style.display = '';
    };

  }, [isExpanded, onClose]);

  if (isIOS) {
    if (isExpanded) {
      return createPortal(
        <div
          className={`w-full expanded-container fixed inset-0 touch-manipulation ${isExpanded ? 'expanded-container' : ''}`}
          style={{
            ...BASE_STYLES,
            backgroundColor: 'var(--background)',
            zIndex: 20,
            width: "100vw",
            height: "100vh",
            transition: 'all 0.3s ease-in-out',
          }}
        >
          {children}
        </div>,
        document.body
      );
    }

    return (
      <div
        className='w-full expanded-container touch-manipulation'
        style={{
          ...BASE_STYLES,
          position: 'relative',
          transition: 'all 0.3s ease-in-out',
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={`w-full ${isExpanded ? 'expanded-container ' : ''}`}
      style={{
        ...BASE_STYLES,
        position: isExpanded ? 'fixed' : 'relative',
        top: isExpanded ? 0 : 'auto',
        left: isExpanded ? 0 : 'auto',
        zIndex: isExpanded ? 50 : 1,
        willChange: isExpanded ? 'transform, width, height' : 'auto',
      }}
      layout
      animate={{
        width: isExpanded ? "100vw" : "100%",
        height: isExpanded ? "100vh" : "auto",
      }}
      transition={ANIMATION_CONFIG}
    >
      {children}
    </motion.div>
  );
};