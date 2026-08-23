// v1.15 identity CRUD + 评分 + metadata 行为验证(临时库,不碰真实数据)
import fs from 'node:fs';
const TEST_DIR = 'D:/AI/_test_memory_v115';
process.env.MEMORY_DB_DIR = TEST_DIR;
process.env.EMBED_MODE = 'none';
process.env.CASTALIA_PROJECT = 'testproj';

fs.rmSync(TEST_DIR, { recursive: true, force: true });

const { saveMemory, applyIdentityActions, updateMemory, forgetMemory } = await import('../dist/store.js');
const { DatabaseManager } = await import('../dist/db.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('== 1. saveMemory 新列落库 ==');
const m = await saveMemory({
  text: '用户是资深后端工程师', type: 'entity', memType: 'user',
  scoreConfidence: 0.9, scorePriority: 0.8, metadata: '{"role":"engineer"}',
  title: '职业', skipEmbed: true,
});
check('id 生成', !!m.id);
check('scoreConfidence=0.9', m.scoreConfidence === 0.9, String(m.scoreConfidence));
check('scorePriority=0.8', m.scorePriority === 0.8, String(m.scorePriority));
check('metadata 落库', m.metadata === '{"role":"engineer"}', m.metadata);
check('identityLocked 默认 false', m.identityLocked === false, String(m.identityLocked));
const row = DatabaseManager.getInstance('testproj', 'user').prepare('SELECT * FROM memory WHERE id=?').get(m.id);
check('DB 列真实存在', row && row.score_confidence === 0.9 && row.metadata === '{"role":"engineer"}');

console.log('== 2. applyIdentityActions: add ==');
const r1 = await applyIdentityActions({ add: [{ text: '用户喜欢简洁回复', scorePriority: 0.9 }] }, 'testproj');
check('add applied=1', r1.applied === 1, JSON.stringify(r1));
check('add 无拒绝', r1.rejected.length === 0);

console.log('== 3. 幻觉 id update → rejected ==');
const r2 = await applyIdentityActions({ update: [{ id: 'fake-id-xyz', mergeStrategy: 'merge', set: { text: 'x' } }] }, 'testproj');
check('幻觉 id 被拒', r2.applied === 0 && r2.rejected.length === 1, JSON.stringify(r2));
check('拒绝原因含 unknown-id', /unknown-id/.test(r2.rejected[0] || ''), r2.rejected[0]);

console.log('== 4. 真实 id update(merge) ==');
const r3 = await applyIdentityActions({
  update: [{ id: m.id, mergeStrategy: 'merge', set: { text: '用户是资深后端工程师,专注 Go', scoreConfidence: 0.95 } }],
}, 'testproj');
check('merge applied=1', r3.applied === 1, JSON.stringify(r3));
const row2 = DatabaseManager.getInstance('testproj', 'user').prepare('SELECT text, score_confidence FROM memory WHERE id=?').get(m.id);
check('text 已更新', row2 && row2.text.includes('专注 Go'), row2 && row2.text);
check('scoreConfidence 更新为 0.95', row2 && row2.score_confidence === 0.95, String(row2 && row2.score_confidence));

console.log('== 5. 非 entity id update → rejected ==');
const pref = await saveMemory({ text: '测试偏好', type: 'preference', memType: 'user', skipEmbed: true });
const r5b = await applyIdentityActions({ update: [{ id: pref.id, mergeStrategy: 'merge', set: { text: 'y' } }] }, 'testproj');
check('非 entity 被拒(not-entity)', r5b.applied === 0 && /not-entity/.test(r5b.rejected[0] || ''), JSON.stringify(r5b));

console.log('== 6. identity_locked remove 保护 ==');
await updateMemory(m.id, { identityLocked: true });
const r6 = await applyIdentityActions({ remove: [{ id: m.id, reason: '过时' }] }, 'testproj');
check('locked remove 被拒', r6.applied === 0 && /locked/.test(r6.rejected[0] || ''), JSON.stringify(r6));
check('forgetMemory locked 也拒', (await forgetMemory(m.id, 'testproj')) === false);
await updateMemory(m.id, { identityLocked: false });
const r6b = await applyIdentityActions({ remove: [{ id: m.id, reason: '清理' }] }, 'testproj');
check('解锁后 remove 成功', r6b.applied === 1, JSON.stringify(r6b));

console.log('== 7. preference metadata 落库 ==');
const p = await saveMemory({
  text: '# User Profile: 回复偏好\n- 回复要简洁', type: 'preference', memType: 'user',
  metadata: '{"originContext":{"trigger":"用户说\\"简洁\\"时","applicableWhen":"聊天","notApplicableWhen":"技术评审"}}',
  scorePriority: 0.85, skipEmbed: true,
});
const prow = DatabaseManager.getInstance('testproj', 'user').prepare('SELECT metadata, score_priority FROM memory WHERE id=?').get(p.id);
check('preference metadata 落库', prow && prow.metadata.includes('originContext'), prow && prow.metadata);
check('score_priority=0.85', prow && prow.score_priority === 0.85);

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
fs.rmSync(TEST_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
