import { z } from 'zod';
import type { SegmentInput } from '../domain';
export const importFormatSchema=z.enum(['vtt','srt','txt']);
export type ImportFormat=z.infer<typeof importFormatSchema>;
const entities: Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function clean(text:string) { return text.replace(/<[^>]+>/g,'').replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name:string)=>entities[name]).trim(); }
function time(value:string) {
  const match=/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match) throw new Error('Invalid transcript timestamp');
  const result=((Number(match[1]??0)*60+Number(match[2]))*60+Number(match[3]))*1000+Number(match[4]);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid transcript timestamp');
  return result;
}
export function parseTranscript(input:string,format:ImportFormat):SegmentInput[] {
  importFormatSchema.parse(format);
  if (Buffer.byteLength(input,'utf8')>1_000_000) throw new Error('Transcript must be at most 1 MB');
  let text=input.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
  if (!text || text.includes('\0')) throw new Error('Transcript must contain readable text');
  const segments:SegmentInput[]=[];
  const append=(body:string,startMs:number|null,endMs:number|null,index:number)=>{
    const voice=format==='txt'?null:/<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(body);
    let content=format==='txt'?body.trim():clean(body); const prefix=/^([^:\n]{1,100}):\s+([\s\S]+)$/.exec(content);
    const speaker=(voice?.[1] ?? prefix?.[1] ?? null)?.trim() ?? null;
    if (speaker && speaker.length>200) throw new Error('Speaker name exceeds 200 characters');
    if (prefix&&!voice) content=prefix[2];
    if (!content) throw new Error('Transcript cue has no text');
    for(let offset=0;offset<content.length;) {
      let end=Math.min(offset+2000,content.length);
      if(end<content.length && /[\uD800-\uDBFF]/.test(content[end-1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
      const part=content.slice(offset,end);
      if(part.trim()) segments.push({sourceKey:`cue-${index}-${offset}`,speaker,text:part,startMs,endMs});
      offset=end;
    }
  };
  if (format==='txt') text.split(/\n\s*\n/).forEach((body,i)=>append(body,null,null,i));
  else {
    if(format==='vtt') {
      if(!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(text)) throw new Error('WebVTT must begin with WEBVTT');
      text=text.replace(/^WEBVTT[^\n]*(?:\n|$)/,'').trim();
    }
    const blocks=text.split(/\n\s*\n/);
    blocks.forEach((block,i)=>{
      if(format==='vtt'&&/^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) return;
      const lines=block.split('\n'); let timing=lines.findIndex(l=>l.includes('-->'));
      if(timing<0||timing>1) throw new Error(`Invalid timed cue ${i+1}`);
      const match=/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timing]);
      if(!match) throw new Error(`Invalid timed cue ${i+1}`);
      const start=time(match[1]),end=time(match[2]); if(end<start) throw new Error('Cue ends before it starts');
      append(lines.slice(timing+1).join('\n'),start,end,i);
    });
  }
  if(!segments.length) throw new Error('Transcript contains no passages');
  if(segments.length>10000) throw new Error('Transcript has too many passages');
  return segments;
}
