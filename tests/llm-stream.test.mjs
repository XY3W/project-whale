import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DEEPSEEK_API_KEY='test-key';
const { callModel } = await import('../server/llm.mjs');
const originalFetch=globalThis.fetch;
function response(events) {
  const bytes=new TextEncoder().encode(events);
  return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}),{status:200});
}
test('streams reasoning while buffering and validating final JSON',async()=>{
  let payload;globalThis.fetch=async (_url,options)=>{payload=JSON.parse(options.body);return response('data: {"choices":[{"delta":{"reasoning_content":"正在"}}]}\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"type\\":\\"finish_task\\",\\"outcome\\":\\"completed\\",\\"speech\\":\\"好\\"}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');};
  try {let text='';const result=await callModel([],undefined,part=>{text+=part});assert.equal(payload.stream,true);assert.equal(text,'正在分析');assert.equal(result.type,'finish_task');assert.equal(result.speech,'好');} finally {globalThis.fetch=originalFetch;}
});
test('does not accept an incomplete stream as a valid action',async()=>{
  globalThis.fetch=async()=>response('data: {"choices":[{"delta":{"content":"{\\"type\\":\\"finish_task\\",\\"outcome\\":\\"completed\\"}"},"finish_reason":"stop"}]}\n\n');
  try {await assert.rejects(callModel([]),{code:'INCOMPLETE_STREAM'});} finally {globalThis.fetch=originalFetch;}
});
