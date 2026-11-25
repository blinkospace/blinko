import { Button, Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";
import { observer } from "mobx-react-lite";
import { DialogStandaloneStore } from ".";
import { RootStore } from "@/store/root";
import { useHistoryBack } from "@/lib/hooks";
import { useMediaQuery } from "usehooks-ts";
import { motion } from "motion/react";
import { Icon } from '@/components/Common/Iconify/icons';
import { CancelIcon } from "@/components/Common/Icons";

const CloseButton = ({ onClose }: { onClose: () => void }) => (
  <motion.div
    onClick={onClose}
    className={`cursor-pointer absolute
    md:top-[-12px] md:right-[-12px] top-[-20px] right-[calc(50%-17.5px)] bg-background border-2 border-border z-[2002] text-foreground p-2 rounded-full
    !w-[35px] !h-[35px] flex items-center justify-center shadow-lg`}
    whileTap={{
      scale: 0.85,
      backgroundColor: "var(--heroui-colors-default-100)"
    }}
    whileHover={{
      scale: 1.1,
      backgroundColor: "var(--heroui-colors-default-50)"
    }}
    transition={{
      type: "spring",
      stiffness: 400,
      damping: 17
    }}
  >
    <motion.div
      whileTap={{ rotate: 90 }}
      whileHover={{ rotate: 45 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      <CancelIcon className='primary-foreground !transition-all' />
    </motion.div>
  </motion.div>
);



const Dialog = observer(() => {
  const modal = RootStore.Get(DialogStandaloneStore);
  const isPc = useMediaQuery('(min-width: 768px)')
  const { className, classNames, isOpen, placement, title, size, content, isDismissable, onlyContent = false, noPadding = false, showOnlyContentCloseButton = false, transparent = false } = modal;
  const Content = typeof content === 'function' ? content : () => content;
  useHistoryBack({
    state: isOpen,
    onStateChange: () => modal.close(),
    historyState: 'modal'
  });

  const motionConfig = {
    initial: "enter",
    animate: "enter",
    exit: "exit",
    variants: {
      enter: {
        y: 0,
        opacity: 1,
        transition: { type: 'spring', bounce: 0.5, duration: 0.6 },
      },
      exit: {
        y: -20,
        opacity: 0,
        transition: { type: 'spring', bounce: 0.5, duration: 0.3 },
      },
    }
  };

  // Mobile (below the md breakpoint) always uses the bottom-sheet form,
  // regardless of platform, so Android/iOS/narrow desktop share one strategy.
  const mobileSheetMaxHeight = 'calc(85dvh - max(0.5rem, env(safe-area-inset-bottom)))';
  // The titled sheet adds p-1 (0.5rem total) around its body, so subtract it too.
  const mobileSheetMaxHeightWithHeader = 'calc(85dvh - max(0.5rem, env(safe-area-inset-bottom)) - 0.5rem)';

  if (!isPc && isOpen) {
    return (
      <>
        <div
          className="fixed inset-0 z-[2000] bg-black/50 backdrop-blur-sm"
          onClick={() => {
            if (isDismissable) {
              modal.close()
            }
          }}
        />
        <motion.div
          className="fixed bottom-0 left-0 right-0 z-[2001] flex flex-col items-center pointer-events-none"
          {...motionConfig}
          initial={{ opacity: 0, y: 100 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 100 }}
        >
          {!onlyContent && (
            <motion.div
              className="w-full bg-background border-secondbackground p-1 rounded-t-lg shadow-lg pointer-events-auto"
              style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
              {...motionConfig}
            >
              <div
                className="flex flex-col justify-between items-center p-4 gap-2"
                style={{ maxHeight: mobileSheetMaxHeightWithHeader }}
              >
                <div className="flex gap-2 w-full items-center shrink-0">
                  <div className="text-lg font-semibold">{title ?? ''}</div>
                  <Button isIconOnly variant="light" onPress={() => modal.close()} className="ml-auto">
                    <Icon icon="tabler:x" width="16" height="16" />
                  </Button>
                </div>
                <div className="w-full overflow-y-auto overscroll-contain min-h-0" >
                  <Content />
                </div>
              </div>
            </motion.div>
          )}
          {
            onlyContent && <motion.div
              className="w-full pointer-events-auto "
              {...motionConfig}
            >
              <div className="relative">
                {
                  showOnlyContentCloseButton &&
                  <CloseButton onClose={() => modal.close()} />
                }
                {/* The sheet surface (bg + radius + safe-area padding) lives here instead of the
                    outer fixed wrapper, so the rounded corner notches reveal the dark backdrop
                    rather than a white strip. rounded-large matches the inner HeroUI Card radius,
                    so overflow-hidden clips it cleanly with no double rounding. */}
                <div
                  className="w-full bg-background rounded-large overflow-hidden"
                  style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
                >
                  <div
                    className="w-full overflow-y-auto overscroll-contain"
                    style={{ maxHeight: mobileSheetMaxHeight }}
                  >
                    <Content />
                  </div>
                </div>
              </div>
            </motion.div>
          }
        </motion.div>
      </>
    )
  }
  return (
    <Modal
      style={{ zIndex: 2000 }}
      onClose={() => {
        modal.close();
      }}
      backdrop='blur'
      isOpen={isOpen}
      size={size}
      placement={placement}
      onOpenChange={(open: boolean) => {
        if (open) {
          modal.preventClose = false
        }
        if (!open) {
          if (!modal.preventClose) {
            modal.close();
          }
        }
      }}
      hideCloseButton={(size === 'full' || onlyContent) ? true : false}
      className={`${className} ${transparent ? 'bg-transparent' : ''}`}
      classNames={classNames}
      isDismissable={isDismissable}
      motionProps={{
        variants: {
          enter: {
            y: 0,
            opacity: 1,
            transition: { type: 'spring', bounce: 0.5, duration: 0.6, },
          },
          exit: {
            y: -20,
            opacity: 0,
            transition: { type: 'spring', bounce: 0.5, duration: 0.3, },
          },
        }
      }}
    >
      {
        onlyContent ?
          <ModalContent className="max-h-screen overflow-visible relative" >
            {
              showOnlyContentCloseButton &&
              <CloseButton onClose={() => modal.close()} />
            }
            <Content />
          </ModalContent> :
          <ModalContent className="max-h-screen overflow-auto">
            {() => (
              <>
                {title && <ModalHeader className="flex flex-col gap-1">{title}</ModalHeader>}
                <ModalBody className={`${noPadding ? '' : 'p-2 md:p-4 '}`}>
                  <Content />
                </ModalBody>
              </>
            )}
          </ModalContent>
      }
    </Modal>
  );
});

export default Dialog;