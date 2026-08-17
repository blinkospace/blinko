import { MarkdownRender } from '@/components/Common/MarkdownRender';
import { FilesAttachmentRender } from "../Common/AttachmentRender";
import { Note } from '@shared/lib/types';
import { BlinkoStore } from '@/store/blinkoStore';
import { observer } from 'mobx-react-lite';
import { ReferencesContent } from './referencesContent';

interface NoteContentProps {
  blinkoItem: Note;
  blinko: BlinkoStore;
  isExpanded?: boolean;
  isShareMode?: boolean;
  isReadOnly?: boolean;
}

export const NoteContent = observer(({ blinkoItem, blinko, isExpanded, isShareMode, isReadOnly }: NoteContentProps) => {
  return (
    <>
      <MarkdownRender
        content={blinkoItem.content}
        onChange={(newContent) => {
          if (isShareMode || isReadOnly) return;
          blinkoItem.content = newContent
          blinko.upsertNote.call({ id: blinkoItem.id, content: newContent, refresh: false })
        }}
        isShareMode={isShareMode || isReadOnly}
        largeSpacing={isShareMode || isExpanded}
      />
      <ReferencesContent blinkoItem={blinkoItem} className={`${isExpanded ? 'my-4' : 'my-2'}`} />
      <div className={blinkoItem.attachments?.length != 0 ? 'my-2' : ''}>
        <FilesAttachmentRender files={blinkoItem.attachments ?? []} preview />
      </div>
    </>
  );
});