import test from 'node:test';
import assert from 'node:assert/strict';
import {systemPrompt, toolStartMessages} from '../server/llm.mjs';

test('无技能时也鼓励从证据主动积累，并保留任务优先级', () => {
  const prompt=systemPrompt({skillIndex:[]});
  assert.match(prompt,/主动学习与技能积累/);
  assert.match(prompt,/不要只等宿主指出多次失败/);
  assert.match(prompt,/不为写技能打断紧急任务/);
  assert.match(prompt,/不额外唤醒自己/);
  assert.match(prompt,/未来可复用的新经验/);
});

test('原生工具提示约束优先修补、不覆盖和证据不足不编造', () => {
  const messages=toolStartMessages({skills:{index:[{id:'sk1',title:'扫雷',trigger:'挖掘时'}]}});
  const prompt=messages[0].content;
  assert.match(prompt,/先 read，再依据当前版本用 revise 的局部 edits/);
  assert.match(prompt,/保留其他正确内容/);
  assert.match(prompt,/不确定/);
  assert.match(prompt,/正文接近或达到字数上限/);
  assert.match(prompt,/通读整篇/);
  assert.match(prompt,/价值较低/);
  assert.match(prompt,/保留仍然正确且有用的规则/);
  assert.match(prompt,/不要整篇覆盖/);
});
