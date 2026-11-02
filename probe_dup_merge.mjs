// 探针：派生行合并是否真的生效（跑在临时 project 里，跑完删目录）
import { saveMemory } from './dist/store.js'
import { DatabaseManager } from './dist/db.js'

const PROJECT = '__dup_probe__'
let caseNo = 0

const cases = [
  {
    name: '同一证据、措辞不同 → 应合并成 1 条',
    params: [
      { text: '用户说自己累死了、什么都不想干，助手便让她什么都别做、先歇着。', source: 'reflect_summary', derived: true, evidenceIds: ['f0dc58c1', 'd239df4a'], skipEmbed: true },
      { text: '用户向助手表示今天非常疲惫、什么都不想做，助手没有追问也没有劝，只表示陪着她先歇着。', source: 'reflect_summary', derived: true, evidenceIds: ['d239df4a', '5818bd03'], skipEmbed: true },
    ],
    expect: 1,
  },
  {
    name: '证据不重叠 → 应保留 2 条',
    params: [
      { text: '她说她喜欢月亮。', source: 'reflect_summary', derived: true, evidenceIds: ['aaa1', 'aaa2'], skipEmbed: true },
      { text: '她说她讨厌早起。', source: 'reflect_summary', derived: true, evidenceIds: ['bbb1', 'bbb2'], skipEmbed: true },
    ],
    expect: 2,
  },
  {
    name: '用户陈述的事实（非派生）不被合并 → 2 条',
    params: [
      { text: '我今天下午在改记忆体。', source: 'chat', evidenceIds: ['ccc1'], skipEmbed: true },
      { text: '我今天下午在改记忆体，顺手也改了索引。', source: 'chat', evidenceIds: ['ccc1'], skipEmbed: true },
    ],
    expect: 2,
  },
]

let failed = 0
for (const c of cases) {
  const proj = `${PROJECT}_${caseNo++}`
  const ids = []
  for (const p of c.params)
    ids.push((await saveMemory({ ...p, project: proj, memType: 'general' })).id)

  const db = DatabaseManager.getInstance(proj, 'general')
  const n = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE is_active = 1 AND project = ?').get(proj).n
  const ok = n === c.expect
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}: rows=${n} (期望 ${c.expect}) ids=${ids.map(i => i.slice(0, 8)).join(',')}`)
}
process.exit(failed ? 1 : 0)
