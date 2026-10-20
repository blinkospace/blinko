import { MarkdownRender } from '@/components/Common/MarkdownRender';
import { FilesAttachmentRender } from "../Common/AttachmentRender";
import { Note } from '@shared/lib/types';
import { BlinkoStore } from '@/store/blinkoStore';
import { observer } from 'mobx-react-lite';
import { ReferencesContent } from './referencesContent';
import { helper, type TagTreeDBNode } from '@shared/lib/helper';
import { useNavigate } from 'react-router-dom';

interface NoteContentProps {
  blinkoItem: Note;
  blinko: BlinkoStore;
  isExpanded?: boolean;
  isShareMode?: boolean;
}

export const NoteContent = observer(({ blinkoItem, blinko, isExpanded, isShareMode }: NoteContentProps) => {
  const navigate = useNavigate();
  const inlineTags = new Set(helper.extractHashtags(blinkoItem.content));
  const leaves = (tag: TagTreeDBNode): TagTreeDBNode[] => tag.children?.length ? tag.children.flatMap(leaves) : [tag];
  const independentTags = helper.buildHashTagTreeFromDb((blinkoItem.tags || []).map(item => item.tag))
    .flatMap(leaves).filter(tag => !inlineTags.has(`#${tag.metadata.path}`));
  return (
    <>
      <MarkdownRender
        content={blinkoItem.content}
        onChange={(newContent) => {
          if (isShareMode) return;
          const expectedContent = blinkoItem.content;
          blinko.upsertNote.call({ id: blinkoItem.id, content: newContent, expectedContent, refresh: false }).then(result => {
            if (result) blinkoItem.content = result.content;
          });
        }}
        isShareMode={isShareMode}
        largeSpacing={isShareMode || isExpanded}
      />
      <ReferencesContent blinkoItem={blinkoItem} className={`${isExpanded ? 'my-4' : 'my-2'}`} />
      <div className={blinkoItem.attachments?.length != 0 ? 'my-2' : ''}>
        <FilesAttachmentRender files={blinkoItem.attachments ?? []} preview />
      </div>
      {!!independentTags.length && (
        <div className="flex flex-wrap gap-1 my-2">
          {independentTags.map(tag => (
            <button key={tag.id} type="button" className="text-desc text-xs blinko-tag font-bold"
              disabled={isShareMode}
              onClick={event => {
                event.stopPropagation();
                navigate(`/?path=all&tagId=${tag.id}`);
                blinko.forceQuery++;
              }}>
              #{tag.metadata.path}
            </button>
          ))}
        </div>
      )}
    </>
  );
});
