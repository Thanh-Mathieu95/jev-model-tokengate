const $ = (id) => document.getElementById(id);
const CRITS = ['CRIT-01', 'CRIT-02', 'CRIT-03', 'CRIT-04', 'CRIT-05'];

const panels = {
  traditional: { chat: $('cA'), meter: $('mA'), banner: $('bA'), lamps: $('lA'), canvas: $('gA'), log: $('gLA'), pts: [] },
  scb:         { chat: $('cB'), meter: $('mB'), banner: $('bB'), lamps: $('lB'), canvas: $('gB'), log: $('gLB'), pts: [] }
};

for (const p of Object.values(panels)) {
  p.lamps.innerHTML = CRITS.map((c) => `<span class="lamp" data-c="${c}">${c}</span>`).join('');
}

function drawGraph(p) {
  const ctx = p.canvas.getContext('2d');
  const { width: w, height: h } = p.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!p.pts.length) return;
  const max = Math.max(60, ...p.pts);
  // đường mốc 35ms (KPI Inline Interception Latency)
  const y35 = h - (35 / max) * (h - 8) - 4;
  ctx.strokeStyle = '#8494b055'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, y35); ctx.lineTo(w, y35); ctx.stroke(); ctx.setLineDash([]);
  const bw = w / Math.max(12, p.pts.length);
  p.pts.forEach((v, i) => {
    const bh = (v / max) * (h - 8);
    ctx.fillStyle = v <= 35 ? '#2fd48a' : '#ff4d5e';
    ctx.fillRect(i * bw + 1, h - bh - 4, Math.max(2, bw - 2), bh);
  });
  ctx.fillStyle = '#8494b0'; ctx.font = '10px ui-monospace,monospace';
  ctx.fillText(`max ${max.toFixed(0)}ms · 35ms KPI`, 6, 12);
}

function reset(p) {
  p.chat.textContent = '';
  p.chat.classList.remove('redacted');
  p.meter.innerHTML = '—<small> ms</small>';
  p.banner.className = p.banner.className.replace(' on', '');
  p.banner.textContent = '';
  p.log.textContent = '';
  p.pts = [];
  p.lamps.querySelectorAll('.lamp').forEach((l) => l.classList.remove('hot'));
  drawGraph(p);
}

function setBanner(p, kind, text) {
  p.banner.className = `banner ${kind} on`;
  p.banner.textContent = text;
}

function run(arch, scenario, delay, engine) {
  const p = panels[arch];
  reset(p);
  p.ranOn = null;
  return new Promise((resolve) => {
    const es = new EventSource(
      `/api/stream?arch=${arch}&scenario=${scenario}&guardrailDelay=${delay}&engine=${engine}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'token') p.chat.textContent += e.text;
      else if (e.type === 'eval') {
        p.meter.innerHTML = `${e.latencyMs.toFixed(1)}<small> ms · ${e.engine}</small>`;
        p.ranOn = e.engine;
        p.pts.push(e.latencyMs);
        drawGraph(p);
        for (const r of e.results) {
          if (!r.trigger) continue;
          p.lamps.querySelector(`[data-c="${r.id}"]`)?.classList.add('hot');
        }
      } else if (e.type === 'blocked') {
        setBanner(p, 'good', `⛔ [Luồng dữ liệu đã được ngắt tự động bởi Semantic Circuit Breaker] · ${e.criterion.id} ${e.criterion.name} · payload: ${JSON.stringify(e.payload)}`);
      } else if (e.type === 'replaced') {
        setBanner(p, 'warn', `⚠ ${e.text} (${e.criterion.id})`);
      } else if (e.type === 'redact') {
        p.chat.classList.add('redacted');
        setBanner(p, 'bad', `⚠ ${e.text} — nhưng nội dung mật đã hiển thị ${(e.t / 1000).toFixed(2)}s trước đó (${e.criterion.id})`);
      } else if (e.type === 'security_log') {
        p.log.textContent += `[SECURITY] ${e.criterion.id} ${e.criterion.name} @ ${e.at}\n`;
      } else if (e.type === 'error') {
        setBanner(p, 'bad', `Lỗi upstream: ${e.message}`);
      } else if (e.type === 'done') {
        if (!e.stats.tripped) setBanner(p, 'good', '✓ All Pass — luồng hoàn tất, không tiêu chí nào kích hoạt.');
        p.log.textContent += `evals=${e.stats.evalCount} p50=${e.stats.p50}ms p95=${e.stats.p95}ms p99=${e.stats.p99}ms leaked=${e.stats.leakedChars} chars\n`;
        es.close();
        resolve(e.stats);
      }
    };
    es.onerror = () => { es.close(); resolve(null); };
  });
}

function fillTable(a, b) {
  const put = (id, v) => { $(id).textContent = v ?? '—'; };
  put('kA', a && `${a.leakedChars}`); put('kB', b && `${b.leakedChars}`);
  put('p50A', a && `${a.p50} ms`);    put('p50B', b && `${b.p50} ms`);
  put('p95A', a && `${a.p95} ms`);    put('p95B', b && `${b.p95} ms`);
  put('p99A', a && `${a.p99} ms`);    put('p99B', b && `${b.p99} ms`);
  put('tA', a && (a.tripped || 'none')); put('tB', b && (b.tripped || 'none'));
  put('eA', a && `${a.evalCount}`);   put('eB', b && `${b.evalCount}`);
  put('gA2', panels.traditional.ranOn); put('gB2', panels.scb.ranOn);
}

let scenarios = [];
fetch('/api/scenarios').then((r) => r.json()).then((list) => {
  scenarios = list;
  $('scenario').innerHTML = list.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  showPrompt();
});

function showPrompt() {
  const s = scenarios.find((x) => x.id === $('scenario').value);
  $('promptText').textContent = s ? s.prompt : '—';
}
$('scenario').onchange = showPrompt;

fetch('/api/engines').then((r) => r.json()).then((list) => {
  $('engine').innerHTML = list.map((e) =>
    `<option value="${e.id}"${e.ready ? '' : ' disabled'}>${e.label}${e.ready ? '' : ' — thiếu key'}</option>`
  ).join('');
  const first = list.find((e) => e.ready && e.id !== 'local') || list[0];
  $('engine').value = first.id;
  syncTitle();
});
function syncTitle() {
  const label = $('engine').selectedOptions[0]?.textContent ?? '';
  $('titleB').textContent = `B · Circuit Breaker · ${label}`;
}
$('engine').onchange = syncTitle;

$('run').onclick = async () => {
  $('run').disabled = true;
  fillTable(null, null);
  const eng = $('engine').value;
  const [a, b] = await Promise.all([
    run('traditional', $('scenario').value, $('delay').value, eng),
    run('scb', $('scenario').value, $('delay').value, eng)
  ]);
  fillTable(a, b);
  $('run').disabled = false;
};

// ---- So sánh mọi engine, chạy ngay trên giao diện ----
const SCEN_LABEL = { leak: 'Jailbreak', pricing: 'Cam kết giá', pii: 'PII', harmful: 'Nguy hiểm', safe: 'An toàn' };

$('bench').onclick = () => {
  $('bench').disabled = true;
  $('run').disabled = true;
  $('benchWrap').style.display = '';
  $('benchRows').innerHTML = '';
  $('benchSummary').innerHTML = '';

  const engines = [...$('engine').options].filter((o) => !o.disabled).map((o) => o.value);
  const es = new EventSource(`/api/bench?engines=${engines.join(',')}`);
  let total = 0;
  let done = 0;

  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'start') {
      total = e.engines.length * e.scenarios.length;
      $('benchStatus').textContent = `0/${total} — Opus 5 có thể mất vài phút`;
    } else if (e.type === 'row') {
      const r = e.row;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.engine}</td>
        <td style="color:${r.ran === r.engine ? 'var(--dim)' : 'var(--warn)'}">${r.ran}</td>
        <td>${SCEN_LABEL[r.scenario] ?? r.scenario}</td>
        <td class="n">${r.trip}</td>
        <td class="n" style="color:${r.ok ? 'var(--good)' : 'var(--bad)'}">${r.ok ? '✓' : '✗'}</td>
        <td class="n" style="color:${r.leak ? 'var(--bad)' : 'var(--good)'}">${r.leak ? 'RÒ RỈ' : 'sạch'}</td>
        <td class="n">${r.p50} ms</td>
        <td class="n">${r.p95} ms</td>`;
      $('benchRows').appendChild(tr);
      $('benchStatus').textContent = `${++done}/${total}`;
    } else if (e.type === 'done') {
      for (const t of e.summary) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${t.engine}</b></td>
          <td class="n">${t.correct}</td>
          <td class="n" style="color:${t.fellBack ? 'var(--warn)' : 'var(--dim)'}">${t.fellBack || '—'}</td>
          <td class="n">${t.p50} ms</td>
          <td class="n" style="color:${t.leaks ? 'var(--bad)' : 'var(--good)'}">${t.leaks}</td>`;
        $('benchSummary').appendChild(tr);
      }
      $('benchStatus').textContent = `xong ${done}/${total}`;
      es.close();
      $('bench').disabled = false;
      $('run').disabled = false;
    } else if (e.type === 'error') {
      $('benchStatus').textContent = `lỗi: ${e.message}`;
      es.close();
      $('bench').disabled = false;
      $('run').disabled = false;
    }
  };
  es.onerror = () => {
    es.close();
    $('benchStatus').textContent = 'mất kết nối';
    $('bench').disabled = false;
    $('run').disabled = false;
  };
};
