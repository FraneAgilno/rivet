import assert from 'node:assert/strict';
import test from 'node:test';
import {createProviderHttpClient,createTrustedProviderTransport} from '../../src/adapters/http.js';
function client(extra={}) {return createProviderHttpClient({provider:'gitlab',baseUrl:'https://gitlab.com/api/v4',transport:createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async()=>new Response('{}')}),...extra});}
test('encoded slashes require explicit opt-in and preserve safe project/branch paths',async()=>{
  await assert.rejects(async()=>client().request({method:'GET',path:'/projects/team%2Fsub%2Frepo'}));
  const http=client({allowEncodedSlash:true});
  assert.equal((await http.request({method:'GET',path:'/projects/team%2Fsub%2Frepo/repository/branches/feature%2Ftask'})).status,200);
});
test('encoded slash opt-in still rejects traversal, backslash and double encoding',async()=>{
  const http=client({allowEncodedSlash:true});
  for(const path of ['/projects/a%2F..%2Fb','/projects/a%2F%2e%2e%2Fb','/projects/a%252Fb','/projects/a%5Cb','/projects/a%2F%2Fb','/projects/a%2F.%2Fb']) await assert.rejects(async()=>http.request({method:'GET',path}));
});
