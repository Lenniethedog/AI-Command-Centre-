import type { UsageReport } from '../types';
import { Block, EmptyState } from './primitives';

/**
 * Usage built around questions worth asking:
 *   – which model is actually fast on this machine?
 *   – does higher effort earn the time it costs?
 *   – where does a mission's time go?
 *   – how often does this thing fail?
 *
 * Anything that would only be a vanity number is left out.
 */

const seconds = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Published cloud rates change; this is a clearly-labelled illustration. */
const CLOUD_RATE_PER_MTOK_IN = 3;
const CLOUD_RATE_PER_MTOK_OUT = 15;
const GBP_PER_USD = 0.79;

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'good' | 'warn';
}): React.JSX.Element {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value ${tone ? `stat__value--${tone}` : ''}`}>{value}</span>
      {detail && <span className="stat__detail">{detail}</span>}
    </div>
  );
}

/** Pads to a full fortnight so a quiet week reads as quiet, not as one wide bar. */
function lastFortnight(data: { day: string; missions: number }[]): { day: string; missions: number }[] {
  const counts = new Map(data.map((d) => [d.day, d.missions] as const));
  const days: { day: string; missions: number }[] = [];
  for (let back = 13; back >= 0; back--) {
    const date = new Date();
    date.setDate(date.getDate() - back);
    const key = date.toISOString().slice(0, 10);
    days.push({ day: key, missions: counts.get(key) ?? 0 });
  }
  return days;
}

function Bars({ data }: { data: { day: string; missions: number }[] }): React.JSX.Element {
  const series = lastFortnight(data);
  const peak = Math.max(...series.map((d) => d.missions), 1);
  return (
    <div className="bars" role="img" aria-label="Missions per day over the last two weeks">
      {series.map((point) => (
        <div key={point.day} className="bars__col" title={`${point.day}: ${point.missions}`}>
          <div className="bars__bar" style={{ height: `${(point.missions / peak) * 100}%` }} />
          <span className="bars__tick">{point.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export function UsageView({ usage }: { usage: UsageReport }): React.JSX.Element {
  if (usage.calls === 0) {
    return (
      <Block label="Usage">
        <EmptyState
          title="Nothing to measure yet"
          hint="Run a mission and this fills with real timings from your own hardware."
        />
      </Block>
    );
  }

  const successRate = usage.missions.total
    ? Math.round((usage.missions.completed / usage.missions.total) * 100)
    : 0;
  const taskFailRate = usage.tasks.total
    ? Math.round(((usage.tasks.failed + usage.tasks.skipped) / usage.tasks.total) * 100)
    : 0;

  const cloudUsd =
    (usage.tokensIn / 1e6) * CLOUD_RATE_PER_MTOK_IN +
    (usage.tokensOut / 1e6) * CLOUD_RATE_PER_MTOK_OUT;
  const cloudGbp = cloudUsd * GBP_PER_USD;

  const fastest = [...usage.byModel].sort((a, b) => b.tokensPerSecond - a.tokensPerSecond)[0];

  return (
    <>
      <Block label="At a glance">
        <div className="stats">
          <Stat
            label="Missions"
            value={String(usage.missions.total)}
            detail={`${usage.missions.completed} completed · ${usage.missions.failed} failed`}
          />
          <Stat
            label="Success rate"
            value={`${successRate}%`}
            tone={successRate >= 80 ? 'good' : 'warn'}
            detail={`${taskFailRate}% of tasks failed or were skipped`}
          />
          <Stat
            label="Throughput"
            value={`${usage.tokensPerSecond} tok/s`}
            detail="output tokens while generating"
          />
          <Stat
            label="Compute time"
            value={seconds(usage.computeMs)}
            detail={`${usage.calls} model calls`}
          />
          <Stat
            label="Tokens"
            value={`${compact(usage.tokensIn + usage.tokensOut)}`}
            detail={`${compact(usage.tokensIn)} in · ${compact(usage.tokensOut)} out`}
          />
          <Stat label="Spend" value="£0.00" tone="good" detail="local inference, no metering" />
        </div>

        <p className="caveat">
          Roughly <strong>£{cloudGbp.toFixed(2)}</strong> of equivalent cloud inference avoided —
          an illustration only, priced at ${CLOUD_RATE_PER_MTOK_IN}/${CLOUD_RATE_PER_MTOK_OUT} per
          million input/output tokens at {GBP_PER_USD} USD→GBP. Published rates and model quality
          both differ; this is not a like-for-like comparison.
        </p>
      </Block>

      <Block label="Models — what your hardware actually does">
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Calls</th>
              <th>Avg latency</th>
              <th>Throughput</th>
              <th>Tokens out</th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((model) => (
              <tr key={`${model.provider}/${model.model}`}>
                <td>
                  {model.model}
                  {fastest && model.model === fastest.model && usage.byModel.length > 1 && (
                    <span className="tag tag--free">fastest</span>
                  )}
                </td>
                <td>{model.calls}</td>
                <td>{seconds(model.avgMs)}</td>
                <td>{model.tokensPerSecond} tok/s</td>
                <td>{compact(model.tokensOut)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Measured on this machine, not a published benchmark. Throughput is output tokens per
          second of generation time.
        </p>
      </Block>

      <Block label="Effort — is the extra time worth it?">
        <table className="table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Missions</th>
              <th>Avg mission time</th>
              <th>Avg tokens per call</th>
            </tr>
          </thead>
          <tbody>
            {usage.byEffort.map((row) => (
              <tr key={row.effort}>
                <td>{row.effort}</td>
                <td>{row.missions}</td>
                <td>{row.avgDurationMs ? seconds(row.avgDurationMs) : '—'}</td>
                <td>{row.avgTokensOut || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Compare levels you have actually used. If a higher level costs much more time without
          producing noticeably better recommendations, drop back down.
        </p>
      </Block>

      <Block label="Where mission time goes">
        <ul className="shares">
          {usage.byAgent.map((agent) => (
            <li key={agent.agent}>
              <span className="shares__name">{agent.agent}</span>
              <span className="shares__track">
                <span className="shares__fill" style={{ width: `${agent.shareOfTime}%` }} />
              </span>
              <span className="shares__value">
                {agent.shareOfTime}% · {seconds(agent.avgMs)} avg · {agent.runs} runs
              </span>
            </li>
          ))}
        </ul>
      </Block>

      <Block label="Activity">
        <Bars data={usage.daily} />
        {usage.byProject.length > 0 && (
          <ul className="shares shares--compact">
            {usage.byProject.map((project) => (
              <li key={project.project}>
                <span className="shares__name">{project.project}</span>
                <span className="shares__value">{project.missions} missions</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </>
  );
}
