#!/usr/bin/env python3
"""v5 cutter: fetch each clip's enclosing span ONCE, then slice out that diarizer speaker's own
segments and join them with a short audible seam. asked == got is checked on the enclosing span AND
the assembled clip is checked against the segments' own audio. Counts and clock times only; the
presigned URL is a credential and is never printed, logged or written down."""
import datetime, json, os, subprocess, sys, tempfile, urllib.request, wave
DATA='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v6'
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
hh=lambda ms: datetime.datetime.fromtimestamp(int(ms)/1000,IST).strftime('%H:%M:%S')
iso=lambda ms: datetime.datetime.fromtimestamp(int(ms)/1000, datetime.timezone.utc).isoformat()
SEAM_MS=150
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def fetch(sess,a,b,tmp,n):
    import mcp
    try: r=mcp.call('scribe_extract_audio',{'session_id':sess,'start':iso(a),'end':iso(b),'source':'primary'})
    except Exception as e: return None,type(e).__name__
    if not isinstance(r,dict) or not r.get('ok'): return None,str(r.get('error') if isinstance(r,dict) else 'bad')[:28]
    c=r.get('clip') or {}
    url=c.get('presigned_get') or r.get('presigned_get')
    if not url: return None,'no_presigned_get'
    base=0 if r.get('joined') else int(float((r.get('pieces') or [{}])[0].get('offset_in_chunk_s') or 0)*1000)
    raw,pcm=os.path.join(tmp,'s%d.src'%n),os.path.join(tmp,'s%d.wav'%n)
    try:
        with urllib.request.urlopen(url,timeout=300) as resp, open(raw,'wb') as f: f.write(resp.read())
        if subprocess.run(['ffmpeg','-v','error','-y','-i',raw,'-c:a','pcm_s16le',pcm],capture_output=True).returncode:
            return None,'decode'
    except Exception as e: return None,type(e).__name__
    return (pcm,base),None

man=json.load(open(os.path.join(DATA,'manifest.json')))
out=os.path.join(DATA,'clips'); os.makedirs(out,exist_ok=True)
ok=fail=0; tot=0
with tempfile.TemporaryDirectory() as tmp:
    for i,c in enumerate(man['clips'],1):
        a,b=c['span_start_ms'],c['span_end_ms']
        got,err=fetch(c['session_id'],a,b,tmp,i)
        if got is None:
            print('  %2d/%d %s %-9s: NO AUDIO (%s)'%(i,len(man['clips']),hh(a),c.get('mode','segment'),err)); fail+=1; continue
        pcm,base=got
        with wave.open(pcm,'rb') as w:
            nch,sw,fr,nf=w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes(); body=w.readframes(nf)
        bpf=nch*sw
        span_ms=int(nf*1000/fr)-0
        # asked == got on the enclosing span (allow the chunk offset)
        avail=span_ms-base//1
        if avail < (b-a)-500:
            print('  %2d/%d %s %-9s: SPAN SHORT (asked %.1fs, have %.1fs)'%(i,len(man['clips']),hh(a),c.get('mode','segment'),(b-a)/1000,avail/1000)); fail+=1; continue
        sil=b'\x00'*(int(fr*SEAM_MS/1000)*bpf)
        pieces=[]
        for (s0,e0) in c['segs']:
            x0=max(0,int((base+s0-a)*fr/1000))*bpf; x1=min(len(body),int((base+e0-a)*fr/1000)*bpf)
            if x1>x0: pieces.append(body[x0:x1])
        if not pieces:
            print('  %2d/%d %s: no audio at segment offsets'%(i,len(man['clips']),hh(a))); fail+=1; continue
        blob=sil.join(pieces); got_ms=int(len(blob)/bpf*1000/fr); want=c['own_ms']+SEAM_MS*(len(pieces)-1)
        if abs(got_ms-want)>500:
            print('  %2d/%d %s %-9s: ASSEMBLY OFF (want %.1fs got %.1fs)'%(i,len(man['clips']),hh(a),c.get('mode','segment'),want/1000,got_ms/1000)); fail+=1; continue
        with wave.open(os.path.join(out,c['id']+'.wav'),'wb') as o:
            o.setnchannels(nch); o.setsampwidth(sw); o.setframerate(fr); o.writeframes(blob)
        ok+=1; tot+=got_ms
        if i<=3 or c.get('mode','segment')=='turnspan':
            print('  %2d/%d %s %-9s: %d seg -> %.1fs (span %.1fs asked/%.1fs have)'%(i,len(man['clips']),hh(a),c.get('mode','segment'),len(pieces),got_ms/1000,(b-a)/1000,avail/1000))
miss=[c['id'] for c in man['clips'] if not os.path.isfile(os.path.join(out,c['id']+'.wav'))]
print('done: %d written, %d failed; %.1f min'%(ok,fail,tot/60000))
print('readiness %d/%d%s'%(len(man['clips'])-len(miss),len(man['clips']),'' if not miss else ' -> page will NOT render'))
