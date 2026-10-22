import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { Hub } from '../src/hub';
import { SlackStore } from '../src/slack-store';

const open: Database.Database[] = [];
function setup() {
  const db=new Database(':memory:');open.push(db);new Hub(db);
  const store=new SlackStore(db);
  store.replaceMembership('T1',[
    {channelId:'C1',name:'public',isPrivate:false},
    {channelId:'G1',name:'private',isPrivate:true},
  ]);
  return store;
}
afterEach(()=>{for(const db of open.splice(0))db.close();});
const entry=(ts:string,text:string,threadTs:string|null=null)=>({ts,text,threadTs,authorId:'U1',editedAt:null});

it('searches joined public and private channels, preserving thread identity',()=>{
  const store=setup();
  store.reconcile('T1','C1','0',[entry('100.000001','alpha plan')]);
  store.reconcile('T1','G1','0',[entry('101.000001','alpha private'),entry('102.000001','alpha reply','101.000001')]);
  expect(store.search('alpha',{teamId:'T1'}).map(e=>[e.channelId,e.threadTs,e.isPrivate]))
    .toEqual([['G1','101.000001',true],['G1',null,true],['C1',null,false]]);
  expect(store.search('alpha',{teamId:'T1',before:'102.000001'})).toHaveLength(2);
  expect(store.read('T1','G1',{limit:1})[0]?.ts).toBe('102.000001');
  expect(store.search('alpha',{teamId:'T2'})).toEqual([]);
});

it('replaces edits and removes deleted or inaccessible messages from full text search',()=>{
  const store=setup();
  store.reconcile('T1','G1','0',[entry('100.000001','old secret'),entry('101.000001','keep this')]);
  store.reconcile('T1','G1','0',[{...entry('100.000001','new plan'),editedAt:'102.000001'}]);
  expect(store.search('old',{teamId:'T1'})).toEqual([]);
  expect(store.search('new',{teamId:'T1'})).toHaveLength(1);
  expect(store.search('keep',{teamId:'T1'})).toEqual([]);
  store.replaceMembership('T1',[{channelId:'C1',name:'public',isPrivate:false}]);
  expect(store.search('new',{teamId:'T1'})).toEqual([]);
  expect(store.read('T1','G1')).toEqual([]);
});
