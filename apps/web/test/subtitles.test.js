const test=require('node:test');const assert=require('node:assert/strict');
const {groupWordsIntoCues,wrapIntoLines,buildSrt,formatSrtTimestamp}=require('../src/shared/subtitles');

function w(text,start,end){return{text,start,end,score:0.9};}

test('groupWordsIntoCues never drops a word',()=>{const words=[w('One',0,0.2),w('two',0.3,0.5),w('three',0.6,0.8),w('four.',0.9,1.1),w('Five',3,3.2),w('six.',3.3,3.6)];const cues=groupWordsIntoCues(words);const flat=cues.flatMap((c)=>c.text.split(/\s+/));assert.deepEqual(flat,['One','two','three','four.','Five','six.']);});
test('groupWordsIntoCues breaks on a long pause between words',()=>{const words=[w('Hello.',0,0.4),w('Much',5,5.2),w('later.',5.3,5.6)];const cues=groupWordsIntoCues(words);assert.equal(cues.length,2);assert.equal(cues[0].text,'Hello.');assert.equal(cues[1].text,'Much later.');});
test('groupWordsIntoCues breaks when the char budget would be exceeded',()=>{const longWords=Array.from({length:20},(_,i)=>w(`word${i}longenoughtopad`,i*0.3,i*0.3+0.2));const cues=groupWordsIntoCues(longWords,{maxCharsPerLine:20,maxLines:2});assert.ok(cues.length>1);for(const cue of cues)assert.ok(cue.text.length<=40+20);});
test('groupWordsIntoCues breaks when cue duration would exceed the max',()=>{const words=Array.from({length:10},(_,i)=>w(`w${i}`,i*1,i*1+0.3));const cues=groupWordsIntoCues(words,{maxCueDuration:2});for(const cue of cues)assert.ok(cue.end-cue.start<=2+1);});
test('groupWordsIntoCues never lets adjacent cues overlap after min-duration extension',()=>{const words=[w('A',0,0.1),w('quick',5,5.1),w('word.',5.15,5.2),w('B',5.3,5.4),w('next.',10,10.1)];const cues=groupWordsIntoCues(words,{minCueDuration:2});for(let i=0;i<cues.length-1;i+=1)assert.ok(cues[i].end<=cues[i+1].start);});
test('groupWordsIntoCues returns an empty array for no words',()=>{assert.deepEqual(groupWordsIntoCues([]),[]);assert.deepEqual(groupWordsIntoCues(null),[]);});

test('wrapIntoLines never drops words and respects maxLines by merging overflow into the last line',()=>{const text='one two three four five six seven eight';const lines=wrapIntoLines(text,10,2);assert.equal(lines.length,2);assert.equal(lines.join(' ').split(/\s+/).length,8);});
test('wrapIntoLines keeps a single line when it fits',()=>{assert.deepEqual(wrapIntoLines('short line',40,2),['short line']);});

test('formatSrtTimestamp formats zero, sub-second, and multi-hour boundary values',()=>{assert.equal(formatSrtTimestamp(0),'00:00:00,000');assert.equal(formatSrtTimestamp(1),'00:00:01,000');assert.equal(formatSrtTimestamp(0.999),'00:00:00,999');assert.equal(formatSrtTimestamp(61.5),'00:01:01,500');assert.equal(formatSrtTimestamp(3661.234),'01:01:01,234');});
test('formatSrtTimestamp clamps negative input to zero',()=>{assert.equal(formatSrtTimestamp(-5),'00:00:00,000');});

test('buildSrt produces sequential indices and blank-line-separated blocks',()=>{const cues=[{start:0,end:1,lines:['Hello there.']},{start:1.2,end:2,lines:['Line one','line two']}];const srt=buildSrt(cues);assert.match(srt,/^1\n00:00:00,000 --> 00:00:01,000\nHello there\.\n\n2\n00:00:01,200 --> 00:00:02,000\nLine one\nline two\n$/);});
