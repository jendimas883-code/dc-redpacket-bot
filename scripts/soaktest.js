'use strict';

// 稳定性连跑：npm run soaktest（默认 10 轮，可自定义：node scripts/soaktest.js 20）
// 每轮依次跑 selftest / e2etest / flowtest，统计总失败次数。
// 用途：抓拼手气随机拆分、时序竞态、临时目录清理等"跑一次测不出来"的偶发问题；
// 三套测试各自清理独立临时目录，连跑互不污染。

const { spawnSync } = require('node:child_process');

const ROUNDS = Math.max(1, Number(process.argv[2] || 10));
const SUITES = ['selftest', 'e2etest', 'flowtest'];

let failures = 0;
console.log(`稳定性连跑：${ROUNDS} 轮 × ${SUITES.length} 套测试\n`);

for (let round = 1; round <= ROUNDS; round++) {
  const results = [];
  for (const suite of SUITES) {
    const r = spawnSync(`npm run ${suite}`, { shell: true, encoding: 'utf8' });
    if (r.status !== 0) {
      failures += 1;
      // 失败才回放输出尾部，成功时保持安静，10 轮刷屏没意义
      const out = `${r.stdout || ''}\n${r.stderr || ''}`.trimEnd().split('\n');
      console.error(`  —— ${suite} 失败，输出尾部 ——\n${out.slice(-15).join('\n')}`);
    }
    results.push(`${suite} ${r.status === 0 ? '✓' : '✗'}`);
  }
  console.log(`第 ${String(round).padStart(2, '0')} 轮  ${results.join('  ')}`);
}

console.log(`\n${ROUNDS} 轮 × ${SUITES.length} 套 = ${ROUNDS * SUITES.length} 次运行，失败 ${failures} 次`);
if (failures > 0) {
  console.error('稳定性连跑：存在失败 ✗');
  process.exitCode = 1;
} else {
  console.log('稳定性连跑：全部通过 ✓');
}
