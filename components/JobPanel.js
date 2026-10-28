'use client';

// 차시별 진행 상황, 오류 설명, 작업 기록
import { chunkName } from '../lib/job';

const STATUS = { todo: '대기', run: '작성 중', done: '완료', fail: '실패' };
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));

export function ErrorBox({ e, compact }) {
  if (!e) return null;
  return (
    <div className={`errbox ${compact ? 'compact' : ''}`} role="alert">
      <b>⚠ {e.title}</b>
      {e.stage ? <span className="muted"> · {e.stage}</span> : null}
      {e.why ? <p>{e.why}</p> : null}
      {e.fix ? <p className="fix">해결 방법: {e.fix}</p> : null}
      {e.raw ? (
        <details>
          <summary>자세히 (원문 메시지)</summary>
          <pre>{e.raw}</pre>
        </details>
      ) : null}
    </div>
  );
}

export default function JobPanel({ job, log, busy, onRetry }) {
  if (!job || !job.chunks?.length) {
    return log?.length ? <LogList log={log} /> : null;
  }
  const done = job.chunks.filter((c) => c.status === 'done').length;
  return (
    <div className="card jobcard">
      <div className="card-title">
        진행 상황 <span className="muted">({done}/{job.chunks.length} 완료)</span>
      </div>
      <p className="hint">
        AI 요청 {job.requests}회 · 사용 토큰 입력 {fmt(job.usage.input)} / 출력 {fmt(job.usage.output)}
        {job.plan?.fallback ? ' · 차시 계획 없이 3쪽씩 나눔' : ''}
      </p>
      <ol className="chunks">
        {job.chunks.map((ch) => {
          const l0 = ch.lessons[0] || {};
          const topic = ch.lessons.map((l) => l.topic || l.chapterTitle).filter(Boolean).join(', ');
          return (
            <li key={ch.id} className={`ch ${ch.status}`}>
              <div className="ch-row">
                <span className={`badge ${ch.status}`}>{busy && ch.status === 'run' ? '⏳ ' : ''}{STATUS[ch.status] || ch.status}</span>
                <b>{chunkName(ch)}</b>
                {topic ? <span className="topic">{topic}</span> : null}
                {!busy && ch.status !== 'run' && onRetry ? (
                  <button type="button" className="mini" onClick={() => onRetry(ch.id)} title="이 차시만 새로 만듭니다">
                    {ch.status === 'done' ? '↻ 다시' : '▶ 이것만'}
                  </button>
                ) : null}
              </div>
              <div className="ch-sub">
                교과서 {ch.pages[0]}{ch.pages.length > 1 ? `~${ch.pages[ch.pages.length - 1]}` : ''}쪽
                {ch.guide?.length ? ` · 지도서 ${ch.guide.length}쪽` : ''}
                {ch.usage && (ch.usage.input || ch.usage.output) ? ` · 토큰 ${fmt(ch.usage.input)}/${fmt(ch.usage.output)}` : ''}
                {ch.model && ch.status === 'done' ? ` · ${ch.model}` : ''}
                {l0.auto ? ' · 차시는 AI가 나눔' : ''}
              </div>
              {ch.status === 'fail' && ch.error ? <ErrorBox e={ch.error} compact /> : null}
            </li>
          );
        })}
      </ol>
      <LogList log={log} />
    </div>
  );
}

function LogList({ log }) {
  if (!log || !log.length) return null;
  const icon = { info: 'ℹ', warn: '△', wait: '⏱', error: '⚠' };
  return (
    <details className="joblog">
      <summary>작업 기록 ({log.length})</summary>
      <ul>
        {log.map((x, i) => (
          <li key={i} className={x.level}>
            <span className="t">{x.time}</span> {icon[x.level] || '·'} {x.text}
            {x.error && x.level !== 'wait' ? (
              <details>
                <summary>이유</summary>
                <ErrorBox e={x.error} compact />
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
