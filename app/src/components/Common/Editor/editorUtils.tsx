import { helper } from "@/lib/helper"
import { Attachment } from "@shared/lib/types"
import { FileType } from "./type"
import { PromiseState } from "@/store/standard/PromiseState"
import { IsTagSelectVisible } from "../PopoverFloat/tagSelectPop"
import Vditor from "vditor"

export type ViewMode = "wysiwyg" | "sv" | "ir" | "raw"

export type ToolbarProps = {
  store: any;
  files: FileType[];
  openFileDialog: () => void;
  getInputProps: any;
  mode: 'create' | 'edit';
  isPc: boolean;
  canSend: boolean;
  isSendLoading?: boolean;
  onSend?: (args: any) => Promise<any>;
  onChange?: (content: string) => void;
}

export type UploadAction = {
  key: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  showCondition?: boolean;
}

export const HandleFileType = (originFiles: Attachment[]): FileType[] => {
  if (originFiles?.length == 0) return []
  const res = originFiles?.map(file => {
    const extension = helper.getFileExtension(file.name)
    const previewType = helper.getFileType(file.type, file.name)
    return {
      name: file.name,
      size: file.size,
      previewType,
      extension: extension ?? '',
      preview: file.path,
      uploadPromise: new PromiseState({ function: async () => file.path }),
      type: file.type
    }
  })
  res?.map(i => i.uploadPromise.call())
  return res
}

export const getEditorElements = (mode: ViewMode, editor: Vditor) => {
  if (!editor) return
  switch (mode) {
    case 'sv':
      return editor.vditor.sv?.element
    case 'ir':
      return editor.vditor.ir?.element
    case 'wysiwyg':
      return editor.vditor.wysiwyg?.element
    default:
      return editor.vditor.wysiwyg?.element
  }
}

export const FocusEditorFixMobile = () => {
  try {
    requestAnimationFrame(() => {
      const editorElements = document.querySelectorAll('.vditor-ir .vditor-reset') as NodeListOf<HTMLElement>
      if (editorElements.length === 0) return

      if (editorElements.length > 0) {
        editorElements.forEach(editorElement => {
          editorElement.focus()
          const range = document.createRange()
          range.selectNodeContents(editorElement)
          range.collapse(false)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        })
      }
    })
  } catch (error) {

  }
}

/**
 * Mobile: turn the toolbar "more" menu into a viewport-docked action sheet.
 * vditor creates it as an absolutely-positioned child of the toolbar item, where it
 * is clipped by the toolbar's horizontal scroll, the dialog sheet's rounded
 * overflow-hidden surface, and loses hit-testing/paint order to overlapping
 * stacking contexts. Reparenting it to document.body on open makes it immune to
 * every ancestor. vditor's own hidePanel only scans its toolbar subtree, so we also
 * close it ourselves on outside taps, leaf-item activation, and when another
 * toolbar panel opens. Nested submenus expand inline (see .blinko-more-sheet CSS).
 * Returns a disposer that must be called when the editor is destroyed.
 */
export function setupMobileMoreMenu(vditorRoot: HTMLElement | null): () => void {
  if (!vditorRoot || typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches) {
    return () => { }
  }

  let disposed = false
  let dispose: (() => void) | null = null

  // vditor builds its toolbar DOM asynchronously after the constructor returns,
  // so attach lazily once the "more" item and its panel actually exist
  const attach = (): (() => void) | null => {
    const toolbar = vditorRoot.querySelector('.vditor-toolbar')
    const moreItem = toolbar?.querySelector('.vditor-toolbar__item:last-child')
    const panel = moreItem?.querySelector(':scope > .vditor-hint') as HTMLElement | null
    if (!toolbar || !moreItem || !panel) {
      return null
    }

    panel.classList.add('blinko-more-sheet')

    const close = () => {
      if (panel.style.display === 'block') {
        panel.style.display = 'none'
      }
    }
    const onOutside = (e: Event) => {
      const target = e.target as Node
      if (!panel.contains(target) && !moreItem.contains(target)) {
        close()
      }
    }
    // vditor closes the panel on ANY inner click (its flyout-menu design) and its
    // submenu triggers open floating sub-panels that our accordion CSS inlines.
    // Intercept submenu-trigger buttons in the capture phase and toggle the inline
    // expansion ourselves, so the sheet stays open; leaf items keep vditor's own
    // action-then-close behavior. With the vditor patch (getEventName → "click")
    // every platform — iPhone included — acts on tap release with native
    // :active pressed feedback, so no touch interception is needed here.
    const buttonFor = (node: EventTarget | null): HTMLElement | null =>
      node instanceof HTMLElement ? node.closest('button') : null
    const submenuOf = (btn: HTMLElement): HTMLElement | null =>
      (btn.closest('div')?.querySelector(':scope > .vditor-hint') as HTMLElement) ?? null

    const onCapture = (e: Event) => {
      const btn = buttonFor(e.target)
      if (!btn) return
      const sub = submenuOf(btn)
      if (!sub) return // leaf item: let vditor run its own action + close
      e.preventDefault()
      e.stopPropagation()
      sub.style.display = sub.style.display === 'block' ? 'none' : 'block'
    }
    document.addEventListener('click', onOutside)
    document.addEventListener('touchstart', onOutside, { passive: true })
    panel.addEventListener('click', onCapture, true)

    // Mirror vditor's hidePanel: close the body-docked sheet when another toolbar
    // panel opens (vditor can't see it anymore once reparented).
    // Exclude our own panel — it may still be inside the toolbar for one microtask
    // before the reparent observer moves it out.
    const toolbarObs = new MutationObserver(() => {
      if (panel.style.display !== 'block') return
      const otherOpen = [...toolbar.querySelectorAll('.vditor-hint[style*="block"], .vditor-panel[style*="block"]')]
        .find(el => el !== panel)
      if (otherOpen) close()
    })
    toolbarObs.observe(toolbar, { subtree: true, attributes: true, attributeFilter: ['style'] })

    // Reparent the moment vditor shows it (microtask timing → no flash at old spot)
    const openObs = new MutationObserver(() => {
      if (panel.style.display === 'block' && panel.parentElement !== document.body) {
        document.body.appendChild(panel)
      }
    })
    openObs.observe(panel, { attributes: true, attributeFilter: ['style'] })

    return () => {
      toolbarObs.disconnect()
      openObs.disconnect()
      document.removeEventListener('click', onOutside)
      document.removeEventListener('touchstart', onOutside)
      panel.removeEventListener('click', onCapture, true)
      panel.remove()
    }
  }

  dispose = attach()
  if (!dispose) {
    const retryObs = new MutationObserver(() => {
      if (disposed || dispose) return
      dispose = attach()
      if (dispose) retryObs.disconnect()
    })
    retryObs.observe(vditorRoot, { childList: true, subtree: true })
    return () => {
      disposed = true
      retryObs.disconnect()
      dispose?.()
    }
  }
  return () => {
    disposed = true
    dispose?.()
  }
}