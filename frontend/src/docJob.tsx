import React, { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';
import { Button } from '@/components/ui/button';

/**
 * A document the worker renders (welding document, work instructions): shows Create → progress → Open, polls while
 * it is generating and reports a failure with its reason instead of a generic "file unavailable".
 */
export function JobDocButton({ revision, kind, label, icon, open, disabled, notify }: {
  revision: string; kind: 'welding' | 'assembly-instructions'; label: string; icon: React.ReactNode;
  open: (path: string) => void; disabled?: boolean; notify?: (msg: string) => void;
}) {
  const [st, setSt] = useState<{ state: string; progress?: number; message?: string; error?: string }>({ state: 'unknown' });
  const status = () => api(`/revisions/${revision}/${kind}`).then(setSt).catch(() => { /* keep */ });
  useEffect(() => { void status(); }, [revision, kind]);
  useEffect(() => {
    if (st.state !== 'generating') return;
    const t = window.setInterval(status, 2000);
    return () => window.clearInterval(t);
  }, [st.state]);
  // ready right after generating: open it once
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (wanted && st.state === 'ready') { setWanted(false); open(`/revisions/${revision}/${kind}.pdf`); } if (wanted && st.state === 'failed') { setWanted(false); notify?.(`${label} failed: ${st.error || 'unknown error'}`); } }, [st.state, wanted]);
  const click = async () => {
    if (st.state === 'ready') { open(`/revisions/${revision}/${kind}.pdf`); return; }
    try { await api(`/revisions/${revision}/${kind}`, 'POST'); setSt({ state: 'generating', progress: 0 }); setWanted(true); }
    catch (e: unknown) { notify?.((e as Error).message); }
  };
  const busy = st.state === 'generating';
  return (
    <Button type="button" variant="outline" disabled={disabled || busy || st.state === 'no-welds'} onClick={click}
      title={st.state === 'ready' ? `Open the ${label.toLowerCase()}` : busy ? (st.message || 'Generating…') : st.state === 'failed' ? `Failed: ${st.error || ''} — click to try again` : st.state === 'no-welds' ? 'No welds configured yet' : `Create the ${label.toLowerCase()}`}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : icon}{busy ? `${label} ${st.progress ? st.progress + '%' : '…'}` : st.state === 'ready' ? label : st.state === 'failed' ? `Retry ${label.toLowerCase()}` : `Create ${label.toLowerCase()}`}
    </Button>
  );
}
