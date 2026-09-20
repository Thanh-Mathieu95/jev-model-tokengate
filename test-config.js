// Test cho chính sách khai từ ngoài. Config sai phải NÉM, không được im lặng
// bỏ qua — một tiêu chí bị nuốt là một lỗ bảo mật không ai biết.
// Chạy: node test-config.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileConfig, compileCriterion } from './criteria.js';

async function t(name, fn) { await fn(); console.log(`  ok  ${name}`); }

const ok = (extra = {}) => ({ id: 'x', when: 'Nội dung làm điều gì đó', ...extra });

await t('file mẫu trong repo phải hợp lệ', async () => {
  const cfg = JSON.parse(readFileSync('tokengate.config.example.json', 'utf8'));
  const out = compileConfig(cfg, 'example');
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((c) => c.id), ['secret-leak', 'customer-pii', 'pricing-commit', 'internal-docs']);
  // action của config đổi sang mã nội bộ
  assert.equal(out[0].action, 'abort');
  assert.equal(out[2].action, 'replace');
  assert.equal(out[3].action, 'abort+log');
  // regex biên dịch được và bắt đúng
  const [re] = out[0].local[0];
  assert.ok(re.test('OPENAI_API_KEY = "sk-proj-123"'));
  assert.ok(!re.test('không có gì ở đây'));
  // tiêu chí không khai patterns vẫn hợp lệ, chỉ là không có heuristic dự phòng
  assert.deepEqual(out[3].local, []);
});

await t('mặc định hợp lý khi bỏ trống trường không bắt buộc', async () => {
  const c = compileCriterion(ok(), 0);
  assert.equal(c.name, 'x');           // thiếu name -> lấy id
  assert.equal(c.threshold, 0.8);
  assert.equal(c.action, 'abort');
  assert.deepEqual(c.local, []);
  assert.ok(c.no.includes('Nội dung làm điều gì đó')); // unless suy ra từ when
});

await t('config sai thì ném, kèm chỉ dẫn sửa ở đâu', async () => {
  const bad = [
    [{}, /thiếu "id"/],
    [ok({ id: '  ' }), /thiếu "id"/],
    [{ id: 'y' }, /thiếu "when"/],
    [ok({ threshold: 0 }), /threshold/],
    [ok({ threshold: 1.5 }), /threshold/],
    [ok({ threshold: 'cao' }), /threshold/],
    [ok({ action: 'xoá hết' }), /action/],
    [ok({ patterns: 'sk-' }), /patterns.*mảng/],
    [ok({ patterns: ['('] }), /regex không hợp lệ/],
    [ok({ patterns: [{ re: 'a', score: 9 }] }), /score/]
  ];
  for (const [input, re] of bad) {
    assert.throws(() => compileCriterion(input, 0), re, `lẽ ra phải ném: ${JSON.stringify(input)}`);
  }
});

await t('id trùng nhau bị chặn', async () => {
  assert.throws(
    () => compileConfig({ criteria: [ok(), ok()] }, 'test'),
    /trùng/
  );
});

await t('config rỗng hoặc sai hình dạng bị chặn', async () => {
  assert.throws(() => compileConfig(null, 'test'), /object JSON/);
  assert.throws(() => compileConfig({}, 'test'), /criteria/);
  assert.throws(() => compileConfig({ criteria: [] }, 'test'), /criteria/);
});

await t('thông báo lỗi có nêu tên file và số thứ tự tiêu chí', async () => {
  assert.throws(
    () => compileConfig({ criteria: [ok(), { id: 'z' }] }, 'chinh-sach.json'),
    (err) => /chinh-sach\.json/.test(err.message) && /#2/.test(err.message) && /\(z\)/.test(err.message)
  );
});

console.log('\nconfig checks passed');
