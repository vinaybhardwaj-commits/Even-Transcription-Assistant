import json, datetime
import mcp
m = json.load(open('/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot/manifest.json'))
c = m['clips'][0]
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()
r = mcp.call('scribe_extract_audio', {'session_id': c['session_id'], 'start': iso(c['start_ms']), 'end': iso(c['end_ms']), 'source': 'primary'})
print(json.dumps(mcp.shape(r), indent=1)[:2200])
