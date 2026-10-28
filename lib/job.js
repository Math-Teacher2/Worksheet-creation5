// 단원 전체를 "차시별로 나눠" 만드는 작업 진행기.
//  1) 차시 계획: 축소 이미지·글자로 차시와 쪽 범위를 정함 (가벼운 요청 1번)
//  2) 차시마다: 그 차시 쪽만 보내 학습지 JSON 작성 → (선택) 검산
//  3) 끝난 차시는 바로 화면에 붙이고 저장. 오류가 나도 끝난 차시는 남고, [이어서 만들기]로 나머지만 만듦

import { generate } from './llm';
import { LlmError, explainError, STOP_KINDS } from './errors';
import { buildSystemPrompt, buildChunkInstruction, PLAN_SYSTEM, buildPlanInstruction, VERIFY_SYSTEM, buildVerifyInstruction } from './prompt';
import { parseModelJson } from './jsonRepair';
import { normalizeDoc, collectAnswerItems, applyAnswerFixes } from './doc';

const str = (v) => (v === undefined || v === null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

export function jobKey(file, pagesSpec) {
  return file ? `${file.name}|${file.size}|${str(pagesSpec).trim()}` : '';
}

export function newJob({ file, pagesSpec, guideKey = '' }) {
  return {
    v: 1,
    key: jobKey(file, pagesSpec),
    fileName: file?.name || '',
    fileSize: file?.size || 0,
    pagesSpec: str(pagesSpec).trim(),
    guideKey,
    createdAt: Date.now(),
    plan: null,
    chunks: [],
    usage: { input: 0, output: 0 },
    requests: 0,
  };
}

export const chunkName = (ch) => {
  const ls = ch.lessons || [];
  if (ls.length && ls[0].auto) return `교과서 ${ch.pages[0]}~${ch.pages[ch.pages.length - 1]}쪽`;
  const nos = ls.map((l) => l.no);
  return nos.length > 1 ? `${nos[0]}~${nos[nos.length - 1]}차시` : `${nos[0]}차시`;
};

export function jobProgress(job) {
  if (!job || !job.chunks.length) return { done: 0, total: 0, failed: 0, complete: false };
  const done = job.chunks.filter((c) => c.status === 'done').length;
  const failed = job.chunks.filter((c) => c.status === 'fail').length;
  return { done, total: job.chunks.length, failed, complete: done === job.chunks.length };
}

export function estimateRequests(job, { verify, pages, hasGuide, perChunk }) {
  const planReq = job?.plan ? 0 : pages > 4 || hasGuide ? 1 : 0;
  const nChunks = job?.chunks?.length ? job.chunks.filter((c) => c.status !== 'done').length : Math.max(1, Math.ceil(pages / (3 * (perChunk || 1))));
  return { plan: planReq, chunks: nChunks, total: planReq + nChunks * (verify ? 2 : 1), approx: !job?.chunks?.length };
}

function normalizePlan(raw, pages, guideRefs) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const lessons = arr(src.lessons)
    .map((l) => {
      const o = l && typeof l === 'object' ? l : {};
      const pg = [...new Set(arr(o.pages).map((x) => parseInt(x, 10)).filter((x) => pages.includes(x)))].sort((a, b) => a - b);
      const gd = [...new Set(arr(o.guide).map((x) => str(x).trim().toUpperCase()).filter((x) => guideRefs.includes(x)))];
      return {
        chapterNo: str(o.chapterNo).trim(),
        chapterTitle: str(o.chapterTitle),
        topic: str(o.topic),
        pages: pg,
        guide: gd,
        sections: arr(o.sections).map(str).filter((x) => x.trim()).slice(0, 4),
      };
    })
    .filter((l) => l.pages.length);
  lessons.forEach((l, i) => (l.no = i + 1));
  return { subject: str(src.subject), unit: str(src.unit), lessons };
}

function fallbackPlan(pages) {
  const lessons = [];
  for (let i = 0; i < pages.length; i += 3) lessons.push({ no: lessons.length + 1, pages: pages.slice(i, i + 3), guide: [], auto: true, sections: [] });
  return { subject: '', unit: '', lessons, fallback: true };
}

function groupChunks(plan, perChunk) {
  const chunks = [];
  const n = plan.lessons.some((l) => l.auto) ? 1 : Math.max(1, perChunk || 1);
  for (let i = 0; i < plan.lessons.length; i += n) {
    const ls = plan.lessons.slice(i, i + n);
    chunks.push({
      id: chunks.length,
      lessons: ls,
      pages: [...new Set(ls.flatMap((l) => l.pages))].sort((a, b) => a - b),
      guide: [...new Set(ls.flatMap((l) => l.guide || []))],
      status: 'todo',
      error: null,
      usage: { input: 0, output: 0 },
    });
  }
  return chunks;
}

function prefixFigures(d, pre) {
  const map = new Map(d.figures.map((f) => [f.id, `${pre}${f.id}`]));
  const m = (id) => map.get(id) || id;
  d.figures.forEach((f) => (f.id = m(f.id)));
  d.lessons.forEach((l) =>
    l.sections.forEach((s) =>
      s.blocks.forEach((b) => {
        b.figures = (b.figures || []).map(m);
        if (b.type === 'problems') b.items.forEach((it) => (it.figures = (it.figures || []).map(m)));
      })
    )
  );
  return d;
}

// 끝난 차시를 문서에 끼워 넣음 (같은 묶음의 이전 결과는 교체)
export function mergeChunk(doc, chunkId, chunkDoc, order, subject) {
  const pos = (c) => {
    const i = order.indexOf(c);
    return i < 0 ? 1e9 : i;
  };
  const keep = (doc?.lessons || []).filter((l) => l.chunk !== chunkId);
  const add = chunkDoc.lessons.map((l) => ({ ...l, chunk: chunkId }));
  const lessons = [...keep, ...add].sort((a, b) => pos(a.chunk) - pos(b.chunk));
  const pre = `k${chunkId}_`;
  const figures = [...(doc?.figures || []).filter((f) => !String(f.id).startsWith(pre)), ...chunkDoc.figures];
  return normalizeDoc({
    subject: subject || doc?.subject || chunkDoc.subject,
    unit: doc?.unit || chunkDoc.unit,
    lessons,
    figures,
  });
}

/**
 * p: {
 *   llm: {provider, model, apiKey, baseUrl, useProxy}, file, pages:[PDF쪽], guide:[{ref,label,file,page}],
 *   composition, content, subject, scope, extra, verify, rulerMode, imageWidth,
 *   job, only(차시 묶음 id, 선택), signal,
 *   cb: { status(text), log({level,text,error}), update(job), chunkDone(chunkId, chunkDoc, order) }
 * }
 */
export async function runJob(p) {
  const { file, pages, guide = [], composition, content, subject, scope, extra, verify, rulerMode, imageWidth, signal, cb, only } = p;
  const { renderForAi, renderEntry } = await import('./pdfClient');
  const job = structuredClone(p.job);
  const llm = { ...p.llm };
  const guideMap = new Map(guide.map((g) => [g.ref, g]));
  const save = () => cb.update(structuredClone(job));

  const call = async (args, label) => {
    job.requests++;
    const r = await generate({
      ...llm,
      thinking: content.thinking,
      fallback: content.fallback,
      signal,
      onStatus: (m, info) => {
        cb.status(`${label}: ${m}`);
        cb.log({ level: info?.kind === 'fallback' ? 'warn' : 'wait', text: `[${label}] ${m}`, error: info?.error ? explainError(info.error) : null });
      },
      ...args,
    });
    job.usage.input += r.usage?.input || 0;
    job.usage.output += r.usage?.output || 0;
    if (r.model && r.model !== llm.model) {
      cb.log({ level: 'warn', text: `이후 요청은 ${r.model} 모델로 보냅니다(원래 모델이 계속 바빠서).` });
      llm.model = r.model;
    }
    save();
    return r;
  };

  // ----- 1) 차시 계획 -----
  if (!job.plan) {
    if (pages.length <= 4 && !guide.length) {
      job.plan = { subject: '', unit: '', lessons: [{ no: 1, pages, guide: [], auto: true, sections: [] }] };
    } else {
      cb.status(`차시 계획을 세우려고 교과서 ${pages.length}쪽을 훑어보는 중...`);
      const parts = [];
      for (let i = 0; i < pages.length; i++) {
        const im = await renderForAi(file, pages[i], { width: 560, quality: 0.6 });
        parts.push({ type: 'text', text: `[교과서 PDF ${pages[i]}쪽] 글자 일부: ${(im.text || '').slice(0, 500) || '(없음)'}` });
        parts.push({ type: 'image', mime: im.mime, data: im.data, res: 'low' });
        cb.status(`차시 계획 준비 중... 교과서 (${i + 1}/${pages.length})`);
      }
      for (let i = 0; i < guide.length; i++) {
        const g = guide[i];
        const im = await renderEntry(g, { width: 560, quality: 0.6 });
        parts.push({ type: 'text', text: `[지도서 ${g.ref} · ${g.label}] 글자 일부: ${(im.text || '').slice(0, 400) || '(없음)'}` });
        parts.push({ type: 'image', mime: im.mime, data: im.data, res: 'low' });
        cb.status(`차시 계획 준비 중... 지도서 (${i + 1}/${guide.length})`);
      }
      parts.push({ type: 'text', text: buildPlanInstruction({ subject, scope, content, pageList: pages, guideRefs: guide.map((g) => g.ref) }) });
      try {
        const r = await call({ system: PLAN_SYSTEM, parts, json: true, maxTokens: 12000, thinking: 'low', onText: (t) => cb.status(`차시 계획을 세우는 중... (${t.length.toLocaleString()}자)`) }, '차시 계획');
        let plan;
        try {
          plan = normalizePlan(parseModelJson(r.text, { allowTruncated: true }), pages, guide.map((g) => g.ref));
        } catch {
          plan = { lessons: [] };
        }
        if (!plan.lessons.length) {
          cb.log({ level: 'warn', text: '차시 계획을 읽지 못해 교과서 3쪽씩 나눠 만듭니다.' });
          plan = fallbackPlan(pages);
        }
        job.plan = plan;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        const ex = explainError(e);
        cb.log({ level: 'error', text: `차시 계획 실패: ${ex.title}`, error: ex });
        throw Object.assign(e, { stopJob: true, stage: 'plan' });
      }
      const lessonsText = job.plan.lessons.map((l) => `${l.no}차시 ${l.topic || l.chapterTitle || ''}(${l.pages[0]}~${l.pages[l.pages.length - 1]}쪽)`).join(', ');
      cb.log({ level: 'info', text: `차시 계획: ${job.plan.lessons.length}차시 — ${lessonsText}` });
    }
    job.chunks = groupChunks(job.plan, content.perChunk);
    save();
  }

  // ----- 2) 차시별 작성 -----
  const order = job.chunks.map((c) => c.id);
  let prevTopic = '';
  for (const ch of job.chunks) {
    const skip = only !== undefined && only !== null ? ch.id !== only : ch.status === 'done';
    if (skip) {
      prevTopic = ch.lessons.map((l) => l.topic).filter(Boolean).join(', ') || prevTopic;
      continue;
    }
    ch.status = 'run';
    ch.error = null;
    save();
    const u0 = { ...job.usage };
    try {
      const d = await makeChunk(ch, prevTopic);
      ch.status = 'done';
      ch.lessonCount = d.lessons.length;
      ch.usage = { input: job.usage.input - u0.input, output: job.usage.output - u0.output };
      ch.model = llm.model;
      save();
      await cb.chunkDone(ch.id, d, order);
      prevTopic = d.lessons.map((l) => l.topic).filter(Boolean).join(', ');
    } catch (e) {
      ch.usage = { input: job.usage.input - u0.input, output: job.usage.output - u0.output };
      if (e.name === 'AbortError') {
        ch.status = 'todo';
        save();
        throw e;
      }
      const ex = explainError(e);
      ch.status = 'fail';
      ch.error = ex;
      save();
      cb.log({ level: 'error', text: `${chunkName(ch)} 실패: ${ex.title}`, error: ex });
      if (STOP_KINDS.has(e.kind)) throw Object.assign(e, { stopJob: true, stage: chunkName(ch) });
    }
  }
  return job;

  // ----- 차시 하나 만들기 -----
  async function makeChunk(ch, prev) {
    const label = chunkName(ch);
    cb.status(`${label}: 교과서 쪽을 준비하는 중...`);
    const imgs = [];
    for (const pg of ch.pages) imgs.push(await renderForAi(file, pg, { width: imageWidth, ruler: rulerMode }));
    const gimgs = [];
    for (const ref of ch.guide || []) {
      const g = guideMap.get(ref);
      if (g) gimgs.push({ g, im: await renderEntry(g, { width: 1100, quality: 0.72 }) });
    }
    if ((ch.guide || []).length && !gimgs.length) cb.log({ level: 'warn', text: `${label}: 지도서 파일이 없어 지도서 없이 만듭니다.` });
    const base = [{ type: 'text', text: '[교과서] 아래 페이지들이 학습지 내용의 유일한 근거입니다.' }];
    imgs.forEach((im) => {
      base.push({ type: 'text', text: `[교과서 PDF ${im.page}쪽] 추출 텍스트(참고, 수식 누락): ${im.text ? im.text.slice(0, 2000) : '(없음)'}` });
      base.push({ type: 'image', mime: im.mime, data: im.data, res: 'high' });
    });
    const gparts = [];
    if (gimgs.length) {
      gparts.push({ type: 'text', text: '[교사용 지도서] 지도 Tip·유의점·참고·정답 확인용입니다. 학생용 본문의 근거로 쓰지 않습니다.' });
      gimgs.forEach(({ g, im }) => {
        gparts.push({ type: 'text', text: `[${g.ref} · ${g.label}] 추출 텍스트: ${im.text ? im.text.slice(0, 1500) : '(없음)'}` });
        gparts.push({ type: 'image', mime: im.mime, data: im.data, res: 'medium' });
      });
    }
    const system = buildSystemPrompt({ rulerMode, composition, content, hasGuide: gimgs.length > 0 });
    const lessons = ch.lessons[0]?.auto ? null : ch.lessons;
    let mode = '';
    let d = null;
    for (let attempt = 0; attempt < 3 && !d; attempt++) {
      const instr = buildChunkInstruction({ subject, scope, extra, pageLabels: ch.pages.map(String), lessons, guideRefs: gimgs.map(({ g }) => g.ref), prev, mode });
      try {
        cb.status(`${label}: AI가 작성하는 중...`);
        const r = await call(
          {
            system,
            parts: [...base, ...gparts, { type: 'text', text: instr }],
            json: true,
            maxTokens: 40000,
            onText: (t) => {
              const blocks = (t.match(/"type"\s*:/g) || []).length;
              cb.status(`${label}: 작성하는 중... ${blocks}개 블록 · ${t.length.toLocaleString()}자`);
            },
          },
          label
        );
        const truncated = r.finish === 'MAX_TOKENS';
        if (truncated && mode !== 'concise' && attempt < 2) throw new LlmError('max-tokens', { model: r.model, raw: `출력 ${r.text.length.toLocaleString()}자에서 잘림` });
        let raw;
        try {
          raw = parseModelJson(r.text, { allowTruncated: truncated });
        } catch (pe) {
          throw new LlmError('parse', { model: r.model, raw: `${pe.message}\n…${r.text.slice(-300)}` });
        }
        const nd = normalizeDoc(raw);
        if (!nd.lessons.length || !nd.lessons.some((l) => l.sections.some((s) => s.blocks.length))) throw new LlmError(truncated ? 'max-tokens' : 'parse', { model: r.model, raw: '학습지 내용(lessons)이 비어 있음' });
        if (truncated) cb.log({ level: 'warn', text: `${label}: 출력 한도 때문에 끝부분이 조금 잘렸을 수 있습니다. 확인 후 이 차시만 다시 만들 수 있습니다.` });
        d = nd;
      } catch (e) {
        if (e.name === 'AbortError' || !(e instanceof LlmError) || attempt >= 2) throw e;
        if (e.kind === 'recitation' && mode !== 'paraphrase') {
          mode = 'paraphrase';
          cb.log({ level: 'warn', text: `${label}: 교과서 문장 반복으로 중단됨(RECITATION) → 설명을 학습지 문체로 바꿔 쓰도록 다시 요청합니다.`, error: explainError(e) });
          continue;
        }
        if (e.kind === 'max-tokens' && mode !== 'concise') {
          mode = 'concise';
          cb.log({ level: 'warn', text: `${label}: 결과가 길어 잘림 → 더 간결하게 다시 요청합니다.`, error: explainError(e) });
          continue;
        }
        if (['parse', 'safety', 'empty', 'stream-cut', 'max-tokens', 'recitation'].includes(e.kind)) {
          cb.log({ level: 'warn', text: `${label}: ${explainError(e).title} → 한 번 더 요청합니다.`, error: explainError(e) });
          continue;
        }
        throw e;
      }
    }

    // 차시 번호와 그림 id 정리
    if (lessons) {
      d.lessons.forEach((l, i) => {
        if (lessons[i]) l.no = lessons[i].no;
        else l.no = (d.lessons[i - 1]?.no || 0) + 1;
      });
    }
    prefixFigures(d, `k${ch.id}_`);
    const outside = d.figures.filter((f) => !ch.pages.includes(f.page));
    if (outside.length) cb.log({ level: 'warn', text: `${label}: 그림 ${outside.length}개가 이 차시 쪽 밖을 가리킵니다. 그림 아래 [✂ 위치 조정]으로 확인해 주세요.` });

    // 검산
    if (verify) {
      const items = collectAnswerItems(d);
      if (items.length) {
        cb.status(`${label}: 교과서와 대조해 문제·정답을 검산하는 중...`);
        try {
          const vparts = [];
          imgs.forEach((im) => {
            vparts.push({ type: 'text', text: `[교과서 PDF ${im.page}쪽]` });
            vparts.push({ type: 'image', mime: im.mime, data: im.data, res: 'high' });
          });
          gimgs.forEach(({ g, im }) => {
            vparts.push({ type: 'text', text: `[교사용 지도서 ${g.ref}]` });
            vparts.push({ type: 'image', mime: im.mime, data: im.data, res: 'medium' });
          });
          vparts.push({ type: 'text', text: buildVerifyInstruction(items, gimgs.length > 0) });
          const v = await call({ system: VERIFY_SYSTEM, parts: vparts, json: true, maxTokens: 16000, onText: (t) => cb.status(`${label}: 검산하는 중... (${t.length.toLocaleString()}자)`) }, `${label} 검산`);
          const fixes = parseModelJson(v.text, { allowTruncated: true }).fixes || [];
          const res = applyAnswerFixes(d, fixes);
          if (res.changed) {
            d = res.doc;
            cb.log({ level: 'info', text: `${label}: 검산에서 ${fixes.length}개 문항을 바로잡았습니다. ${fixes.map((x) => (x.reason ? `(${x.reason})` : '')).join(' ').slice(0, 200)}` });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          cb.log({ level: 'warn', text: `${label}: 검산은 실패해서 건너뛰었습니다 — ${explainError(e).title}`, error: explainError(e) });
        }
      }
    }
    return d;
  }
}
