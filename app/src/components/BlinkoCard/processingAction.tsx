import { useEffect, useRef, useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/trpc';
import { Icon } from '../Common/Iconify/icons';
import type { BlinkoStore } from '@/store/blinkoStore';

type Status = Awaited<ReturnType<typeof api.ai.processingStatus.query>>;

export function ProcessingAction({ noteId, content, blinko }: { noteId: number; content: string; blinko: BlinkoStore }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const previous = useRef('');
  const mounted = useRef(false);
  const active = status?.status === 'queued' || status?.status === 'running';
  const displayedContent = useRef(content);
  displayedContent.current = content;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.ai.processingStatus.query({ noteId });
        if (stopped) return;
        setStatus(next);
        const signature = JSON.stringify([next.status, next.audio]);
        if (next.allowed && next.content !== undefined && next.content !== displayedContent.current) {
          // Refresh saved lists, not the editor's mutable draft.
          blinko.updateTicker++;
        } else if (previous.current && previous.current !== signature) blinko.updateTicker++;
        previous.current = signature;
        if (next.status === 'queued' || next.status === 'running') timer = setTimeout(poll, 2000);
      } catch {
        if (!stopped) setError(t('note-processing-status-error'));
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [noteId, busy, refresh]);

  async function control(action: 'start' | 'retry' | 'skip', transcribe = false) {
    setBusy(true);
    setError('');
    try {
      const next = await api.ai.processingControl.mutate({ noteId, action, transcribe });
      if (mounted.current) setStatus(next);
      blinko.updateTicker++;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('note-processing-failed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!status?.allowed) return null;
  return (
    <Popover placement="top" onOpenChange={open => {
      if (open) setRefresh(value => value + 1);
    }}>
      <PopoverTrigger>
        <Button size="sm" variant="light" className="h-6 min-w-0 px-1 text-xs" onClick={e => e.stopPropagation()}>
          <Icon icon={active ? 'eos-icons:loading' : 'hugeicons:ai-magic'} width="14" />
          {t('note-processing-title')}
        </Button>
      </PopoverTrigger>
      <PopoverContent onClick={e => e.stopPropagation()} className="max-w-xs items-stretch gap-2 p-3">
        <div className="text-sm">{t(`note-processing-${status.status}`)}</div>
        {status.audio.map(audio => (
          <div key={audio.id} className="text-xs break-all">{audio.name}: {t(`note-processing-audio-${audio.status}`)}</div>
        ))}
        {error && <div role="alert" className="text-xs text-danger">{error}</div>}
        {status.canStart && <>
          <Button size="sm" isDisabled={busy || active} onPress={() => control('start')}>{t('note-processing-start')}</Button>
          {status.status === 'not-started' && <>
            <div className="text-xs text-default-500">{t('note-processing-manual-audio-help')}</div>
            <Button size="sm" isDisabled={busy || active} onPress={() => control('start', true)}>{t('note-processing-transcribe')}</Button>
          </>}
        </>}
        {status.canRetry && <Button size="sm" isDisabled={busy || active} onPress={() => control('retry')}>{t('note-processing-retry')}</Button>}
        {status.canSkip && <Button size="sm" variant="flat" isDisabled={busy} onPress={() => control('skip')}>{t('note-processing-skip')}</Button>}
      </PopoverContent>
    </Popover>
  );
}
