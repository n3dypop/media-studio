import test from 'node:test';
import assert from 'node:assert/strict';
import {setSearchOwnerStatus,requireSearchOwnerStatus,clearSearchOwnerStatus,isSearchOwnerOpen} from '../apps/dsh-plugins/local-genai/search-owner-status.mjs';

test('search needs a matching active turn and stale events cannot reopen a newer one',()=>{
 const sessionId='synthetic-status';try{assert.throws(()=>requireSearchOwnerStatus(sessionId,1),/unresolved/);setSearchOwnerStatus(sessionId,1,'active');requireSearchOwnerStatus(sessionId,1);setSearchOwnerStatus(sessionId,2,'pending');assert.throws(()=>requireSearchOwnerStatus(sessionId,1),/unresolved/);assert.equal(setSearchOwnerStatus(sessionId,1,'active'),false);assert.throws(()=>requireSearchOwnerStatus(sessionId,2),/unresolved/);setSearchOwnerStatus(sessionId,2,'active');requireSearchOwnerStatus(sessionId,2);setSearchOwnerStatus(sessionId,2,'ended');assert.throws(()=>requireSearchOwnerStatus(sessionId,2),/unresolved/);assert.equal(isSearchOwnerOpen(sessionId,2),false);setSearchOwnerStatus(sessionId,2,'completed');assert.equal(isSearchOwnerOpen(sessionId,2),true);setSearchOwnerStatus(sessionId,2,'blocked');assert.equal(setSearchOwnerStatus(sessionId,2,'active'),false);assert.equal(isSearchOwnerOpen(sessionId,2),false);}finally{clearSearchOwnerStatus(sessionId);}
});
