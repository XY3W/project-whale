import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DEEPSEEK_API_KEY='test-key';
process.env.DEEPSEEK_MODEL='deepseek-v4-pro'; // 非 Flash 配置不得改变请求模型
const { callModel } = await import('../server/llm.mjs');
const originalFetch=globalThis.fetch;
function response(events) {
  const bytes=new TextEncoder().encode(events);
  return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}),{status:200});
}
test('streams reasoning while buffering and validating final JSON',async()=>{
  let payload;globalThis.fetch=async (_url,options)=>{payload=JSON.parse(options.body);return response('data: {"choices":[{"delta":{"reasoning_content":"正在"}}]}\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"type\\":\\"finish_task\\",\\"outcome\\":\\"completed\\",\\"speech\\":\\"好\\"}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');};
  try {let text='';const result=await callModel([],undefined,part=>{text+=part});assert.equal(payload.stream,true);assert.equal(payload.model,"deepseek-flash");assert.equal(text,'正在分析');assert.equal(result.type,'finish_task');assert.equal(result.speech,'好');} finally {globalThis.fetch=originalFetch;}
});
test('does not accept an incomplete stream as a valid action',async()=>{
  globalThis.fetch=async()=>response('data: {"choices":[{"delta":{"content":"{\\"type\\":\\"finish_task\\",\\"outcome\\":\\"completed\\"}"},"finish_reason":"stop"}]}\n\n');
  try {await assert.rejects(callModel([]),{code:'INCOMPLETE_STREAM'});} finally {globalThis.fetch=originalFetch;}
});
test("tool responses preserve streamed reasoning for the next request", async () => {
  globalThis.fetch = async () => response("data: " + JSON.stringify({choices:[{delta:{reasoning_content:"先判断",tool_calls:[{index:0,id:"call1",type:"function",function:{name:"finish",arguments:JSON.stringify({outcome:"completed"})}}]},finish_reason:"tool_calls"}]}) + "\n\ndata: [DONE]\n\n");
  try {
    const out = await callModel([], undefined, undefined, {tools:[{type:"function",function:{name:"finish"}}]});
    assert.equal(out.reasoningContent, "先判断");
    assert.equal(out.calls[0].name, "finish");
  } finally {globalThis.fetch = originalFetch;}
});
