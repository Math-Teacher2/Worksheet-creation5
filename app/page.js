'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ModelView from '../components/ModelView';
import CropEditor from '../components/CropEditor';
import CompositionEditor from '../components/CompositionEditor';
import LayoutPicker from '../components/LayoutPicker';
import JobPanel, { ErrorBox } from '../components/JobPanel';
import { PROVIDERS, generate } from '../lib/llm';
import { explainError } from '../lib/errors';
import { runJob, newJob, jobKey, jobProgress, mergeChunk, estimateRequests } from '../lib/job';
import { DEFAULT_CONTENT, normalizeContent, THINK_LABEL } from '../lib/content';
import {
  buildSystemPrompt,
  buildReviseInstruction,
  COMPOSITION_SYSTEM,
  COMPOSITION_INSTRUCTION,
  LAYOUT_SYSTEM,
  LAYOUT_INSTRUCTION,
} from '../lib/prompt';
import { parseModelJson } from '../lib/jsonRepair';
import { normalizeDoc } from '../lib/doc';
import { parsePageRange } from '../lib/pdfClient';
import { THEMES, getTheme, paletteFrom } from '../lib/themes';
import { LAYOUTS, getLayout, normalizeLayout } from '../lib/layouts';
import { DEFAULT_COMPOSITION, normalizeComposition, ACTIVITY_TYPES } from '../lib/composition';
import { layoutDocument } from '../lib/paginate';
import { SAMPLE_DOC } from '../lib/sample';
import { SAMPLE_IMAGES } from '../lib/sampleImages';

const LS = 'worksheet-settings-v3';
const loadSettings = () => {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}');
  } catch {
    return {};
  }
};
const saveSettings = (s) => {
  try {
    localStorage.setItem(LS, JSON.stringify(s));
  } catch {}
};
// 만들던 작업(차시 계획·끝난 차시)을 저장해 두고, 새로고침해도 이어서 만들 수 있게 함
const LS_JOB = 'worksheet-job-v1';
const loadJob = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_JOB) || 'null');
  } catch {
    return null;
  }
};
const saveJob = (v) => {
  try {
    if (v) localStorage.setItem(LS_JOB, JSON.stringify(v));
    else localStorage.removeItem(LS_JOB);
    return true;
  } catch {
    return false;
  }
};
const nowTime = () => new Date().toTimeString().slice(0, 8);

function downloadBlob(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60);

export default function Home() {
  // ----- AI 설정 -----
  const [provider, setProvider] = useState('gemini');
  const [conf, setConf] = useState({}); // {gemini:{key,model}, anthropic:{...}, compat:{key,model,baseUrl}}
  const [remember, setRemember] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // ----- 입력 -----
  const [sourceFile, setSourceFile] = useState(null);
  const [sourcePages, setSourcePages] = useState('');
  const [sourceCount, setSourceCount] = useState(0);
  const [compFile, setCompFile] = useState(null);
  const [compPages, setCompPages] = useState('');
  const [compAnalyzed, setCompAnalyzed] = useState(null); // 분석한 파일
  const [composition, setComposition] = useState(() => normalizeComposition(DEFAULT_COMPOSITION));
  const [layoutFile, setLayoutFile] = useState(null);
  const [layoutPages, setLayoutPages] = useState('');
  const [layoutId, setLayoutId] = useState('block');
  const [customLayout, setCustomLayout] = useState(null);
  const [customPalette, setCustomPalette] = useState(null);
  const [guideFiles, setGuideFiles] = useState([]);
  const [guidePages, setGuidePages] = useState('');
  const [content, setContent] = useState(() => normalizeContent(DEFAULT_CONTENT));
  const [subject, setSubject] = useState('');
  const [scope, setScope] = useState('');
  const [extra, setExtra] = useState('');
  const [verify, setVerify] = useState(true);
  const [themeId, setThemeId] = useState('auto');

  // ----- 결과 -----
  const [doc, setDoc] = useState(null);
  const [figs, setFigs] = useState({});
  const [teacherView, setTeacherView] = useState(false);
  const [isSample, setIsSample] = useState(false);

  // ----- 진행 상태 -----
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState(null); // {title, why, fix, raw}
  const [elapsed, setElapsed] = useState(0);
  const [job, setJob] = useState(null);
  const [log, setLog] = useState([]);
  const abortRef = useRef(null);
  const sourceImagesRef = useRef(null);
  const docRef = useRef(null);
  const figsRef = useRef({});
  const jobLoaded = useRef(false);
  const restoreCropRef = useRef('');

  // ----- 편집 -----
  const [cropTarget, setCropTarget] = useState(null); // {mode:'edit', id} | {mode:'add', path}
  const [reviseText, setReviseText] = useState('');
  const [jsonEdit, setJsonEdit] = useState(null);
  const [jsonErr, setJsonErr] = useState('');

  const pinfo = PROVIDERS[provider];
  const cur = conf[provider] || {};
  const model = cur.model || pinfo.defaultModel;
  const apiKey = (cur.key || '').trim();

  useEffect(() => {
    const s = loadSettings();
    if (s.provider && PROVIDERS[s.provider]) setProvider(s.provider);
    if (s.conf) setConf(s.conf);
    if (typeof s.remember === 'boolean') setRemember(s.remember);
    if (typeof s.useProxy === 'boolean') setUseProxy(s.useProxy);
    if (s.themeId) setThemeId(s.themeId);
    if (s.layoutId) setLayoutId(s.layoutId);
    if (s.customLayout) setCustomLayout(normalizeLayout(s.customLayout));
    if (s.customPalette) setCustomPalette(s.customPalette);
    if (s.composition) setComposition(normalizeComposition(s.composition));
    if (typeof s.verify === 'boolean') setVerify(s.verify);
    if (s.content) setContent(normalizeContent(s.content));
    const saved = loadJob();
    if (saved && saved.job) {
      setJob(saved.job);
      if (saved.doc) {
        const d = normalizeDoc(saved.doc);
        docRef.current = d;
        setDoc(d);
      }
      const pr = jobProgress(saved.job);
      setNotes([
        `지난번에 만들던 학습지(${saved.job.fileName}, ${pr.done}/${pr.total}차시 완료)를 불러왔습니다. 그림을 보거나 남은 차시를 만들려면 같은 교과서 PDF를 다시 올려 주세요.`,
      ]);
    }
    jobLoaded.current = true;
    setLoaded(true);
  }, []);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    figsRef.current = figs;
  }, [figs]);

  // 작업 저장 (샘플은 저장하지 않음)
  useEffect(() => {
    if (!jobLoaded.current || isSample) return;
    if (!job && !doc) return;
    const ok = saveJob({ job, doc, savedAt: Date.now() });
    if (!ok && doc) saveJob({ job, doc: null, savedAt: Date.now() });
  }, [job, doc, isSample]);

  useEffect(() => {
    if (!loaded) return;
    const keep = remember ? conf : Object.fromEntries(Object.entries(conf).map(([k, v]) => [k, { ...v, key: '' }]));
    saveSettings({ provider, conf: keep, remember, useProxy, themeId, layoutId, customLayout, customPalette, composition, verify, content });
  }, [loaded, provider, conf, remember, useProxy, themeId, layoutId, customLayout, customPalette, composition, verify, content]);

  // 레이아웃·색
  const layout = useMemo(() => getLayout(layoutId, customLayout), [layoutId, customLayout]);
  const theme = useMemo(() => {
    if (themeId === 'auto') return layoutId === 'custom' && customPalette ? customPalette : getTheme(layout.palette);
    return getTheme(themeId, customPalette);
  }, [themeId, layoutId, layout, customPalette]);

  // 쪽 배치 (HWPX와 미리보기가 같이 씀)
  const laid = useMemo(() => {
    if (!doc) return null;
    try {
      return layoutDocument(doc, { layout, theme, composition, figs });
    } catch (e) {
      console.error(e);
      return { error: e.message, lessons: [] };
    }
  }, [doc, layout, theme, composition, figs]);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!doc || isSample) return;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [doc, isSample]);

  const setCur = (patch) => setConf((c) => ({ ...c, [provider]: { ...(c[provider] || {}), ...patch } }));

  const onSourceFile = async (f) => {
    setSourceFile(f);
    setSourceCount(0);
    sourceImagesRef.current = null;
    if (!f) return;
    try {
      const { getPageCount } = await import('../lib/pdfClient');
      setSourceCount(await getPageCount(f));
    } catch (e) {
      setError(explainError(e));
    }
  };

  const llmArgs = () => ({
    provider,
    model,
    apiKey,
    baseUrl: provider === 'compat' ? cur.baseUrl || PROVIDERS.compat.defaultBaseUrl : undefined,
    useProxy,
  });

  const run = async (job) => {
    setError(null);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await job(ctrl.signal);
    } catch (e) {
      console.error(e);
      const ex = explainError(e);
      if (e.stage) ex.stage = e.stage;
      setError(ex);
    } finally {
      setStatus('');
      setBusy(false);
      abortRef.current = null;
    }
  };

  const addNote = (n) => setNotes((x) => [...x, n]);
  const addLog = (x) => setLog((l) => [...l.slice(-199), { time: nowTime(), ...x }]);

  const cropFigures = async (d, file, existing = {}) => {
    const { cropAll } = await import('../lib/figures');
    const need = d.figures.filter((f) => !existing[f.id]);
    if (!need.length) return existing;
    setStatus(`교과서 그림을 잘라오는 중... (0/${need.length})`);
    const got = await cropAll(file, need, (i, n) => setStatus(`교과서 그림을 잘라오는 중... (${i}/${n})`));
    return { ...existing, ...got };
  };

  // 저장된 작업을 불러온 뒤 같은 교과서를 올리면 그림을 다시 잘라 옴
  useEffect(() => {
    if (!sourceFile || !doc || isSample || busy) return;
    if (job && !job.key.startsWith(`${sourceFile.name}|${sourceFile.size}|`)) return;
    const missing = doc.figures.filter((f) => !figs[f.id]);
    const sig = `${sourceFile.name}|${missing.map((f) => f.id).join(',')}`;
    if (!missing.length || restoreCropRef.current === sig) return;
    restoreCropRef.current = sig;
    (async () => {
      try {
        const f = await cropFigures(doc, sourceFile, figs);
        setFigs(f);
      } catch (e) {
        console.error(e);
      } finally {
        setStatus('');
      }
    })();
  }, [sourceFile, doc, isSample, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const needKey = () => {
    if (!apiKey) {
      setError({ title: `${pinfo.label} API 키를 입력해 주세요.`, why: '구성·레이아웃 분석과 학습지 만들기에 AI를 씁니다.', fix: '① AI 선택에서 키를 입력해 주세요.' });
      return true;
    }
    return false;
  };

  // 구성 참고 학습지 분석 → "내 학습지 구성"
  const analyzeComposition = async (signal) => {
    const { prepareTemplate } = await import('../lib/pdfClient');
    setStatus('구성 참고 학습지를 분석하는 중...');
    const tpl = await prepareTemplate(compFile, compPages || '1-6');
    const parts = [];
    tpl.images.forEach((im, i) => {
      parts.push({ type: 'text', text: `[학습지 ${i + 1}쪽]` });
      parts.push({ type: 'image', ...im, res: 'medium' });
    });
    parts.push({ type: 'text', text: COMPOSITION_INSTRUCTION });
    const r = await generate({
      ...llmArgs(),
      system: COMPOSITION_SYSTEM,
      parts,
      json: true,
      maxTokens: 6000,
      thinking: 'low',
      fallback: content.fallback,
      signal,
      onStatus: (m, info) => {
        setStatus(`구성 분석: ${m}`);
        addLog({ level: 'wait', text: `[구성 분석] ${m}`, error: info?.error ? explainError(info.error) : null });
      },
      onText: (t) => setStatus(`구성 참고 학습지를 분석하는 중... (${t.length}자)`),
    });
    const c = normalizeComposition(parseModelJson(r.text, { allowTruncated: true }));
    setComposition(c);
    setCompAnalyzed(compFile);
    const offNames = c.activities.filter((a) => !a.use).map((a) => ACTIVITY_TYPES[a.type].split(' (')[0]);
    addNote(`구성 참고 학습지를 분석해 "내 학습지 구성"에 반영했습니다. 각 활동의 역할(도입·개념 도입 예시·개념 정리·확인하기·예제·문제…)이 맞는지 확인해 주세요.${offNames.length ? ` 학습지에 없던 역할(${offNames.join(', ')})은 꺼 두었습니다. 넣고 싶으면 체크하세요.` : ''}`);
    return c;
  };

  // 레이아웃 참고 파일 분석 → 맞춤 레이아웃
  const analyzeLayout = () => {
    if (needKey() || !layoutFile) return;
    run(async (signal) => {
      const { prepareTemplate } = await import('../lib/pdfClient');
      setStatus('레이아웃 참고 파일을 분석하는 중...');
      const tpl = await prepareTemplate(layoutFile, layoutPages || '1-2');
      const parts = [];
      tpl.images.forEach((im) => parts.push({ type: 'image', ...im, res: 'medium' }));
      parts.push({ type: 'text', text: LAYOUT_INSTRUCTION });
      const r = await generate({ ...llmArgs(), system: LAYOUT_SYSTEM, parts, json: true, maxTokens: 3000, thinking: 'low', fallback: content.fallback, signal, onStatus: (m) => setStatus(`레이아웃 분석: ${m}`) });
      const raw = parseModelJson(r.text, { allowTruncated: true });
      const L = normalizeLayout(raw, raw.base);
      const pal = paletteFrom(raw.primary, raw.accent, `${L.name} 색`);
      setCustomLayout({ ...L, palette: 'custom' });
      setCustomPalette(pal);
      setLayoutId('custom');
      setThemeId('auto');
      addNote(`레이아웃 참고 파일을 분석해 "${L.name}" 레이아웃을 만들었습니다. 레이아웃 목록 맨 끝에서 고를 수 있습니다.`);
    });
  };

  const analyzeCompositionClick = () => {
    if (needKey() || !compFile) return;
    run((signal) => analyzeComposition(signal));
  };

  const curKey = jobKey(sourceFile, sourcePages);
  const prog = jobProgress(job);
  const resumable = !!(job && sourceFile && job.key === curKey && job.plan && !prog.complete);
  const guideKey = guideFiles.map((f) => `${f.name}|${f.size}`).join(',');

  // 학습지 만들기: fresh=true면 처음부터, only=차시 묶음 하나만 다시
  const startJob = (fresh, only) => {
    if (!apiKey) return needKey();
    if (!model) return setError({ title: '모델 이름을 입력해 주세요.', why: '', fix: '' });
    if (!sourceFile) return setError({ title: '교과서 PDF를 올려 주세요.', why: '', fix: '② 교과서에서 PDF 파일을 고르세요.' });
    const restart = fresh || !job || job.key !== curKey;
    if (restart) {
      docRef.current = null;
      figsRef.current = {};
      setDoc(null);
      setFigs({});
      setLog([]);
      setNotes([]);
    }
    run(async (signal) => {
      const { parsePageRange, getPageCount, guideEntries } = await import('../lib/pdfClient');
      let comp = composition;
      if (compFile && compAnalyzed !== compFile) comp = await analyzeComposition(signal);
      const total = sourceCount || (await getPageCount(sourceFile));
      const pages = parsePageRange(sourcePages, total).slice(0, 80);
      const guide = guideFiles.length ? await guideEntries(guideFiles, guidePages) : [];
      let j = restart ? newJob({ file: sourceFile, pagesSpec: sourcePages, guideKey }) : job;
      if (!restart && j.guideKey !== guideKey && guide.length) addLog({ level: 'warn', text: '지도서 파일이 처음과 달라졌습니다. 남은 차시는 지금 올린 지도서 기준으로 만듭니다.' });
      setJob(j);
      addLog({ level: 'info', text: restart ? `시작: 교과서 ${pages.length}쪽${guide.length ? `, 지도서 ${guide.length}쪽` : ''} · ${model}` : only !== undefined ? '선택한 차시만 다시 만듭니다.' : '이어서 만듭니다(끝난 차시는 그대로 둠).' });
      const final = await runJob({
        llm: llmArgs(),
        file: sourceFile,
        pages,
        guide,
        composition: comp,
        content,
        subject,
        scope,
        extra,
        verify,
        rulerMode: !pinfo.nativeBoxes,
        imageWidth: pinfo.imageWidth,
        job: j,
        only,
        signal,
        cb: {
          status: setStatus,
          log: addLog,
          update: (nj) => {
            j = nj;
            setJob(nj);
          },
          chunkDone: async (chunkId, chunkDoc, order) => {
            const merged = mergeChunk(docRef.current, chunkId, chunkDoc, order, subject.trim());
            docRef.current = merged;
            setIsSample(false);
            setDoc(merged);
            const f = await cropFigures(merged, sourceFile, figsRef.current);
            figsRef.current = f;
            setFigs(f);
          },
        },
      });
      const pr = jobProgress(final);
      if (pr.complete) {
        addLog({ level: 'info', text: `완료: ${final.chunks.length}묶음 모두 만들었습니다.` });
        setNotes(['그림이 어긋났으면 그림 아래 [✂ 위치 조정]을, 빠진 그림은 각 칸의 [+ 그림]을 눌러 직접 지정할 수 있습니다.']);
      } else if (pr.failed) {
        setError({
          title: `${pr.failed}개 차시를 만들지 못했습니다`,
          why: `진행 상황에서 실패한 차시마다 이유를 확인할 수 있습니다.${pr.done ? ` 나머지 ${pr.done}개는 정상적으로 만들어졌습니다.` : ''}`,
          fix: '[이어서 만들기]를 누르면 실패한 차시만 다시 만듭니다.',
        });
      }
    });
  };

  const handleRevise = () => {
    if (!doc || !reviseText.trim()) return;
    if (!apiKey) return needKey();
    run(async (signal) => {
      setStatus('수정 요청을 반영하는 중...');
      const r = await generate({
        ...llmArgs(),
        system: buildSystemPrompt({ rulerMode: !pinfo.nativeBoxes, composition, content, hasGuide: guideFiles.length > 0 }),
        parts: [{ type: 'text', text: buildReviseInstruction(JSON.stringify(doc), reviseText.trim()) }],
        json: true,
        maxTokens: 48000,
        thinking: content.thinking,
        fallback: content.fallback,
        signal,
        onStatus: (m) => setStatus(`수정 반영: ${m}`),
        onText: (t) => setStatus(`수정 요청을 반영하는 중... (${t.length.toLocaleString()}자)`),
      });
      if (r.finish === 'MAX_TOKENS') throw Object.assign(new Error('수정 결과가 너무 길어 잘렸습니다. 요청을 나눠서 해 주세요(예: 차시 하나씩).'), { kind: 'max-tokens' });
      const d = normalizeDoc(parseModelJson(r.text));
      if (!d.lessons.length) throw Object.assign(new Error('수정 결과가 비어 있습니다.'), { kind: 'parse' });
      // 차시 묶음 표시를 이어 붙임(나중에 그 차시만 다시 만들 때 필요)
      if (d.lessons.length === doc.lessons.length) d.lessons.forEach((l, i) => doc.lessons[i].chunk !== undefined && (l.chunk = doc.lessons[i].chunk));
      setDoc(d);
      if (sourceFile && !isSample) setFigs(await cropFigures(d, sourceFile, figs));
      setReviseText('');
    });
  };

  // ----- 그림 편집 -----
  const onEditFigure = useCallback((id) => setCropTarget({ mode: 'edit', id }), []);
  const onAddFigure = useCallback((path) => setCropTarget({ mode: 'add', path }), []);
  const onRemoveFigure = useCallback((id) => {
    setDoc((d) => {
      const n = structuredClone(d);
      n.lessons.forEach((l) =>
        l.sections.forEach((s) =>
          s.blocks.forEach((b) => {
            b.figures = (b.figures || []).filter((x) => x !== id);
            if (b.items && b.type === 'problems') b.items.forEach((it) => (it.figures = (it.figures || []).filter((x) => x !== id)));
          })
        )
      );
      return n;
    });
  }, []);

  const applyCrop = async ({ page, box, refine }) => {
    const { cropFigure } = await import('../lib/figures');
    if (cropTarget.mode === 'edit') {
      const id = cropTarget.id;
      const fig = await cropFigure(sourceFile, { id, page, box }, { refine, grow: false });
      setFigs((f) => ({ ...f, [id]: fig }));
      setDoc((d) => ({ ...d, figures: d.figures.map((x) => (x.id === id ? { ...x, page: fig.page, box: fig.box } : x)) }));
    } else {
      const id = `u${Date.now().toString(36)}`;
      const fig = await cropFigure(sourceFile, { id, page, box }, { refine, grow: false });
      const [li, si, bi] = cropTarget.path;
      setFigs((f) => ({ ...f, [id]: fig }));
      setDoc((d) => {
        const n = structuredClone(d);
        n.figures.push({ id, page: fig.page, box: fig.box, desc: '' });
        const b = n.lessons[li].sections[si].blocks[bi];
        b.figures = [...(b.figures || []), id];
        return n;
      });
    }
    setCropTarget(null);
  };

  const cropInitial = useMemo(() => {
    if (!cropTarget || !doc) return null;
    if (cropTarget.mode === 'edit') return doc.figures.find((f) => f.id === cropTarget.id) || null;
    const lesson = doc.lessons[cropTarget.path?.[0]];
    const ch = job?.chunks?.find((c) => c.id === lesson?.chunk);
    const sec = lesson?.sections?.[cropTarget.path?.[1]];
    const near = doc.figures.find((f) => (sec?.blocks || []).some((b) => (b.figures || []).includes(f.id)));
    return { page: near?.page || ch?.pages?.[0] || job?.chunks?.[0]?.pages?.[0] || 1, box: null };
  }, [cropTarget, doc, job]);

  // ----- 내려받기 -----
  const downloadHwpx = async (mode) => {
    try {
      const { buildHwpx } = await import('../lib/hwpx');
      const { dataUrlToBytes } = await import('../lib/figures');
      const images = {};
      Object.entries(figs).forEach(([id, f]) => {
        if (f && f.dataUrl) images[id] = { bytes: dataUrlToBytes(f.dataUrl), ext: 'png', w: f.w, h: f.h, frac: f.frac };
      });
      if (!laid || laid.error) throw new Error(laid?.error || '쪽 배치를 만들지 못했습니다.');
      const l0 = doc.lessons[0];
      const preview = doc.lessons.map((l) => `${doc.subject} ${l.chapterNo} ${l.chapterTitle} ${l.topic} (${l.no}차시)`).join('\r\n');
      const bytes = buildHwpx(laid, { mode, images, theme, title: `${doc.subject || '학습지'} ${l0?.chapterTitle || ''}`.trim(), previewText: preview });
      const name = `${safeName(doc.subject || '학습지')}_${safeName(l0?.chapterTitle || l0?.topic || '')}_${mode === 'teacher' ? '교사용' : '학생용'}.hwpx`;
      downloadBlob(bytes, name, 'application/hwp+zip');
    } catch (e) {
      setError({ title: `HWPX 만들기 실패: ${e.message}`, why: '', fix: '', raw: e.stack || '' });
    }
  };

  const showSample = () => {
    setDoc(normalizeDoc(SAMPLE_DOC));
    setFigs(Object.fromEntries(Object.entries(SAMPLE_IMAGES).map(([k, v]) => [k, { ...v, id: k }])));
    setIsSample(true);
    setError(null);
    setNotes(['샘플 학습지입니다. API 키 없이 화면과 HWPX 모양을 확인할 수 있습니다.']);
  };

  const canEditFigs = !!sourceFile && !isSample && !busy;

  return (
    <main>
      <aside className="panel no-print">
        <h1>📝 맞춤형 학습지 생성기</h1>
        <p className="hint">교과서 PDF를 올리면 교과서 문제·그림을 그대로 담은 컬러 학습지를 학생용·교사용 HWPX로 만들어 줍니다.</p>

        <div className="card">
          <div className="card-title">① AI 선택</div>
          <label>
            AI 회사
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {Object.entries(PROVIDERS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{pinfo.note}</p>
          <label>
            모델
            {pinfo.models.length ? (
              <select value={pinfo.models.some((m) => m.id === model) ? model : '__custom'} onChange={(e) => setCur({ model: e.target.value === '__custom' ? '' : e.target.value })}>
                {pinfo.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="__custom">직접 입력...</option>
              </select>
            ) : null}
            {!pinfo.models.length || !pinfo.models.some((m) => m.id === model) ? (
              <input value={cur.model || ''} onChange={(e) => setCur({ model: e.target.value })} placeholder={provider === 'compat' ? '예: anthropic/claude-sonnet-5.5' : '모델 이름'} />
            ) : null}
          </label>
          {provider === 'compat' ? (
            <label>
              API 주소 (Base URL)
              <input value={cur.baseUrl ?? PROVIDERS.compat.defaultBaseUrl} onChange={(e) => setCur({ baseUrl: e.target.value })} />
            </label>
          ) : null}
          <label>
            {pinfo.label} API 키
            <input type="password" value={cur.key || ''} onChange={(e) => setCur({ key: e.target.value })} placeholder={pinfo.keyHint} autoComplete="off" />
          </label>
          <p className="hint">
            키 발급:{' '}
            <a href={pinfo.keyUrl} target="_blank" rel="noreferrer">
              {pinfo.keyUrl.replace(/^https:\/\//, '')}
            </a>
            . 키는 내 브라우저에서 AI 회사로만 전송되고 이 사이트 서버에는 저장되지 않습니다.
          </p>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 이 브라우저에 키 기억하기
          </label>
          <details>
            <summary>고급 설정</summary>
            <label className="check">
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /> 서버 경유 연결 (직접 연결이 막힐 때만)
            </label>
            <p className="hint">켜면 요청이 이 사이트 서버(Vercel)를 거쳐 전달됩니다. 키는 저장하지 않지만 서버를 지나가며, 5분이 넘는 작업은 끊길 수 있습니다.</p>
          </details>
        </div>

        <div className="card">
          <div className="card-title">② 교과서 (필수)</div>
          <input type="file" accept="application/pdf" onChange={(e) => onSourceFile(e.target.files?.[0] || null)} />
          {sourceCount ? <p className="hint">총 {sourceCount}쪽</p> : null}
          <label>
            사용할 쪽 (PDF 쪽 번호, 예: 3-40)
            <input value={sourcePages} onChange={(e) => setSourcePages(e.target.value)} placeholder="비우면 전체 (최대 80쪽)" />
          </label>
          <p className="hint">한 단원 전체를 올려도 됩니다. 차시 계획을 세운 뒤 차시마다 따로 만들어서, 중간에 오류가 나도 끝난 차시는 남고 남은 차시만 이어서 만듭니다.</p>
        </div>

        <div className="card">
          <div className="card-title">③ 교사용 교과서·지도서 (선택)</div>
          <input type="file" accept="application/pdf,image/*" multiple onChange={(e) => setGuideFiles(Array.from(e.target.files || []))} />
          {guideFiles.some((f) => !(f.type || '').startsWith('image/')) ? (
            <label>
              사용할 쪽 (지도서 PDF 쪽 번호)
              <input value={guidePages} onChange={(e) => setGuidePages(e.target.value)} placeholder="비우면 전체 (최대 60쪽)" />
            </label>
          ) : null}
          {guideFiles.length ? <p className="hint">{guideFiles.length === 1 ? guideFiles[0].name : `이미지 ${guideFiles.length}장`}</p> : null}
          <p className="hint">지도 TIP·지도 방향·유의점은 교사용 학습지에 작은 코멘트로, 생각을 넓힐 거리는 "생각해보기"로, 고등학교 범위를 넘는 "참고" 내용은 교사용에만 넣습니다. 교과서와 쪽 번호가 달라도 내용으로 맞춥니다.</p>
        </div>

        <div className="card">
          <div className="card-title">④ 내 학습지 구성</div>
          <label>
            구성 참고 학습지 (선택, PDF/이미지)
            <input type="file" accept="application/pdf,image/*" onChange={(e) => setCompFile(e.target.files?.[0] || null)} />
          </label>
          {compFile ? (
            <>
              <label>
                분석할 쪽 (예: 1-6)
                <input value={compPages} onChange={(e) => setCompPages(e.target.value)} placeholder="비우면 앞 6쪽" />
              </label>
              <button type="button" className="ghost" onClick={analyzeCompositionClick} disabled={busy}>
                {compAnalyzed === compFile ? '구성 다시 분석' : '이 학습지의 구성 분석하기'}
              </button>
            </>
          ) : null}
          <p className="hint">평소 학습지를 올리면 활동 순서·이름과 기출·수능특강 같은 교사 작성 칸을 찾아 아래에 채웁니다. 직접 고쳐도 됩니다.</p>
          <details open>
            <summary>구성 보기·고치기</summary>
            <CompositionEditor value={composition} onChange={setComposition} />
            <button type="button" className="mini" onClick={() => setComposition(normalizeComposition(DEFAULT_COMPOSITION))}>
              기본 구성으로 되돌리기
            </button>
          </details>
        </div>

        <div className="card">
          <div className="card-title">⑤ 레이아웃</div>
          <LayoutPicker value={layoutId} onChange={setLayoutId} custom={customLayout} customTheme={customPalette} />
          <label>
            색
            <select value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              <option value="auto">레이아웃 기본색</option>
              {Object.entries(THEMES).map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}
                </option>
              ))}
              {customPalette ? <option value="custom">{customPalette.name}</option> : null}
            </select>
          </label>
          <label>
            레이아웃 참고 파일 (선택, 모양만 참고)
            <input type="file" accept="application/pdf,image/*" onChange={(e) => setLayoutFile(e.target.files?.[0] || null)} />
          </label>
          {layoutFile ? (
            <>
              <label>
                참고할 쪽 (예: 1-2)
                <input value={layoutPages} onChange={(e) => setLayoutPages(e.target.value)} placeholder="비우면 앞 2쪽" />
              </label>
              <button type="button" className="ghost" onClick={analyzeLayout} disabled={busy}>
                이 파일의 레이아웃 분석해서 추가
              </button>
            </>
          ) : null}
          <p className="hint">레이아웃은 만든 뒤에도 바꿀 수 있고, 미리보기와 HWPX에 바로 반영됩니다.</p>
        </div>

        <div className="card">
          <div className="card-title">⑥ 내용 설정</div>
          <label>
            과목명
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="예: 미적분Ⅰ (비우면 교과서에서 읽음)" />
          </label>
          <p className="hint">무엇을 어떤 순서로 넣을지와 확인하기·예제·문제의 양(전부/대표 문항만)은 ④ 내 학습지 구성에서 정합니다. 개념 빈칸과 풀이 공간은 문항마다 알맞게 정합니다.</p>
          <label>
            만들 범위·차시 (선택)
            <textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="예: 1차시 함수의 수렴과 발산(10~13쪽), 2차시 우극한과 좌극한(15~17쪽)" />
          </label>
          <label>
            추가 요청 (선택)
            <textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="예: 생각해보기는 차시마다 1개" />
          </label>
          <label className="check">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> 교과서와 대조해 문제·정답 검산 (권장, 요청 수 2배)
          </label>
          <details>
            <summary>속도·안정성 설정</summary>
            <div className="opt-grid">
              <label>
                AI 생각 깊이
                <select value={content.thinking} onChange={(e) => setContent((c) => ({ ...c, thinking: e.target.value }))}>
                  {Object.entries(THINK_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                한 번에 만들 차시 수
                <select value={content.perChunk} onChange={(e) => setContent((c) => ({ ...c, perChunk: Number(e.target.value) }))}>
                  <option value={1}>1차시 (가장 안정적)</option>
                  <option value={2}>2차시 (요청 수 절약)</option>
                  <option value={3}>3차시</option>
                </select>
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={content.fallback} onChange={(e) => setContent((c) => ({ ...c, fallback: e.target.checked }))} /> 서버가 계속 바쁘면 같은 회사의 다른 모델로 자동 전환
            </label>
            <p className="hint">생각 깊이를 낮추면 빠르고 토큰을 덜 쓰지만 정답 정확도가 조금 떨어질 수 있습니다. "한 번에 만들 차시 수"를 늘리면 요청 수는 줄지만 한 번 실패할 때 다시 만들 양이 커집니다.</p>
          </details>
        </div>

        {sourceFile && !busy ? (
          <p className="hint est">
            {(() => {
              const est = estimateRequests(resumable ? job : null, { verify, pages: sourceCount ? parsePageRange(sourcePages, sourceCount).slice(0, 80).length : 0, hasGuide: guideFiles.length > 0, perChunk: content.perChunk });
              return `예상 AI 요청 수: ${est.approx ? '약 ' : ''}${est.total}회 (${est.plan ? '차시 계획 1회 + ' : ''}${est.approx ? '약 ' : ''}${est.chunks}묶음 × ${verify ? '작성·검산 2회' : '작성 1회'})`;
            })()}
          </p>
        ) : null}
        {resumable && !busy ? (
          <>
            <button type="button" onClick={() => startJob(false)}>
              ▶ 이어서 만들기 ({prog.done}/{prog.total} 완료{prog.failed ? `, 실패 ${prog.failed}` : ''})
            </button>
            <button type="button" className="secondary" onClick={() => startJob(true)}>
              처음부터 다시 만들기
            </button>
          </>
        ) : (
          <button type="button" onClick={() => startJob(true)} disabled={busy}>
            {busy ? '작업 중...' : '학습지 만들기'}
          </button>
        )}
        {busy ? (
          <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
            중단 (끝난 차시는 남음)
          </button>
        ) : null}
        {status ? (
          <p className="status">
            {status} <span className="muted">({elapsed}초)</span>
          </p>
        ) : null}
        <ErrorBox e={error} />
        {notes.map((n, i) => (
          <p key={i} className="note-msg">
            {n}
          </p>
        ))}
        <JobPanel job={job} log={log} busy={busy} onRetry={sourceFile && job && job.key === curKey ? (id) => startJob(false, id) : null} />
        {job && !busy ? (
          <button
            type="button"
            className="mini"
            onClick={() => {
              saveJob(null);
              setJob(null);
              setLog([]);
            }}
          >
            저장된 작업 기록 지우기
          </button>
        ) : null}

        {doc ? (
          <div className="card">
            <div className="card-title">⑦ 내려받기</div>
            {laid?.lessons?.map((L, i) => (L.warn ? <p key={i} className="note-msg">{L.warn}</p> : null))}
            <div className="seg">
              <button type="button" className={!teacherView ? 'on' : ''} onClick={() => setTeacherView(false)}>
                학생용 보기
              </button>
              <button type="button" className={teacherView ? 'on' : ''} onClick={() => setTeacherView(true)}>
                교사용 보기
              </button>
            </div>
            <button type="button" onClick={() => downloadHwpx('student')} disabled={busy}>
              ⬇ 학생용 HWPX
            </button>
            <button type="button" onClick={() => downloadHwpx('teacher')} disabled={busy}>
              ⬇ 교사용 HWPX (정답·풀이)
            </button>
            <button type="button" className="secondary" onClick={() => window.print()}>
              🖨 지금 보기를 PDF로 저장/인쇄
            </button>
            {!isSample ? (
              <>
                <label>
                  AI에게 수정 요청
                  <textarea rows={3} value={reviseText} onChange={(e) => setReviseText(e.target.value)} placeholder="예: 2차시 개념 확인 문항을 하나 더, 1차시 학습목표를 더 짧게" />
                </label>
                <button type="button" className="secondary" onClick={handleRevise} disabled={busy || !reviseText.trim()}>
                  수정 반영
                </button>
              </>
            ) : null}
            <button type="button" className="ghost" onClick={() => setJsonEdit(JSON.stringify(doc, null, 2))} disabled={busy}>
              내용 직접 고치기 (고급)
            </button>
          </div>
        ) : (
          <button type="button" className="ghost" onClick={showSample}>
            샘플 학습지 보기 (키 없이)
          </button>
        )}
      </aside>

      <section className="preview">
        {doc && laid && !laid.error ? (
          <ModelView
            laid={laid}
            figs={figs}
            teacher={teacherView}
            onEditFigure={canEditFigs ? onEditFigure : undefined}
            onRemoveFigure={canEditFigs ? onRemoveFigure : undefined}
            onAddFigure={canEditFigs ? onAddFigure : undefined}
          />        ) : (
          <div className="empty no-print">
            {laid?.error ? <p className="error">배치 오류: {laid.error}</p> : null}
            <p>
              왼쪽에서 AI와 키를 고르고 교과서 PDF를 올린 뒤 <b>학습지 만들기</b>를 누르세요.
            </p>
            <p className="hint">완성되면 여기에서 확인하고, 학생용·교사용 HWPX로 내려받을 수 있습니다.</p>
          </div>
        )}
      </section>

      {cropTarget && sourceFile ? (
        <CropEditor
          file={sourceFile}
          initial={cropInitial}
          title={cropTarget.mode === 'edit' ? '그림 위치 조정' : '이 칸에 넣을 교과서 그림 고르기'}
          onApply={applyCrop}
          onCancel={() => setCropTarget(null)}
        />
      ) : null}

      {jsonEdit !== null ? (
        <div className="modal no-print" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-head">
              <b>내용 직접 고치기</b>
              <span className="hint">문장·정답을 직접 고칠 수 있습니다. 수식은 $...$, 빈칸은 [[정답]] 표기를 지켜 주세요.</span>
            </div>
            <textarea className="json-edit" value={jsonEdit} onChange={(e) => setJsonEdit(e.target.value)} spellCheck={false} />
            {jsonErr ? <p className="error">{jsonErr}</p> : null}
            <div className="modal-foot">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setJsonEdit(null);
                  setJsonErr('');
                }}
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const d = normalizeDoc(JSON.parse(jsonEdit));
                    setDoc(d);
                    setJsonEdit(null);
                    setJsonErr('');
                  } catch (e) {
                    setJsonErr(`형식 오류: ${e.message} (쉼표·따옴표를 확인해 주세요)`);
                  }
                }}
              >
                적용
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
