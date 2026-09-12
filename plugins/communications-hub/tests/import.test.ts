import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/adapters/import';
describe('transcript import',()=>{
 it('reads WebVTT cue identifiers, settings and voice tags',()=>{
   const segments=parseTranscript('WEBVTT\n\nfirst\n00:00:01.000 --> 00:00:03.500 align:start\n<v Alex>Ship &amp; verify.</v>\n\n00:04.000 --> 00:05.000\nSam: Agreed.','vtt');
   expect(segments.map(({speaker,text,startMs,endMs})=>({speaker,text,startMs,endMs}))).toEqual([{speaker:'Alex',text:'Ship & verify.',startMs:1000,endMs:3500},{speaker:'Sam',text:'Agreed.',startMs:4000,endMs:5000}]);
 });
 it('reads SRT and preserves unknown times in plain text',()=>{
   expect(parseTranscript('1\n00:00:01,250 --> 00:00:02,500\nAlex: Hello','srt')[0]).toMatchObject({speaker:'Alex',text:'Hello',startMs:1250,endMs:2500});
   expect(parseTranscript('Alex: We should ship.\n\nA paragraph without attribution.','txt').map(s=>[s.speaker,s.startMs,s.text])).toEqual([['Alex',null,'We should ship.'],[null,null,'A paragraph without attribution.']]);
 });
 it('rejects malformed timed files instead of silently dropping content',()=>{
   expect(()=>parseTranscript('WEBVTT\n\n00:00:03.000 --> 00:00:01.000\nbackwards','vtt')).toThrow();
   expect(()=>parseTranscript('WEBVTT\n\nthis is not a cue','vtt')).toThrow();
   expect(()=>parseTranscript('','txt')).toThrow();
   expect(()=>parseTranscript('a'.repeat(1_000_001),'txt')).toThrow();
 });
 it('preserves plain-text angle brackets and spaces across chunk boundaries',()=>{
   const body='<Component> '+('word '.repeat(900)).trim();
   expect(parseTranscript(body,'txt').map(s=>s.text).join('')).toBe(body);
 });
 it('keeps Unicode characters intact when splitting long text',()=>{
   const body='x'.repeat(1999)+'😀end';
   const parts=parseTranscript(body,'txt');
   expect(parts.map(s=>Buffer.from(s.text).toString()).join('')).toBe(body);
 });
 it('splits long paragraphs into bounded segments with distinct source keys',()=>{
   const segments=parseTranscript('Alex: '+'x'.repeat(4500),'txt');
   expect(segments.map(s=>s.text).join('')).toBe('x'.repeat(4500));
   expect(segments.every(s=>s.text.length<=2000&&s.speaker==='Alex')).toBe(true);
   expect(new Set(segments.map(s=>s.sourceKey)).size).toBe(3);
 });
});
